/**
 * HTTP API routes for lights dashboard
 */

import type { KernelHttpServer } from "../../../../../src/core/http-server.js";
import type { LightsService } from "./service.js";
import { log } from "../../../../../src/core/logger.js";

export function registerLightsRoutes(
  server: KernelHttpServer,
  service: LightsService,
): void {
  // GET /api/dashboard/lights - Dashboard panel data
  server.get("/api/dashboard/lights", async (_req, res) => {
    try {
      const devices = service.listDevices();
      const zones = service.listZones();
      const scenes = service.listScenes();
      const schedules = service.listSchedules();

      // Fetch current state of all devices in parallel
      const statesPromises = devices.map(async (device) => {
        const state = await service.getDeviceState(device.id);
        return { device, state };
      });

      const deviceStates = await Promise.all(statesPromises);

      // Calculate stats
      const onlineCount = deviceStates.filter((ds) => ds.state !== null).length;
      const onCount = deviceStates.filter((ds) => ds.state?.on === true).length;

      // Group by room
      const byRoom: Record<string, typeof deviceStates> = {};
      for (const ds of deviceStates) {
        const room = ds.device.room || "Unassigned";
        if (!byRoom[room]) byRoom[room] = [];
        byRoom[room].push(ds);
      }

      server.json(res, 200, {
        available: true,
        summary: {
          totalDevices: devices.length,
          onlineDevices: onlineCount,
          lightsOn: onCount,
          zones: zones.length,
          scenes: scenes.length,
          schedules: schedules.length,
        },
        devices: deviceStates.map(({ device, state }) => ({
          id: device.id,
          name: device.name,
          type: device.type,
          room: device.room,
          status: device.status,
          numLeds: device.num_leds,
          state: state
            ? {
                on: state.on,
                brightness: Math.round((state.brightness / 255) * 100),
                color: state.color,
                effect: state.effect,
              }
            : null,
        })),
        byRoom,
        zones: zones.map((z) => ({
          id: z.id,
          name: z.name,
          deviceCount: z.device_ids.length,
          devices: z.device_ids.map((id) => service.getDevice(id)?.name ?? id),
        })),
        scenes: scenes.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
        schedules: schedules.map((s) => ({
          id: s.id,
          name: s.name,
          action: s.action,
          time: s.trigger_time,
          days: s.days,
          enabled: s.enabled,
        })),
      });
    } catch (error) {
      log.error(`Lights dashboard error: ${error}`);
      server.json(res, 500, { error: "Failed to fetch lights data" });
    }
  });

  // POST /api/lights/:deviceId/on - Turn on device
  server.post("/api/lights/:deviceId/on", async (req, res) => {
    const deviceId = req.url?.split("/")[3];
    if (!deviceId) {
      server.json(res, 400, { error: "Missing device ID" });
      return;
    }

    const success = await service.turnOn(deviceId);
    server.json(res, success ? 200 : 500, { success });
  });

  // POST /api/lights/:deviceId/off - Turn off device
  server.post("/api/lights/:deviceId/off", async (req, res) => {
    const deviceId = req.url?.split("/")[3];
    if (!deviceId) {
      server.json(res, 400, { error: "Missing device ID" });
      return;
    }

    const success = await service.turnOff(deviceId);
    server.json(res, success ? 200 : 500, { success });
  });

  // POST /api/lights/:deviceId/toggle - Toggle device
  server.post("/api/lights/:deviceId/toggle", async (req, res) => {
    const deviceId = req.url?.split("/")[3];
    if (!deviceId) {
      server.json(res, 400, { error: "Missing device ID" });
      return;
    }

    const success = await service.toggle(deviceId);
    server.json(res, success ? 200 : 500, { success });
  });

  // POST /api/lights/:deviceId/state - Set device state
  server.post("/api/lights/:deviceId/state", async (req, res) => {
    const deviceId = req.url?.split("/")[3];
    if (!deviceId) {
      server.json(res, 400, { error: "Missing device ID" });
      return;
    }

    try {
      const body = await server.parseBody<{
        on?: boolean;
        brightness?: number;
        color?: { r: number; g: number; b: number };
      }>(req);

      // Convert brightness from 0-100 to 0-255
      const state = {
        on: body.on,
        brightness: body.brightness !== undefined 
          ? Math.round((body.brightness / 100) * 255) 
          : undefined,
        color: body.color,
      };

      const success = await service.setState(deviceId, state);
      server.json(res, success ? 200 : 500, { success });
    } catch {
      server.json(res, 400, { error: "Invalid request body" });
    }
  });

  // POST /api/lights/all/on - Turn on all lights
  server.post("/api/lights/all/on", async (_req, res) => {
    const result = await service.turnOnAll();
    server.json(res, 200, result);
  });

  // POST /api/lights/all/off - Turn off all lights
  server.post("/api/lights/all/off", async (_req, res) => {
    const result = await service.turnOffAll();
    server.json(res, 200, result);
  });

  // POST /api/lights/zones/:zoneId/on - Turn on zone
  server.post("/api/lights/zones/:zoneId/on", async (req, res) => {
    const zoneId = req.url?.split("/")[4];
    if (!zoneId) {
      server.json(res, 400, { error: "Missing zone ID" });
      return;
    }

    const result = await service.turnOnZone(zoneId);
    server.json(res, 200, result);
  });

  // POST /api/lights/zones/:zoneId/off - Turn off zone
  server.post("/api/lights/zones/:zoneId/off", async (req, res) => {
    const zoneId = req.url?.split("/")[4];
    if (!zoneId) {
      server.json(res, 400, { error: "Missing zone ID" });
      return;
    }

    const result = await service.turnOffZone(zoneId);
    server.json(res, 200, result);
  });

  // POST /api/lights/scenes/:sceneId/apply - Apply scene
  server.post("/api/lights/scenes/:sceneId/apply", async (req, res) => {
    const sceneId = req.url?.split("/")[4];
    if (!sceneId) {
      server.json(res, 400, { error: "Missing scene ID" });
      return;
    }

    const result = await service.applyScene(sceneId);
    server.json(res, 200, result);
  });

  log.info("Lights API routes registered");
}
