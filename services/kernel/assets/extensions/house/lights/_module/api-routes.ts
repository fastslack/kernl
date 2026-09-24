/**
 * HTTP API routes for lights dashboard
 */

import { HttpError, type KernelHttpServer, log } from "@kernl/extension-sdk";
import type { LightsService } from "./service.js";

export function registerLightsRoutes(
  server: KernelHttpServer,
  service: LightsService,
): void {
  // GET /api/dashboard/lights - Dashboard panel data
  server.route("GET", "/api/dashboard/lights", async () => {
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

      return {
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
      };
    } catch (error) {
      // Deliberately generic: the device error stays in the log.
      log.error(`Lights dashboard error: ${error}`);
      throw new HttpError(500, "Failed to fetch lights data");
    }
  });

  // POST /api/lights/:deviceId/on - Turn on device
  server.route("POST", "/api/lights/:deviceId/on", async ({ params: { deviceId } }) =>
    commandResult(await service.turnOn(deviceId)));

  // POST /api/lights/:deviceId/off - Turn off device
  server.route("POST", "/api/lights/:deviceId/off", async ({ params: { deviceId } }) =>
    commandResult(await service.turnOff(deviceId)));

  // POST /api/lights/:deviceId/toggle - Toggle device
  server.route("POST", "/api/lights/:deviceId/toggle", async ({ params: { deviceId } }) =>
    commandResult(await service.toggle(deviceId)));

  // POST /api/lights/:deviceId/state - Set device state
  server.route<{
    on?: boolean;
    brightness?: number;
    color?: { r: number; g: number; b: number };
  }>("POST", "/api/lights/:deviceId/state", async ({ params: { deviceId }, body }) => {
    let success: boolean;
    try {
      // Convert brightness from 0-100 to 0-255
      const state = {
        on: body.on,
        brightness: body.brightness !== undefined
          ? Math.round((body.brightness / 100) * 255)
          : undefined,
        color: body.color,
      };

      success = await service.setState(deviceId, state);
    } catch {
      throw new HttpError(400, "Invalid request body");
    }
    return commandResult(success);
  });

  // POST /api/lights/all/on - Turn on all lights
  server.route("POST", "/api/lights/all/on", () => service.turnOnAll());

  // POST /api/lights/all/off - Turn off all lights
  server.route("POST", "/api/lights/all/off", () => service.turnOffAll());

  // POST /api/lights/zones/:zoneId/on - Turn on zone
  server.route("POST", "/api/lights/zones/:zoneId/on", ({ params: { zoneId } }) => service.turnOnZone(zoneId));

  // POST /api/lights/zones/:zoneId/off - Turn off zone
  server.route("POST", "/api/lights/zones/:zoneId/off", ({ params: { zoneId } }) => service.turnOffZone(zoneId));

  // POST /api/lights/scenes/:sceneId/apply - Apply scene
  server.route("POST", "/api/lights/scenes/:sceneId/apply", ({ params: { sceneId } }) => service.applyScene(sceneId));

  log.info("Lights API routes registered");
}

/** A device command answers `{ success }`: 200 when it took, 500 when it didn't. */
function commandResult(success: boolean): { success: true } {
  if (!success) throw new HttpError(500, "Light command failed", { success: false });
  return { success: true };
}
