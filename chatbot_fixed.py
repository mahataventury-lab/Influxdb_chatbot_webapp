#!/usr/bin/env python3
"""
AI Chatbot - Complete PLC Version
Uses temperature, pressure, and status from InfluxDB.
"""

import csv
import re
import socket
import sys
from io import StringIO
from urllib.parse import urlparse

import requests
from urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# ================= CONFIG =================
INFLUX_URL = "https://influxdb.tania.vm.service-ventury.de"
INFLUX_TOKEN = "AqSWjv9_OMw8FYnISXVTvF9m8U_k7wcExumgsMGb16T_P8rhcF8SnLiaQSTnVIUCNzNITQzE-D8Up7FdfEzjRQ=="
INFLUX_ORG = "Mahata_Ventury"
INFLUX_BUCKET = "mqtt_data"

OLLAMA_URL = "https://ollama.cloud.service-ventury.de"
OLLAMA_MODEL = "gemma4:e4b"

MEASUREMENT = "plc_measurements"
FIELDS = {"temperature", "pressure", "status"}
OLLAMA_TIMEOUT_SECONDS = 90
OLLAMA_MAX_TOKENS = 180
DEBUG = False


# ================= INFLUX QUERY =================
def query_influxdb_raw(flux_query):
    url = f"{INFLUX_URL}/api/v2/query"
    headers = {
        "Authorization": f"Token {INFLUX_TOKEN}",
        "Content-Type": "application/vnd.flux",
        "Accept": "text/csv",
    }

    try:
        response = requests.post(
            url,
            headers=headers,
            params={"org": INFLUX_ORG},
            data=flux_query,
            timeout=20,
            verify=False,
        )

        if response.status_code == 200:
            return response.text

        print(f"InfluxDB Error: {response.status_code}")
        print(response.text)
        return None

    except Exception as e:
        print(f"Query Error: {e}")
        return None


def can_resolve(hostname):
    try:
        socket.gethostbyname(hostname)
        return True
    except socket.gaierror:
        return False


def host_from_url(url):
    return urlparse(url).hostname or url.replace("https://", "").replace("http://", "").split("/")[0]


# ================= CSV PARSER =================
def parse_sensor_rows(csv_text):
    """Convert Influx CSV rows into timestamp-grouped PLC readings."""
    if not csv_text:
        return []

    rows_by_time = {}
    data_lines = [
        line for line in csv_text.splitlines()
        if line.strip() and not line.startswith("#")
    ]

    if not data_lines:
        return []

    reader = csv.DictReader(StringIO("\n".join(data_lines)))

    for row in reader:
        try:
            field = row.get("_field")
            value = row.get("_value")
            timestamp = row.get("_time")

            if field not in FIELDS or not timestamp:
                continue

            point = rows_by_time.setdefault(timestamp, {"time": timestamp})

            if field in {"temperature", "pressure"}:
                point[field] = float(value)
            else:
                point[field] = value

            if row.get("machineId"):
                point["machineId"] = row["machineId"]
            if row.get("line"):
                point["line"] = row["line"]

        except Exception:
            continue

    rows = sorted(rows_by_time.values(), key=lambda item: item["time"])

    if DEBUG:
        print(f"DEBUG: Extracted {len(rows)} PLC readings")
    if DEBUG and rows:
        print(f"DEBUG SAMPLE: {rows[-3:]}")

    return rows


def numeric_stats(rows, field):
    values = [row[field] for row in rows if isinstance(row.get(field), (int, float))]
    if not values:
        return None

    return {
        "count": len(values),
        "latest": values[-1],
        "max": max(values),
        "min": min(values),
        "avg": sum(values) / len(values),
    }


def percentile(sorted_values, p):
    if not sorted_values:
        return None

    index = (len(sorted_values) - 1) * p
    lower = int(index)
    upper = min(lower + 1, len(sorted_values) - 1)

    if lower == upper:
        return sorted_values[lower]

    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (index - lower)


def iqr_outliers(rows, field):
    values = sorted(row[field] for row in rows if isinstance(row.get(field), (int, float)))

    if len(values) < 4:
        return {
            "count": 0,
            "total": len(values),
            "q1": None,
            "q3": None,
            "iqr": None,
            "lower_fence": None,
            "upper_fence": None,
            "rows": [],
        }

    q1 = percentile(values, 0.25)
    q3 = percentile(values, 0.75)
    iqr = q3 - q1
    lower_fence = q1 - 1.5 * iqr
    upper_fence = q3 + 1.5 * iqr
    outlier_rows = []

    for row in rows:
        value = row.get(field)
        if not isinstance(value, (int, float)):
            continue
        if lower_fence <= value <= upper_fence:
            continue
        outlier_rows.append({
            "time": row.get("time"),
            "value": value,
            "type": "low" if value < lower_fence else "high",
            "machineId": row.get("machineId"),
            "line": row.get("line"),
        })

    return {
        "count": len(outlier_rows),
        "total": len(values),
        "q1": q1,
        "q3": q3,
        "iqr": iqr,
        "lower_fence": lower_fence,
        "upper_fence": upper_fence,
        "rows": outlier_rows,
    }


def status_counts(rows):
    counts = {}

    for row in rows:
        status = row.get("status")
        if status:
            counts[status] = counts.get(status, 0) + 1

    return counts


def row_with_extreme(rows, field, mode):
    values = [row for row in rows if isinstance(row.get(field), (int, float))]
    if not values:
        return None

    if mode == "max":
        return max(values, key=lambda row: row[field])
    return min(values, key=lambda row: row[field])


# ================= DATA FETCH =================
def get_sensor_data():
    """Fetch temperature, pressure, and status from InfluxDB."""
    flux_query = f'''
from(bucket: "{INFLUX_BUCKET}")
|> range(start: -7d)
|> filter(fn: (r) => r._measurement == "{MEASUREMENT}")
|> filter(fn: (r) => r._field == "temperature" or r._field == "pressure" or r._field == "status")
|> keep(columns: ["_time", "_field", "_value", "machineId", "line"])
'''

    csv_data = query_influxdb_raw(flux_query)
    rows = parse_sensor_rows(csv_data)

    if not rows:
        print("WARNING: No PLC sensor data found!")
        return None

    return {
        "total_readings": len(rows),
        "rows": rows,
        "temperature": numeric_stats(rows, "temperature"),
        "pressure": numeric_stats(rows, "pressure"),
        "outliers": {
            "temperature": iqr_outliers(rows, "temperature"),
            "pressure": iqr_outliers(rows, "pressure"),
        },
        "status_counts": status_counts(rows),
        "latest": rows[-1],
        "recent": rows[-10:],
    }


# ================= CONNECTION CHECK =================
def check_http_service(name, url):
    host = host_from_url(url)
    print(f"{name} host: {host}")

    if can_resolve(host):
        print(f"{name} DNS: OK")
    else:
        print(f"{name} DNS: FAILED")
        return False

    try:
        response = requests.get(url, timeout=10, verify=False)
        print(f"{name} HTTP: reachable, status {response.status_code}")
        return True
    except Exception as e:
        print(f"{name} HTTP: FAILED ({e})")
        return False


def run_connection_check():
    print("=== CHATBOT CONNECTION CHECK ===\n")

    influx_reachable = check_http_service("InfluxDB", INFLUX_URL)
    print()
    ollama_reachable = check_http_service("Ollama", OLLAMA_URL)
    print()

    if not influx_reachable:
        print("InfluxDB data check: skipped because InfluxDB is not reachable.")
    else:
        print("InfluxDB data check: querying recent PLC data...")
        data = get_sensor_data()

        if data:
            latest = data["latest"]
            print("InfluxDB data: OK")
            print(f"Readings found: {data['total_readings']}")
            print(f"Latest time: {latest.get('time', 'unknown')}")
            print(f"Latest temperature: {latest.get('temperature', 'unknown')}")
            print(f"Latest pressure: {latest.get('pressure', 'unknown')}")
            print(f"Latest status: {latest.get('status', 'unknown')}")
        else:
            print("InfluxDB data: FAILED or no data found.")

    print()

    if ollama_reachable:
        print("Ollama chatbot check: sending a tiny test prompt...")
        answer = ask_ollama("Reply with only the word connected.", "Connection test.")
        print(f"Ollama response: {answer}")
    else:
        print("Ollama chatbot check: skipped because Ollama is not reachable.")


# ================= CONTEXT =================
def format_numeric_stats(name, unit, stats):
    if not stats:
        return f"No {name} data available.\n"

    title = name.capitalize()
    return (
        f"{title} Records: {stats['count']}\n"
        f"Latest {title}: {stats['latest']:.2f} {unit}\n"
        f"Max {title}: {stats['max']:.2f} {unit}\n"
        f"Min {title}: {stats['min']:.2f} {unit}\n"
        f"Average {title}: {stats['avg']:.2f} {unit}\n"
    )


def build_context(data=None):
    if data is None:
        data = get_sensor_data()
    if not data:
        return "=== PLC SENSOR REPORT ===\n\nNo PLC sensor data available.\n"

    latest = data["latest"]
    status_summary = "none"

    if data["status_counts"]:
        status_summary = ", ".join(
            f"{status}: {count}" for status, count in data["status_counts"].items()
        )

    context = (
        "=== PLC SENSOR REPORT ===\n\n"
        f"Total Timestamped Readings: {data['total_readings']}\n\n"
        f"{format_numeric_stats('temperature', 'C', data['temperature'])}\n"
        f"{format_numeric_stats('pressure', 'bar', data['pressure'])}\n"
        f"Status Counts: {status_summary}\n\n"
        "Latest Reading:\n"
        f"Time: {latest.get('time', 'unknown')}\n"
        f"Machine: {latest.get('machineId', 'unknown')}\n"
        f"Line: {latest.get('line', 'unknown')}\n"
        f"Temperature: {latest.get('temperature', 'unknown')}\n"
        f"Pressure: {latest.get('pressure', 'unknown')}\n"
        f"Status: {latest.get('status', 'unknown')}\n\n"
        "Recent Readings:\n"
    )

    for row in data["recent"]:
        context += (
            f"- {row.get('time', 'unknown')}: "
            f"temperature={row.get('temperature', 'unknown')}, "
            f"pressure={row.get('pressure', 'unknown')}, "
            f"status={row.get('status', 'unknown')}, "
            f"machine={row.get('machineId', 'unknown')}, "
            f"line={row.get('line', 'unknown')}\n"
        )

    return context


def build_ollama_context(data):
    latest = data["latest"]
    temp = data["temperature"]
    pressure = data["pressure"]
    temp_outliers = data["outliers"]["temperature"]
    pressure_outliers = data["outliers"]["pressure"]
    statuses = ", ".join(f"{k}: {v}" for k, v in data["status_counts"].items()) or "none"

    return (
        "PLC data summary:\n"
        f"- readings: {data['total_readings']}\n"
        f"- latest time: {latest.get('time', 'unknown')}\n"
        f"- latest machine: {latest.get('machineId', 'unknown')}, line: {latest.get('line', 'unknown')}\n"
        f"- latest temperature: {latest.get('temperature', 'unknown')} C\n"
        f"- temperature min/avg/max: {temp['min']:.2f}/{temp['avg']:.2f}/{temp['max']:.2f} C\n"
        f"- latest pressure: {latest.get('pressure', 'unknown')} bar\n"
        f"- pressure min/avg/max: {pressure['min']:.2f}/{pressure['avg']:.2f}/{pressure['max']:.2f} bar\n"
        f"- temperature IQR fences: {format_value(temp_outliers['lower_fence'], 'C')} to "
        f"{format_value(temp_outliers['upper_fence'], 'C')}; outliers: {temp_outliers['count']}\n"
        f"- pressure IQR fences: {format_value(pressure_outliers['lower_fence'], 'bar')} to "
        f"{format_value(pressure_outliers['upper_fence'], 'bar')}; outliers: {pressure_outliers['count']}\n"
        f"- latest status: {latest.get('status', 'unknown')}\n"
        f"- status counts: {statuses}\n"
    )


# ================= FAST LOCAL ANSWERS =================
def format_value(value, unit):
    if isinstance(value, (int, float)):
        return f"{value:.2f} {unit}"
    return str(value)


def format_iqr_outliers(name, unit, outlier_info):
    if not outlier_info or outlier_info["total"] < 4:
        return f"Not enough {name} readings for IQR outlier detection. At least 4 numeric readings are needed."

    summary = (
        f"{name.capitalize()} IQR outlier detection: "
        f"Q1={format_value(outlier_info['q1'], unit)}, "
        f"Q3={format_value(outlier_info['q3'], unit)}, "
        f"IQR={format_value(outlier_info['iqr'], unit)}, "
        f"normal range={format_value(outlier_info['lower_fence'], unit)} to "
        f"{format_value(outlier_info['upper_fence'], unit)}."
    )

    if not outlier_info["count"]:
        return f"{summary}\nNo {name} outliers were detected."

    lines = [
        summary,
        f"Detected {outlier_info['count']} {name} outlier"
        f"{'' if outlier_info['count'] == 1 else 's'}:",
    ]
    for row in outlier_info["rows"][-10:]:
        lines.append(f"- {row.get('time', 'unknown')}: {format_value(row['value'], unit)} ({row['type']})")

    return "\n".join(lines)


def format_all_iqr_outliers(data):
    return "\n\n".join((
        format_iqr_outliers("temperature", "C", data["outliers"]["temperature"]),
        format_iqr_outliers("pressure", "bar", data["outliers"]["pressure"]),
    ))


def requested_recent_count(question):
    match = re.search(r"\b(?:last|recent|latest)\s+(\d+)\b", question.lower())
    if not match:
        return None

    count = int(match.group(1))
    return max(1, min(count, 20))


def format_recent_field(rows, field, unit, count):
    values = [row for row in rows if field in row][-count:]
    if not values:
        return f"No recent {field} values are available."

    lines = [f"Last {len(values)} {field} readings:"]
    for row in values:
        lines.append(f"- {row.get('time', 'unknown')}: {format_value(row[field], unit)}")
    return "\n".join(lines)


def build_local_report(data):
    temp = data["temperature"]
    pressure = data["pressure"]
    latest = data["latest"]
    temp_outliers = data["outliers"]["temperature"]
    pressure_outliers = data["outliers"]["pressure"]
    statuses = ", ".join(f"{k}: {v}" for k, v in data["status_counts"].items()) or "none"

    condition = "normal"
    notes = []

    if latest.get("status") and latest["status"].lower() != "running":
        condition = "needs attention"
        notes.append(f"latest status is {latest['status']}")

    if temp and latest.get("temperature") == temp["max"]:
        notes.append("temperature is currently at its highest recorded value")

    if pressure and latest.get("pressure") == pressure["max"]:
        notes.append("pressure is currently at its highest recorded value")

    if temp_outliers["count"] or pressure_outliers["count"]:
        condition = "needs attention"
        notes.append(
            f"IQR outliers detected: temperature {temp_outliers['count']}, "
            f"pressure {pressure_outliers['count']}"
        )

    note_text = "; ".join(notes) if notes else "no immediate warning from the available values"

    return (
        f"PLC condition: {condition}. "
        f"Latest reading at {latest.get('time', 'unknown')}: "
        f"temperature {format_value(latest.get('temperature', 'unknown'), 'C')}, "
        f"pressure {format_value(latest.get('pressure', 'unknown'), 'bar')}, "
        f"status {latest.get('status', 'unknown')}. "
        f"Across {data['total_readings']} readings, temperature avg/max is "
        f"{temp['avg']:.2f}/{temp['max']:.2f} C and pressure avg/max is "
        f"{pressure['avg']:.2f}/{pressure['max']:.2f} bar. "
        f"IQR outliers: temperature {temp_outliers['count']}, pressure {pressure_outliers['count']}. "
        f"Status counts: {statuses}. Note: {note_text}."
    )


def answer_locally(question, data):
    q = question.lower()
    latest = data["latest"]
    recent_count = requested_recent_count(question)

    wants_temperature = "temp" in q or "temperature" in q
    wants_pressure = "pressure" in q
    wants_status = "status" in q or "running" in q or "stopped" in q or "state" in q
    wants_latest = "latest" in q or "current" in q or "now" in q or "last" in q
    wants_high = "highest" in q or "maximum" in q or "max" in q or "high" in q
    wants_low = "lowest" in q or "minimum" in q or "min" in q or "low" in q
    wants_avg = "average" in q or "avg" in q or "mean" in q
    wants_count = "count" in q or "how many" in q or "records" in q or "readings" in q
    wants_outliers = any(word in q for word in ("iqr", "outlier", "outliers", "anomaly", "anomalies"))
    wants_ollama_analysis = (
        "report" in q
        or "condition" in q
        or "health" in q
        or "trend" in q
        or "explain" in q
        or "analyze" in q
        or "analysis" in q
        or "normal" in q
    )
    wants_summary = "summary" in q or "overview" in q or "all" in q

    if wants_outliers:
        if wants_temperature and not wants_pressure:
            return format_iqr_outliers("temperature", "C", data["outliers"]["temperature"])
        if wants_pressure and not wants_temperature:
            return format_iqr_outliers("pressure", "bar", data["outliers"]["pressure"])
        return format_all_iqr_outliers(data)

    if wants_ollama_analysis:
        return None

    if recent_count:
        if wants_temperature:
            return format_recent_field(data["rows"], "temperature", "C", recent_count)
        if wants_pressure:
            return format_recent_field(data["rows"], "pressure", "bar", recent_count)
        if wants_status:
            return format_recent_field(data["rows"], "status", "", recent_count)

        recent = data["rows"][-recent_count:]
        lines = [f"Last {len(recent)} PLC readings:"]
        for row in recent:
            lines.append(
                f"- {row.get('time', 'unknown')}: "
                f"temperature={row.get('temperature', 'unknown')}, "
                f"pressure={row.get('pressure', 'unknown')}, "
                f"status={row.get('status', 'unknown')}"
            )
        return "\n".join(lines)

    if wants_summary:
        return build_local_report(data)

    if wants_count:
        return f"I found {data['total_readings']} timestamped PLC readings."

    if wants_status and not (wants_temperature or wants_pressure):
        statuses = ", ".join(f"{k}: {v}" for k, v in data["status_counts"].items()) or "none"
        return f"The latest status is {latest.get('status', 'unknown')}. Status counts: {statuses}."

    for field, unit in (("temperature", "C"), ("pressure", "bar")):
        if (field == "temperature" and not wants_temperature) or (field == "pressure" and not wants_pressure):
            continue

        stats = data[field]
        if not stats:
            return f"No {field} data is available."

        if wants_high:
            row = row_with_extreme(data["rows"], field, "max")
            return f"The highest {field} is {format_value(row[field], unit)} at {row.get('time', 'unknown')}."

        if wants_low:
            row = row_with_extreme(data["rows"], field, "min")
            return f"The lowest {field} is {format_value(row[field], unit)} at {row.get('time', 'unknown')}."

        if wants_avg:
            return f"The average {field} is {format_value(stats['avg'], unit)} from {stats['count']} readings."

        if wants_latest:
            return f"The latest {field} is {format_value(latest.get(field, 'unknown'), unit)} at {latest.get('time', 'unknown')}."

        return (
            f"{field.capitalize()} latest: {format_value(stats['latest'], unit)}, "
            f"average: {format_value(stats['avg'], unit)}, "
            f"min: {format_value(stats['min'], unit)}, "
            f"max: {format_value(stats['max'], unit)}."
        )

    if wants_latest:
        return (
            f"Latest reading at {latest.get('time', 'unknown')}: "
            f"temperature={latest.get('temperature', 'unknown')}, "
            f"pressure={latest.get('pressure', 'unknown')}, "
            f"status={latest.get('status', 'unknown')}."
        )

    return None


# ================= OLLAMA =================
def ask_ollama(question, context):
    ollama_host = host_from_url(OLLAMA_URL)
    if not can_resolve(ollama_host):
        return (
            f"Cannot resolve {ollama_host}. This is a network/DNS issue in the "
            "Python environment, not a chatbot logic issue."
        )

    url = f"{OLLAMA_URL}/api/generate"

    prompt = f"""
You are a helpful PLC sensor data chatbot.

Use the available PLC data to answer questions about temperature, pressure,
status, latest readings, averages, minimums, maximums, trends, and machine or
line state.
Use IQR outlier detection when the user asks about outliers, anomalies, or
abnormal sensor values.

If the user asks something outside the available PLC data, say what information
is available and answer as helpfully as possible.

{context}

User question: {question}

Answer clearly using the data.
"""

    try:
        response = requests.post(
            url,
            json={
                "model": OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "think": False,
                "options": {
                    "num_predict": OLLAMA_MAX_TOKENS,
                    "temperature": 0.2,
                },
            },
            timeout=OLLAMA_TIMEOUT_SECONDS,
            verify=False,
        )

        if response.status_code == 200:
            return response.json().get("response", "No response")

        return f"Error {response.status_code}: {response.text}"

    except requests.exceptions.ReadTimeout:
        return (
            "Ollama did not respond quickly enough. I can still answer direct PLC "
            "questions like highest temperature, latest pressure, average pressure, "
            "or current status."
        )
    except Exception as e:
        return str(e)


# ================= CHAT =================
def chat():
    print("\nAsk about temperature, pressure, status, latest values, or trends.")
    print("Type 'quit' to exit\n")

    while True:
        q = input("You: ").strip()

        if q.lower() in {"quit", "exit"}:
            break

        if not q:
            continue

        print("Fetching PLC data...")
        data = get_sensor_data()

        if not data:
            print("\nBot: I could not fetch PLC data. Please fix the network/DNS connection first.\n")
            continue

        local_answer = answer_locally(q, data)
        if local_answer:
            print(f"\nBot: {local_answer}\n")
            continue

        print("Thinking...")
        context = build_ollama_context(data)
        answer = ask_ollama(q, context)

        print(f"\nBot: {answer}\n")


# ================= MAIN =================
if __name__ == "__main__":
    if "--check" in sys.argv:
        run_connection_check()
        sys.exit(0)

    print("=== AI PLC CHATBOT ===")
    chat()
