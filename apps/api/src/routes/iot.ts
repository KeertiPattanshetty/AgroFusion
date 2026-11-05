import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errorHandler.js";
import { ok } from "../utils/http.js";

export interface IotTelemetry {
  soilMoisturePct: number;
  temperatureC?: number;
  humidityPct?: number;
  rawAnalogValue?: number;
  deviceId?: string;
  fieldId?: string;
  receivedAt: Date;
}

let latestTelemetry: IotTelemetry | null = null;

export const iotRouter = Router();

// Microcontroller (Arduino / ESP32) / Serial Bridge POST endpoint
iotRouter.post(
  "/telemetry",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        soilMoisturePct: z.number().min(0).max(100),
        temperatureC: z.number().min(-20).max(60).optional(),
        humidityPct: z.number().min(0).max(100).optional(),
        rawAnalogValue: z.number().optional(),
        deviceId: z.string().optional().default("arduino-sensor"),
        fieldId: z.string().optional(),
      })
      .parse(req.body);

    latestTelemetry = {
      ...body,
      receivedAt: new Date(),
    };

    console.log(
      `[IoT Telemetry] Received from ${latestTelemetry.deviceId}: Moisture=${latestTelemetry.soilMoisturePct}%` +
        (latestTelemetry.temperatureC != null ? `, Temp=${latestTelemetry.temperatureC}°C` : "") +
        (latestTelemetry.humidityPct != null ? `, Humidity=${latestTelemetry.humidityPct}%` : ""),
    );

    res.json(
      ok({
        acknowledged: true,
        telemetry: latestTelemetry,
      }),
    );
  }),
);

// Frontend GET endpoint to retrieve the latest Arduino sensor reading
iotRouter.get(
  "/latest",
  asyncHandler(async (_req, res) => {
    const isOnline = latestTelemetry
      ? Date.now() - latestTelemetry.receivedAt.getTime() < 60000 // consider active if updated within 60s
      : false;

    res.json(
      ok({
        available: Boolean(latestTelemetry),
        isOnline,
        telemetry: latestTelemetry,
      }),
    );
  }),
);
