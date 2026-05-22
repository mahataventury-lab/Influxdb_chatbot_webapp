const mqtt = require("mqtt");

// MQTT connection details
const BROKER_URL = "mqtt://broker.emqx.io:1883";
const ALERT_TOPIC = "tania/fakeplc/alerts";

const client = mqtt.connect(BROKER_URL);

client.on("connect", () => {
  console.log("✅ Connected to MQTT broker");

  // Send a test alert every 5 seconds
  let count = 0;
  setInterval(() => {
    count++;
    
    // Alternate between temperature and pressure alerts
    const alerts = [
      {
        type: "TEMPERATURE_HIGH",
        message: "Temperature exceeded threshold: 38.5°C (Max: 35°C)",
        severity: "critical",
        timestamp: new Date().toISOString(),
      },
      {
        type: "PRESSURE_WARNING",
        message: "Pressure approaching limit: 1.95 bar (Max: 2.0 bar)",
        severity: "warning",
        timestamp: new Date().toISOString(),
      },
      {
        type: "TEMPERATURE_NORMAL",
        message: "Temperature returned to normal: 26.3°C",
        severity: "info",
        timestamp: new Date().toISOString(),
      },
    ];

    const alert = alerts[count % alerts.length];
    const message = JSON.stringify(alert);

    client.publish(ALERT_TOPIC, message, { qos: 1 }, (err) => {
      if (err) {
        console.error("❌ Publish failed:", err);
      } else {
        console.log(`✅ Alert #${count} sent:`, alert);
      }
    });
  }, 5000);

  // First alert after 2 seconds
  setTimeout(() => {
    const alert = {
      type: "SYSTEM_READY",
      message: "Alert system initialized and ready",
      severity: "info",
      timestamp: new Date().toISOString(),
    };
    client.publish(ALERT_TOPIC, JSON.stringify(alert), { qos: 1 });
  }, 2000);
});

client.on("error", (err) => {
  console.error("❌ Connection error:", err);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Disconnecting...");
  client.end();
  process.exit(0);
});
