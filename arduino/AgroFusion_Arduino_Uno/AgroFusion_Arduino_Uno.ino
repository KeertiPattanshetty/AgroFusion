/*
 * =====================================================================
 * AgroFusion AI - Arduino Soil Moisture Sensor (USB Serial Mode)
 * =====================================================================
 * Compatible with: Arduino Uno, Nano, Mega, Leonardo
 * 
 * Wiring:
 *   Soil Sensor VCC  --> Arduino 5V
 *   Soil Sensor GND  --> Arduino GND
 *   Soil Sensor A0   --> Arduino Analog Pin A0
 * =====================================================================
 */

const int SENSOR_PIN = A0;

// Calibration values (Adjust based on your sensor readings):
// Raw value in air (completely dry) ~ 1023
// Raw value in cup of water (100% wet) ~ 350
const int AIR_VALUE = 1023;   // 0% moisture
const int WATER_VALUE = 350;  // 100% moisture

void setup() {
  Serial.begin(9600);
  delay(1000);
  Serial.println("{\"status\":\"AgroFusion Soil Sensor Ready\"}");
}

void loop() {
  int rawValue = analogRead(SENSOR_PIN);

  // Map sensor reading to 0% - 100%
  int moisturePct = map(rawValue, AIR_VALUE, WATER_VALUE, 0, 100);
  moisturePct = constrain(moisturePct, 0, 100);

  // Send JSON formatted data through USB Serial
  Serial.print("{\"soilMoisturePct\":");
  Serial.print(moisturePct);
  Serial.print(",\"rawAnalogValue\":");
  Serial.print(rawValue);
  Serial.println("}");

  delay(2000); // Send reading every 2 seconds
}
