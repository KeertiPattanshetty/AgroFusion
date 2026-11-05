/*
 * =====================================================================
 * AgroFusion AI - ESP32 / ESP8266 WiFi Soil Moisture Sensor
 * =====================================================================
 * Sends soil moisture data directly over WiFi to the AgroFusion backend!
 * 
 * Wiring:
 *   Soil Sensor VCC  --> 3.3V
 *   Soil Sensor GND  --> GND
 *   Soil Sensor A0   --> GPIO 34 (or A0 on ESP8266)
 * =====================================================================
 */

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  const int SENSOR_PIN = A0;
#elif defined(ESP32)
  #include <WiFi.h>
  #include <HTTPClient.h>
  const int SENSOR_PIN = 34; // Analog pin ADC1_CH6
#endif

// Replace with your WiFi network credentials:
const char* ssid = "YOUR_WIFI_NAME";
const char* password = "YOUR_WIFI_PASSWORD";

// Replace with your laptop's local IP address (find with 'ipconfig' in command prompt):
const char* serverUrl = "http://192.168.1.100:4000/api/iot/telemetry";

const int AIR_VALUE = 3200;   // ESP32 12-bit ADC in dry air ~ 3200-4095
const int WATER_VALUE = 1200; // ESP32 in water ~ 1000-1500

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.print("Connecting to WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    int rawValue = analogRead(SENSOR_PIN);

    // Map 0% to 100% moisture
    int moisturePct = map(rawValue, AIR_VALUE, WATER_VALUE, 0, 100);
    moisturePct = constrain(moisturePct, 0, 100);

    WiFiClient client;
    HTTPClient http;

    http.begin(client, serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonPayload = "{\"soilMoisturePct\":" + String(moisturePct) + ",\"rawAnalogValue\":" + String(rawValue) + "}";

    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode > 0) {
      Serial.print("Moisture: ");
      Serial.print(moisturePct);
      Serial.print("% | Server Response: ");
      Serial.println(httpResponseCode);
    } else {
      Serial.print("HTTP Error: ");
      Serial.println(httpResponseCode);
    }

    http.end();
  }

  delay(5000); // Send reading every 5 seconds
}
