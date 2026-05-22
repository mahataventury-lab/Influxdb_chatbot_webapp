const https = require('https');
const { URL } = require('url');

const INFLUX_URL = 'https://influxdb.tania.vm.service-ventury.de/api/v2/query?org=Mahata_Ventury';
const TOKEN = 'AqSWjv9_OMw8FYnISXVTvF9m8U_k7wcExumgsMGb16T_P8rhcF8SnLiaQSTnVIUCNzNITQzE-D8Up7FdfEzjRQ==';

const query = `from(bucket:\"mqtt_data\") |> range(start: -1h) |> filter(fn: (r) => r._measurement == \"plc_measurements\" and r._field == \"temperature\") |> limit(n:20)`;

function postFlux(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Token ${TOKEN}`,
        'Content-Type': 'application/vnd.flux',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          const err = new Error(`HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.body = data;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  try {
    const text = await postFlux(INFLUX_URL, query);
    console.log('--- RAW CSV ---');
    console.log(text);

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
    const data = [];
    if (lines.length === 0) {
      console.log('No CSV lines returned');
      return;
    }
    // first non-comment line is header
    const header = lines[0].split(',');
    const timeIdx = header.indexOf('_time');
    const valueIdx = header.indexOf('_value');
    if (timeIdx === -1 || valueIdx === -1) {
      console.log('Could not find _time or _value columns in header:', header);
    } else {
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const time = parts[timeIdx] || 'unknown';
        const rawVal = parts[valueIdx] || '';
        const v = parseFloat(rawVal);
        if (!isNaN(v)) data.push({ time, value: v });
      }
    }

    console.log('\n--- PARSED POINTS ---');
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error querying InfluxDB:', err.message || err);
    if (err.status) {
      console.error('Response status:', err.status);
      console.error('Response body:', err.body);
    }
  }
}

run();
