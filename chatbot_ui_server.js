const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);

const INFLUX_URL = "https://influxdb.tania.vm.service-ventury.de";
const INFLUX_TOKEN = "AqSWjv9_OMw8FYnISXVTvF9m8U_k7wcExumgsMGb16T_P8rhcF8SnLiaQSTnVIUCNzNITQzE-D8Up7FdfEzjRQ==";
const INFLUX_ORG = "Mahata_Ventury";
const INFLUX_BUCKET = "mqtt_data";
const MEASUREMENT = "plc_measurements";

const OLLAMA_URL = "https://ollama.cloud.service-ventury.de";
const OLLAMA_MODEL = "gemma4:e4b";
const OLLAMA_TIMEOUT_MS = 90000;

const PUBLIC_DIR = path.join(__dirname, "public");
const STALE_DATA_MINUTES = 15;

function requestText(urlString, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 20000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function parseSensorRows(csvText) {
  if (!csvText) return [];

  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (!lines.length) return [];

  const header = parseCsvLine(lines[0]);
  const rowsByTime = new Map();

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(header.map((key, index) => [key, values[index] || ""]));
    const field = row._field;
    const time = row._time;

    if (!time || !["temperature", "pressure", "status"].includes(field)) continue;

    const point = rowsByTime.get(time) || { time };
    if (field === "temperature" || field === "pressure") {
      const value = Number(row._value);
      if (!Number.isNaN(value)) point[field] = value;
    } else {
      point.status = row._value;
    }

    if (row.machineId) point.machineId = row.machineId;
    if (row.line) point.line = row.line;
    rowsByTime.set(time, point);
  }

  return Array.from(rowsByTime.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function numericStats(rows, field) {
  const values = rows.map((row) => row[field]).filter((value) => typeof value === "number");
  if (!values.length) return null;
  return {
    count: values.length,
    latest: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function iqrOutliers(rows, field) {
  const values = rows
    .map((row) => row[field])
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);

  if (values.length < 4) {
    return {
      count: 0,
      total: values.length,
      q1: null,
      q3: null,
      iqr: null,
      lowerFence: null,
      upperFence: null,
      rows: [],
    };
  }

  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const outlierRows = rows
    .filter((row) => typeof row[field] === "number" && (row[field] < lowerFence || row[field] > upperFence))
    .map((row) => ({
      time: row.time,
      value: row[field],
      type: row[field] < lowerFence ? "low" : "high",
      machineId: row.machineId,
      line: row.line,
    }));

  return {
    count: outlierRows.length,
    total: values.length,
    q1,
    q3,
    iqr,
    lowerFence,
    upperFence,
    rows: outlierRows,
  };
}

function statusCounts(rows) {
  return rows.reduce((counts, row) => {
    if (row.status) counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
}

function latestValueForField(rows, field) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index][field] !== undefined) return rows[index];
  }
  return null;
}

function latestSnapshot(rows) {
  const latestRow = rows[rows.length - 1];
  const temperatureRow = latestValueForField(rows, "temperature");
  const pressureRow = latestValueForField(rows, "pressure");
  const statusRow = latestValueForField(rows, "status");

  return {
    time: latestRow.time,
    machineId: latestRow.machineId,
    line: latestRow.line,
    temperature: temperatureRow?.temperature,
    temperatureTime: temperatureRow?.time,
    pressure: pressureRow?.pressure,
    pressureTime: pressureRow?.time,
    status: statusRow?.status,
    statusTime: statusRow?.time,
  };
}

async function getSensorData() {
  const flux = `
from(bucket: "${INFLUX_BUCKET}")
|> range(start: -7d)
|> filter(fn: (r) => r._measurement == "${MEASUREMENT}")
|> filter(fn: (r) => r._field == "temperature" or r._field == "pressure" or r._field == "status")
|> keep(columns: ["_time", "_field", "_value", "machineId", "line"])
`;

  const csvText = await requestText(
    `${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${INFLUX_TOKEN}`,
        "Content-Type": "application/vnd.flux",
        Accept: "text/csv",
        "Content-Length": Buffer.byteLength(flux),
      },
    },
    flux
  );

  const rows = parseSensorRows(csvText);
  if (!rows.length) throw new Error("No PLC sensor data found");

  return {
    rows,
    totalReadings: rows.length,
    temperature: numericStats(rows, "temperature"),
    pressure: numericStats(rows, "pressure"),
    outliers: {
      temperature: iqrOutliers(rows, "temperature"),
      pressure: iqrOutliers(rows, "pressure"),
    },
    statusCounts: statusCounts(rows),
    latest: latestSnapshot(rows),
  };
}

function fmt(value, unit = "") {
  if (typeof value === "number") return `${value.toFixed(2)}${unit ? ` ${unit}` : ""}`;
  return String(value ?? "unknown");
}

function fmtTime(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function minutesBetween(start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 60000));
}

function latestDataTimestamp(latest) {
  return [latest.temperatureTime, latest.pressureTime, latest.statusTime, latest.time]
    .filter(Boolean)
    .sort()
    .at(-1);
}

function freshnessInfo(data, refreshedAt) {
  const dataTime = latestDataTimestamp(data.latest);
  const ageMinutes = minutesBetween(dataTime, refreshedAt);
  const isStale = ageMinutes !== null && ageMinutes > STALE_DATA_MINUTES;

  return {
    refreshedAt,
    refreshedAtDisplay: fmtTime(refreshedAt),
    latestDataTime: dataTime,
    latestDataTimeDisplay: fmtTime(dataTime),
    ageMinutes,
    isStale,
    staleAfterMinutes: STALE_DATA_MINUTES,
  };
}

function formatRefreshNote(freshness) {
  const ageText = freshness.ageMinutes === null ? "unknown age" : `${freshness.ageMinutes} min old`;
  const warning = freshness.isStale
    ? ` Warning: newest PLC data is older than ${freshness.staleAfterMinutes} minutes.`
    : "";

  return `Data refreshed from InfluxDB at ${freshness.refreshedAtDisplay}. Newest PLC data: ${freshness.latestDataTimeDisplay} (${ageText}).${warning}`;
}

function formatHealthReport(data, ollamaStatus) {
  const latest = data.latest;
  const freshness = data.freshness;
  const ageText = freshness.ageMinutes === null ? "unknown age" : `${freshness.ageMinutes} min old`;
  const staleText = freshness.isStale ? `stale, older than ${freshness.staleAfterMinutes} min` : "fresh";
  const ollamaText = ollamaStatus.ok ? "reachable" : `not reachable (${ollamaStatus.error})`;

  return [
    "System check:",
    `InfluxDB: reachable`,
    `Ollama: ${ollamaText}`,
    `Latest PLC data: ${freshness.latestDataTimeDisplay} (${ageText}, ${staleText})`,
    `Temperature: ${fmt(latest.temperature, "C")} at ${fmtTime(latest.temperatureTime)}`,
    `Pressure: ${fmt(latest.pressure, "bar")} at ${fmtTime(latest.pressureTime)}`,
    `Status: ${fmt(latest.status)} at ${fmtTime(latest.statusTime)}`,
    `Readings loaded: ${data.totalReadings}`,
  ].join("\n");
}

function extremeRow(rows, field, mode) {
  const withValues = rows.filter((row) => typeof row[field] === "number");
  if (!withValues.length) return null;
  return withValues.reduce((best, row) => {
    if (mode === "max") return row[field] > best[field] ? row : best;
    return row[field] < best[field] ? row : best;
  });
}

function recentCount(question) {
  const match = question.toLowerCase().match(/\b(?:last|recent|latest)\s+(\d+)\b/);
  if (!match) return null;
  return Math.max(1, Math.min(Number(match[1]), 20));
}

function formatRecent(rows, field, unit, count) {
  const values = rows.filter((row) => row[field] !== undefined).slice(-count);
  if (!values.length) return `No recent ${field} values are available.`;
  return [`Last ${values.length} ${field} readings:`]
    .concat(values.map((row) => `- ${fmtTime(row.time)}: ${fmt(row[field], unit)}`))
    .join("\n");
}

function formatIqrOutliers(name, unit, outlierInfo) {
  if (!outlierInfo || outlierInfo.total < 4) {
    return `Not enough ${name} readings for IQR outlier detection. At least 4 numeric readings are needed.`;
  }

  const summary = `${name} IQR outlier detection: Q1=${fmt(outlierInfo.q1, unit)}, Q3=${fmt(outlierInfo.q3, unit)}, IQR=${fmt(outlierInfo.iqr, unit)}, normal range=${fmt(outlierInfo.lowerFence, unit)} to ${fmt(outlierInfo.upperFence, unit)}.`;

  if (!outlierInfo.count) {
    return `${summary}\nNo ${name} outliers were detected.`;
  }

  const details = outlierInfo.rows
    .slice(-10)
    .map((row) => `- ${fmtTime(row.time)}: ${fmt(row.value, unit)} (${row.type})`)
    .join("\n");

  return `${summary}\nDetected ${outlierInfo.count} ${name} outlier${outlierInfo.count === 1 ? "" : "s"}:\n${details}`;
}

function formatAllIqrOutliers(data) {
  return [
    formatIqrOutliers("temperature", "C", data.outliers.temperature),
    formatIqrOutliers("pressure", "bar", data.outliers.pressure),
  ].join("\n\n");
}

function answerLocally(question, data) {
  const q = question.toLowerCase();
  const latest = data.latest;
  const count = recentCount(question);

  const wantsTemperature = q.includes("temp") || q.includes("temperature");
  const wantsPressure = q.includes("pressure");
  const wantsStatus = q.includes("status") || q.includes("running") || q.includes("stopped") || q.includes("state");
  const wantsLatest = q.includes("latest") || q.includes("current") || q.includes("now") || q.includes("last");
  const wantsHigh = q.includes("highest") || q.includes("maximum") || q.includes("max") || q.includes("high");
  const wantsLow = q.includes("lowest") || q.includes("minimum") || q.includes("min") || q.includes("low");
  const wantsAvg = q.includes("average") || q.includes("avg") || q.includes("mean");
  const wantsCount = q.includes("count") || q.includes("how many") || q.includes("records") || q.includes("readings");
  const wantsOutliers = ["iqr", "outlier", "outliers", "anomaly", "anomalies"].some((word) => q.includes(word));
  const wantsAnalysis = ["report", "condition", "health", "trend", "explain", "analyze", "analysis", "normal"].some((word) =>
    q.includes(word)
  );

  if (wantsOutliers) {
    if (wantsTemperature && !wantsPressure) return formatIqrOutliers("temperature", "C", data.outliers.temperature);
    if (wantsPressure && !wantsTemperature) return formatIqrOutliers("pressure", "bar", data.outliers.pressure);
    return formatAllIqrOutliers(data);
  }

  if (wantsAnalysis) return null;

  if (count) {
    if (wantsTemperature) return formatRecent(data.rows, "temperature", "C", count);
    if (wantsPressure) return formatRecent(data.rows, "pressure", "bar", count);
    if (wantsStatus) return formatRecent(data.rows, "status", "", count);
    return data.rows
      .slice(-count)
      .map((row) => `${fmtTime(row.time)}: temperature=${fmt(row.temperature)}, pressure=${fmt(row.pressure)}, status=${fmt(row.status)}`)
      .join("\n");
  }

  if (wantsCount) return `I found ${data.totalReadings} timestamped PLC readings.`;

  if (wantsStatus && !wantsTemperature && !wantsPressure) {
    const statuses = Object.entries(data.statusCounts).map(([key, value]) => `${key}: ${value}`).join(", ") || "none";
    return `The latest status is ${fmt(latest.status)}. Status counts: ${statuses}.`;
  }

  for (const [field, unit] of [
    ["temperature", "C"],
    ["pressure", "bar"],
  ]) {
    if ((field === "temperature" && !wantsTemperature) || (field === "pressure" && !wantsPressure)) continue;
    const stats = data[field];
    if (!stats) return `No ${field} data is available.`;
    if (wantsHigh) {
      const row = extremeRow(data.rows, field, "max");
      return `The highest ${field} is ${fmt(row[field], unit)} at ${fmtTime(row.time)}.`;
    }
    if (wantsLow) {
      const row = extremeRow(data.rows, field, "min");
      return `The lowest ${field} is ${fmt(row[field], unit)} at ${fmtTime(row.time)}.`;
    }
    if (wantsAvg) return `The average ${field} is ${fmt(stats.avg, unit)} from ${stats.count} readings.`;
    if (wantsLatest) return `The latest ${field} is ${fmt(latest[field], unit)} at ${fmtTime(latest[`${field}Time`] || latest.time)}.`;
    return `${field}: latest ${fmt(stats.latest, unit)}, average ${fmt(stats.avg, unit)}, min ${fmt(stats.min, unit)}, max ${fmt(stats.max, unit)}.`;
  }

  if (wantsLatest) {
    return `Latest known values: temperature=${fmt(latest.temperature, "C")} at ${fmtTime(latest.temperatureTime)}, pressure=${fmt(latest.pressure, "bar")} at ${fmtTime(latest.pressureTime)}, status=${fmt(latest.status)} at ${fmtTime(latest.statusTime)}.`;
  }

  return null;
}

function buildOllamaContext(data) {
  const latest = data.latest;
  const statuses = Object.entries(data.statusCounts).map(([key, value]) => `${key}: ${value}`).join(", ") || "none";
  const temperatureOutliers = data.outliers.temperature;
  const pressureOutliers = data.outliers.pressure;
  const freshness = data.freshness;
  return [
    "PLC data summary:",
    `- data refreshed from InfluxDB at: ${freshness.refreshedAtDisplay} Europe/Berlin`,
    `- newest PLC data time: ${freshness.latestDataTimeDisplay} Europe/Berlin (${freshness.ageMinutes ?? "unknown"} min old)`,
    `- stale data warning: ${freshness.isStale ? `yes, older than ${freshness.staleAfterMinutes} minutes` : "no"}`,
    `- readings: ${data.totalReadings}`,
    `- latest time: ${fmtTime(latest.time)} Europe/Berlin`,
    `- latest machine: ${fmt(latest.machineId)}, line: ${fmt(latest.line)}`,
    `- latest temperature: ${fmt(latest.temperature, "C")} at ${fmtTime(latest.temperatureTime)} Europe/Berlin`,
    `- temperature min/avg/max: ${fmt(data.temperature.min, "C")}/${fmt(data.temperature.avg, "C")}/${fmt(data.temperature.max, "C")}`,
    `- latest pressure: ${fmt(latest.pressure, "bar")} at ${fmtTime(latest.pressureTime)} Europe/Berlin`,
    `- pressure min/avg/max: ${fmt(data.pressure.min, "bar")}/${fmt(data.pressure.avg, "bar")}/${fmt(data.pressure.max, "bar")}`,
    `- temperature IQR fences: ${fmt(temperatureOutliers.lowerFence, "C")} to ${fmt(temperatureOutliers.upperFence, "C")}; outliers: ${temperatureOutliers.count}`,
    `- pressure IQR fences: ${fmt(pressureOutliers.lowerFence, "bar")} to ${fmt(pressureOutliers.upperFence, "bar")}; outliers: ${pressureOutliers.count}`,
    `- latest status: ${fmt(latest.status)} at ${fmtTime(latest.statusTime)} Europe/Berlin`,
    `- status counts: ${statuses}`,
  ].join("\n");
}

async function askOllama(question, context) {
  const prompt = `You are a helpful PLC sensor data chatbot.

Use the available PLC data to answer questions about temperature, pressure, status, latest readings, averages, minimums, maximums, trends, and machine or line state.
Use IQR outlier detection when the user asks about outliers, anomalies, or abnormal sensor values.
Keep the answer concise and practical.

${context}

User question: ${question}

Answer clearly using the data.`;

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    think: false,
    options: {
      num_predict: 180,
      temperature: 0.2,
    },
  });

  const response = await requestText(
    `${OLLAMA_URL}/api/generate`,
    {
      method: "POST",
      timeout: OLLAMA_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  return JSON.parse(response).response || "No response from Ollama.";
}

async function checkOllama() {
  try {
    await requestText(`${OLLAMA_URL}/api/tags`, { timeout: 10000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function handleChat(req, res) {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    try {
      const { message } = JSON.parse(raw || "{}");
      if (!message || !message.trim()) {
        sendJson(res, 400, { error: "Message is required" });
        return;
      }

      const data = await getSensorData();
      data.freshness = freshnessInfo(data, new Date().toISOString());
      const localAnswer = answerLocally(message, data);
      const answerBody = localAnswer || (await askOllama(message, buildOllamaContext(data)));
      const answer = `${answerBody}\n\n${formatRefreshNote(data.freshness)}`;

      sendJson(res, 200, {
        answer,
        source: localAnswer ? "fast-data" : "ollama",
        latest: data.latest,
        freshness: data.freshness,
        totalReadings: data.totalReadings,
        outliers: data.outliers,
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });
}

async function handleHealth(req, res) {
  try {
    const data = await getSensorData();
    data.freshness = freshnessInfo(data, new Date().toISOString());
    const ollamaStatus = await checkOllama();
    const answer = `${formatHealthReport(data, ollamaStatus)}\n\n${formatRefreshNote(data.freshness)}`;

    sendJson(res, 200, {
      answer,
      source: "system-check",
      latest: data.latest,
      freshness: data.freshness,
      totalReadings: data.totalReadings,
      ollama: ollamaStatus,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: `System check failed: ${error.message || String(error)}`,
    });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "application/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    handleHealth(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`PLC chatbot UI is running at http://localhost:${PORT}`);
});
