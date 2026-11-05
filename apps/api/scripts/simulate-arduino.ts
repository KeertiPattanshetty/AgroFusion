// Simulates live Arduino soil moisture sensor output sending to AgroFusion every 3 seconds
const API = "http://localhost:4000/api/iot/telemetry";

async function simulate() {
  console.log("==================================================");
  console.log("🌱 AGROFUSION - ARDUINO SOIL MOISTURE SIMULATOR");
  console.log("==================================================");
  console.log("Broadcasting live sensor telemetry to AgroFusion API...\n");

  let moisture = 42.0;

  setInterval(async () => {
    // Realistic fluctuation between 25% and 75%
    const delta = (Math.random() * 3 - 1.5);
    moisture = Math.max(15, Math.min(85, Math.round((moisture + delta) * 10) / 10));

    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soilMoisturePct: moisture,
          temperatureC: 28.5,
          humidityPct: 62.0,
          deviceId: "arduino-soil-sensor-1",
        }),
      });

      if (res.ok) {
        console.log(`[Arduino Pin A0] Soil Moisture: ${moisture}% | Sent to AgroFusion ✓`);
      }
    } catch (err: any) {
      console.error("Error communicating with AgroFusion backend:", err.message);
    }
  }, 3000);
}

simulate();
