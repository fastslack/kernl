/**
 * MCP Tools for lights module
 */

import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { LightsService } from "./service.js";
import { textResult, errorResult } from "../../../../../src/core/helpers.js";
import { PRESET_COLORS } from "./types.js";

export function lightsTools(service: LightsService): ToolDefinition[] {
  return [
    // ─────────────────────────────────────────────────────────────────
    // Device Management
    // ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_lights_add_device",
      description:
        "Register a new LED controller device (ESP32 with WLED, Tasmota, etc.)",
      inputSchema: z.object({
        name: z.string().describe("Friendly name for the device (e.g., 'Living Room Strip')"),
        ip_address: z.string().describe("IP address of the device (e.g., '192.168.1.50')"),
        type: z
          .enum(["wled", "tasmota", "custom", "hue"])
          .default("wled")
          .describe("Controller type"),
        port: z.number().default(80).describe("HTTP port"),
        room: z.string().optional().describe("Room location (e.g., 'living_room')"),
        num_leds: z.number().optional().describe("Number of LEDs in the strip"),
      }),
      handler: async (args) => {
        const input = args as {
          name: string;
          ip_address: string;
          type?: "wled" | "tasmota" | "custom" | "hue";
          port?: number;
          room?: string;
          num_leds?: number;
        };

        const device = service.addDevice(input);
        return textResult(
          `Device registered:\n` +
            `  ID: ${device.id}\n` +
            `  Name: ${device.name}\n` +
            `  Type: ${device.type}\n` +
            `  IP: ${device.ip_address}:${device.port}\n` +
            `  Room: ${device.room || "(none)"}\n` +
            `  LEDs: ${device.num_leds}`,
        );
      },
    },

    {
      name: "kernel_lights_list_devices",
      description: "List all registered LED devices",
      inputSchema: z.object({
        room: z.string().optional().describe("Filter by room"),
      }),
      handler: async (args) => {
        const filters = args as { room?: string };
        const devices = service.listDevices(filters);

        if (devices.length === 0) {
          return textResult("No devices registered.");
        }

        const lines = devices.map(
          (d) =>
            `- **${d.name}** (${d.type})\n` +
            `  ID: ${d.id}\n` +
            `  IP: ${d.ip_address}:${d.port}\n` +
            `  Room: ${d.room || "-"} | LEDs: ${d.num_leds} | Status: ${d.status}`,
        );

        return textResult(`## LED Devices (${devices.length})\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_lights_update_device",
      description: "Update a device's configuration",
      inputSchema: z.object({
        device: z.string().describe("Device ID or name"),
        name: z.string().optional().describe("New name"),
        ip_address: z.string().optional().describe("New IP address"),
        port: z.number().optional().describe("New port"),
        room: z.string().optional().describe("New room"),
        num_leds: z.number().optional().describe("New LED count"),
      }),
      handler: async (args) => {
        const { device: deviceIdOrName, ...changes } = args as {
          device: string;
          name?: string;
          ip_address?: string;
          port?: number;
          room?: string;
          num_leds?: number;
        };

        const resolved = service.resolveDevice(deviceIdOrName);
        if (!resolved) {
          return errorResult(`Device not found: ${deviceIdOrName}`);
        }

        const updated = service.updateDevice(resolved.id, changes);
        if (!updated) {
          return errorResult("Failed to update device");
        }

        return textResult(`Device updated: ${updated.name} (${updated.id})`);
      },
    },

    {
      name: "kernel_lights_delete_device",
      description: "Remove a device from the system",
      inputSchema: z.object({
        device: z.string().describe("Device ID or name"),
      }),
      handler: async (args) => {
        const { device: deviceIdOrName } = args as { device: string };

        const resolved = service.resolveDevice(deviceIdOrName);
        if (!resolved) {
          return errorResult(`Device not found: ${deviceIdOrName}`);
        }

        const deleted = service.deleteDevice(resolved.id);
        return deleted
          ? textResult(`Device deleted: ${resolved.name}`)
          : errorResult("Failed to delete device");
      },
    },

    // ─────────────────────────────────────────────────────────────────
    // Light Control
    // ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_lights_on",
      description: "Turn on lights. Can target a specific device, zone, or all lights.",
      inputSchema: z.object({
        device: z.string().optional().describe("Device ID or name"),
        zone: z.string().optional().describe("Zone ID or name"),
        all: z.boolean().optional().describe("Turn on all lights"),
      }),
      handler: async (args) => {
        const { device, zone, all } = args as {
          device?: string;
          zone?: string;
          all?: boolean;
        };

        if (all) {
          const result = await service.turnOnAll();
          return textResult(
            `All lights: ${result.success} turned on, ${result.failed} failed`,
          );
        }

        if (zone) {
          const resolved = service.resolveZone(zone);
          if (!resolved) return errorResult(`Zone not found: ${zone}`);

          const result = await service.turnOnZone(resolved.id);
          return textResult(
            `Zone "${resolved.name}": ${result.success} turned on, ${result.failed} failed`,
          );
        }

        if (device) {
          const resolved = service.resolveDevice(device);
          if (!resolved) return errorResult(`Device not found: ${device}`);

          const success = await service.turnOn(resolved.id);
          return success
            ? textResult(`${resolved.name} turned on`)
            : errorResult(`Failed to turn on ${resolved.name}`);
        }

        return errorResult("Specify device, zone, or use all:true");
      },
    },

    {
      name: "kernel_lights_off",
      description: "Turn off lights. Can target a specific device, zone, or all lights.",
      inputSchema: z.object({
        device: z.string().optional().describe("Device ID or name"),
        zone: z.string().optional().describe("Zone ID or name"),
        all: z.boolean().optional().describe("Turn off all lights"),
      }),
      handler: async (args) => {
        const { device, zone, all } = args as {
          device?: string;
          zone?: string;
          all?: boolean;
        };

        if (all) {
          const result = await service.turnOffAll();
          return textResult(
            `All lights: ${result.success} turned off, ${result.failed} failed`,
          );
        }

        if (zone) {
          const resolved = service.resolveZone(zone);
          if (!resolved) return errorResult(`Zone not found: ${zone}`);

          const result = await service.turnOffZone(resolved.id);
          return textResult(
            `Zone "${resolved.name}": ${result.success} turned off, ${result.failed} failed`,
          );
        }

        if (device) {
          const resolved = service.resolveDevice(device);
          if (!resolved) return errorResult(`Device not found: ${device}`);

          const success = await service.turnOff(resolved.id);
          return success
            ? textResult(`${resolved.name} turned off`)
            : errorResult(`Failed to turn off ${resolved.name}`);
        }

        return errorResult("Specify device, zone, or use all:true");
      },
    },

    {
      name: "kernel_lights_toggle",
      description: "Toggle a light on/off",
      inputSchema: z.object({
        device: z.string().describe("Device ID or name"),
      }),
      handler: async (args) => {
        const { device } = args as { device: string };

        const resolved = service.resolveDevice(device);
        if (!resolved) return errorResult(`Device not found: ${device}`);

        const success = await service.toggle(resolved.id);
        return success
          ? textResult(`${resolved.name} toggled`)
          : errorResult(`Failed to toggle ${resolved.name}`);
      },
    },

    {
      name: "kernel_lights_brightness",
      description: "Set brightness level (0-100%)",
      inputSchema: z.object({
        device: z.string().optional().describe("Device ID or name"),
        zone: z.string().optional().describe("Zone ID or name"),
        brightness: z.number().min(0).max(100).describe("Brightness percentage (0-100)"),
      }),
      handler: async (args) => {
        const { device, zone, brightness } = args as {
          device?: string;
          zone?: string;
          brightness: number;
        };

        const bri255 = Math.round((brightness / 100) * 255);

        if (zone) {
          const resolved = service.resolveZone(zone);
          if (!resolved) return errorResult(`Zone not found: ${zone}`);

          const result = await service.setZoneBrightness(resolved.id, bri255);
          return textResult(
            `Zone "${resolved.name}": brightness set to ${brightness}% (${result.success} devices)`,
          );
        }

        if (device) {
          const resolved = service.resolveDevice(device);
          if (!resolved) return errorResult(`Device not found: ${device}`);

          const success = await service.setBrightness(resolved.id, bri255);
          return success
            ? textResult(`${resolved.name} brightness: ${brightness}%`)
            : errorResult(`Failed to set brightness on ${resolved.name}`);
        }

        return errorResult("Specify device or zone");
      },
    },

    {
      name: "kernel_lights_color",
      description: `Set light color. Accepts RGB values, hex codes, or preset names: ${Object.keys(PRESET_COLORS).join(", ")}`,
      inputSchema: z.object({
        device: z.string().optional().describe("Device ID or name"),
        zone: z.string().optional().describe("Zone ID or name"),
        color: z
          .string()
          .describe("Color: preset name, RGB (255,0,0), or hex (#FF0000)"),
      }),
      handler: async (args) => {
        const { device, zone, color } = args as {
          device?: string;
          zone?: string;
          color: string;
        };

        const rgb = service.parseColor(color);
        if (!rgb) {
          return errorResult(
            `Invalid color: ${color}. Use preset name, RGB (255,0,0), or hex (#FF0000)`,
          );
        }

        if (zone) {
          const resolved = service.resolveZone(zone);
          if (!resolved) return errorResult(`Zone not found: ${zone}`);

          const result = await service.setZoneColor(resolved.id, rgb);
          return textResult(
            `Zone "${resolved.name}": color set (${result.success} devices)`,
          );
        }

        if (device) {
          const resolved = service.resolveDevice(device);
          if (!resolved) return errorResult(`Device not found: ${device}`);

          const success = await service.setColor(resolved.id, rgb);
          return success
            ? textResult(`${resolved.name} color: RGB(${rgb.r},${rgb.g},${rgb.b})`)
            : errorResult(`Failed to set color on ${resolved.name}`);
        }

        return errorResult("Specify device or zone");
      },
    },

    {
      name: "kernel_lights_effect",
      description: "Set a WLED effect on a device",
      inputSchema: z.object({
        device: z.string().describe("Device ID or name"),
        effect: z.number().describe("Effect ID (0-117, depends on WLED version)"),
        speed: z.number().min(0).max(255).optional().describe("Effect speed (0-255)"),
      }),
      handler: async (args) => {
        const { device, effect, speed } = args as {
          device: string;
          effect: number;
          speed?: number;
        };

        const resolved = service.resolveDevice(device);
        if (!resolved) return errorResult(`Device not found: ${device}`);

        const success = await service.setEffect(resolved.id, effect, speed);
        return success
          ? textResult(`${resolved.name} effect: ${effect}`)
          : errorResult(`Failed to set effect on ${resolved.name}`);
      },
    },

    {
      name: "kernel_lights_status",
      description: "Get current status of all lights or a specific device",
      inputSchema: z.object({
        device: z.string().optional().describe("Device ID or name (omit for all)"),
      }),
      handler: async (args) => {
        const { device } = args as { device?: string };

        if (device) {
          const resolved = service.resolveDevice(device);
          if (!resolved) return errorResult(`Device not found: ${device}`);

          const state = await service.getDeviceState(resolved.id);
          if (!state) {
            return textResult(`**${resolved.name}** — offline or unreachable`);
          }

          return textResult(
            `**${resolved.name}** (${resolved.type})\n` +
              `  Power: ${state.on ? "ON" : "OFF"}\n` +
              `  Brightness: ${Math.round((state.brightness / 255) * 100)}%\n` +
              `  Color: RGB(${state.color.r},${state.color.g},${state.color.b})\n` +
              `  Effect: ${state.effect}`,
          );
        }

        // Get all states
        const allStates = await service.getAllStates();
        const lines = allStates.map(({ device: d, state }) => {
          if (!state) {
            return `- **${d.name}** — offline`;
          }
          const pct = Math.round((state.brightness / 255) * 100);
          return (
            `- **${d.name}** — ${state.on ? "ON" : "OFF"} ` +
            `(${pct}%, RGB ${state.color.r},${state.color.g},${state.color.b})`
          );
        });

        return textResult(`## Light Status\n\n${lines.join("\n")}`);
      },
    },

    // ─────────────────────────────────────────────────────────────────
    // Zones
    // ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_lights_add_zone",
      description: "Create a zone (group of devices)",
      inputSchema: z.object({
        name: z.string().describe("Zone name (e.g., 'Downstairs')"),
        devices: z.array(z.string()).describe("List of device IDs or names"),
      }),
      handler: async (args) => {
        const { name, devices } = args as { name: string; devices: string[] };

        // Resolve all device IDs
        const deviceIds: string[] = [];
        for (const d of devices) {
          const resolved = service.resolveDevice(d);
          if (!resolved) {
            return errorResult(`Device not found: ${d}`);
          }
          deviceIds.push(resolved.id);
        }

        const zone = service.addZone({ name, device_ids: deviceIds });
        return textResult(
          `Zone created:\n` +
            `  ID: ${zone.id}\n` +
            `  Name: ${zone.name}\n` +
            `  Devices: ${deviceIds.length}`,
        );
      },
    },

    {
      name: "kernel_lights_list_zones",
      description: "List all zones",
      inputSchema: z.object({}),
      handler: async () => {
        const zones = service.listZones();

        if (zones.length === 0) {
          return textResult("No zones configured.");
        }

        const lines = zones.map((z) => {
          const deviceNames = z.device_ids
            .map((id) => service.getDevice(id)?.name ?? id)
            .join(", ");
          return `- **${z.name}** (${z.device_ids.length} devices)\n  ${deviceNames}`;
        });

        return textResult(`## Zones\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_lights_delete_zone",
      description: "Delete a zone",
      inputSchema: z.object({
        zone: z.string().describe("Zone ID or name"),
      }),
      handler: async (args) => {
        const { zone } = args as { zone: string };

        const resolved = service.resolveZone(zone);
        if (!resolved) return errorResult(`Zone not found: ${zone}`);

        const deleted = service.deleteZone(resolved.id);
        return deleted
          ? textResult(`Zone deleted: ${resolved.name}`)
          : errorResult("Failed to delete zone");
      },
    },

    // ─────────────────────────────────────────────────────────────────
    // Scenes
    // ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_lights_scene",
      description: "Apply a predefined scene to all lights",
      inputSchema: z.object({
        scene: z.string().describe("Scene ID or name (e.g., 'relax', 'movie', 'focus')"),
      }),
      handler: async (args) => {
        const { scene } = args as { scene: string };

        const resolved = service.resolveScene(scene);
        if (!resolved) {
          const scenes = service.listScenes();
          const names = scenes.map((s) => s.name).join(", ");
          return errorResult(`Scene not found: ${scene}. Available: ${names}`);
        }

        const result = await service.applyScene(resolved.id);
        return textResult(
          `Scene "${resolved.name}" applied: ${result.success} devices, ${result.failed} failed`,
        );
      },
    },

    {
      name: "kernel_lights_list_scenes",
      description: "List all available scenes",
      inputSchema: z.object({}),
      handler: async () => {
        const scenes = service.listScenes();

        const lines = scenes.map((s) => `- **${s.name}** — ${s.description || "(no description)"}`);

        return textResult(`## Scenes\n\n${lines.join("\n")}`);
      },
    },

    {
      name: "kernel_lights_add_scene",
      description: "Create a custom scene",
      inputSchema: z.object({
        name: z.string().describe("Scene name"),
        description: z.string().optional().describe("Scene description"),
        brightness: z.number().min(0).max(100).optional().describe("Default brightness %"),
        color: z.string().optional().describe("Default color"),
        on: z.boolean().optional().describe("Lights on/off"),
      }),
      handler: async (args) => {
        const { name, description, brightness, color, on } = args as {
          name: string;
          description?: string;
          brightness?: number;
          color?: string;
          on?: boolean;
        };

        const state: Record<string, unknown> = {};
        if (on !== undefined) state.on = on;
        if (brightness !== undefined) state.brightness = Math.round((brightness / 100) * 255);
        if (color) {
          const rgb = service.parseColor(color);
          if (rgb) state.color = rgb;
        }

        const scene = service.addScene({
          name,
          description,
          config: { devices: { "*": state } },
        });

        return textResult(`Scene created: ${scene.name} (${scene.id})`);
      },
    },

    // ─────────────────────────────────────────────────────────────────
    // Schedules
    // ─────────────────────────────────────────────────────────────────
    {
      name: "kernel_lights_add_schedule",
      description: "Create an automated schedule",
      inputSchema: z.object({
        name: z.string().describe("Schedule name"),
        device: z.string().optional().describe("Device ID or name"),
        zone: z.string().optional().describe("Zone ID or name"),
        scene: z.string().optional().describe("Scene to apply (for action=scene)"),
        action: z.enum(["on", "off", "scene"]).describe("Action to perform"),
        time: z.string().describe("Trigger time in HH:MM format"),
        days: z
          .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
          .describe("Days of the week"),
        brightness: z.number().optional().describe("Brightness % (for action=on)"),
        color: z.string().optional().describe("Color (for action=on)"),
      }),
      handler: async (args) => {
        const input = args as {
          name: string;
          device?: string;
          zone?: string;
          scene?: string;
          action: "on" | "off" | "scene";
          time: string;
          days: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
          brightness?: number;
          color?: string;
        };

        let deviceId: string | undefined;
        let zoneId: string | undefined;
        let sceneId: string | undefined;

        if (input.device) {
          const resolved = service.resolveDevice(input.device);
          if (!resolved) return errorResult(`Device not found: ${input.device}`);
          deviceId = resolved.id;
        }

        if (input.zone) {
          const resolved = service.resolveZone(input.zone);
          if (!resolved) return errorResult(`Zone not found: ${input.zone}`);
          zoneId = resolved.id;
        }

        if (input.scene) {
          const resolved = service.resolveScene(input.scene);
          if (!resolved) return errorResult(`Scene not found: ${input.scene}`);
          sceneId = resolved.id;
        }

        const schedule = service.addSchedule({
          name: input.name,
          device_id: deviceId,
          zone_id: zoneId,
          scene_id: sceneId,
          action: input.action,
          trigger_time: input.time,
          days: input.days,
          brightness: input.brightness ? Math.round((input.brightness / 100) * 255) : undefined,
          color: input.color ? service.parseColor(input.color) ?? undefined : undefined,
        });

        return textResult(
          `Schedule created:\n` +
            `  ID: ${schedule.id}\n` +
            `  Name: ${schedule.name}\n` +
            `  Time: ${schedule.trigger_time}\n` +
            `  Days: ${schedule.days.join(", ")}`,
        );
      },
    },

    {
      name: "kernel_lights_list_schedules",
      description: "List all schedules",
      inputSchema: z.object({}),
      handler: async () => {
        const schedules = service.listSchedules();

        if (schedules.length === 0) {
          return textResult("No schedules configured.");
        }

        const lines = schedules.map((s) => {
          const target = s.device_id
            ? service.getDevice(s.device_id)?.name ?? s.device_id
            : s.zone_id
              ? service.getZone(s.zone_id)?.name ?? s.zone_id
              : "all";

          return (
            `- **${s.name}** ${s.enabled ? "" : "(disabled)"}\n` +
            `  ${s.trigger_time} on ${s.days.join(", ")}\n` +
            `  Action: ${s.action} → ${target}`
          );
        });

        return textResult(`## Schedules\n\n${lines.join("\n\n")}`);
      },
    },

    {
      name: "kernel_lights_toggle_schedule",
      description: "Enable or disable a schedule",
      inputSchema: z.object({
        id: z.string().describe("Schedule ID"),
        enabled: z.boolean().describe("Enable (true) or disable (false)"),
      }),
      handler: async (args) => {
        const { id, enabled } = args as { id: string; enabled: boolean };

        const success = service.toggleSchedule(id, enabled);
        return success
          ? textResult(`Schedule ${enabled ? "enabled" : "disabled"}`)
          : errorResult("Schedule not found");
      },
    },

    {
      name: "kernel_lights_delete_schedule",
      description: "Delete a schedule",
      inputSchema: z.object({
        id: z.string().describe("Schedule ID"),
      }),
      handler: async (args) => {
        const { id } = args as { id: string };

        const success = service.deleteSchedule(id);
        return success ? textResult("Schedule deleted") : errorResult("Schedule not found");
      },
    },
  ];
}
