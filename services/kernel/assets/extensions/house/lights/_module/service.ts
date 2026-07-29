/**
 * LightsService - Control LED devices via HTTP API
 * Supports WLED (primary), Tasmota, and custom controllers
 */

import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { newId, isoNow } from "../../../../../src/core/helpers.js";
import { log } from "../../../../../src/core/logger.js";
import type {
  LightDevice,
  LightState,
  LightScene,
  LightZone,
  LightSchedule,
  CreateDeviceInput,
  UpdateDeviceInput,
  CreateSceneInput,
  CreateZoneInput,
  CreateScheduleInput,
  RgbColor,
  SceneConfig,
  WledState,
  WledInfo,
  DayOfWeek,
  DeviceStatus,
} from "./types.js";
import { PRESET_COLORS } from "./types.js";

// Timeout for HTTP requests to devices
const DEVICE_TIMEOUT_MS = 3000;

export class LightsService {
  constructor(private db: SqliteDb) {}

  // ─────────────────────────────────────────────────────────────────
  // Device CRUD
  // ─────────────────────────────────────────────────────────────────

  addDevice(input: CreateDeviceInput): LightDevice {
    const now = isoNow();
    const device: LightDevice = {
      id: newId(),
      name: input.name,
      type: input.type ?? "wled",
      ip_address: input.ip_address,
      port: input.port ?? 80,
      room: input.room ?? "",
      num_leds: input.num_leds ?? 30,
      status: "unknown",
      last_seen: null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO lights_devices 
         (id, name, type, ip_address, port, room, num_leds, status, last_seen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.id,
        device.name,
        device.type,
        device.ip_address,
        device.port,
        device.room,
        device.num_leds,
        device.status,
        device.last_seen,
        device.created_at,
        device.updated_at,
      );

    return device;
  }

  getDevice(id: string): LightDevice | undefined {
    return this.db
      .prepare("SELECT * FROM lights_devices WHERE id = ?")
      .get(id) as LightDevice | undefined;
  }

  getDeviceByName(name: string): LightDevice | undefined {
    return this.db
      .prepare("SELECT * FROM lights_devices WHERE LOWER(name) = LOWER(?)")
      .get(name) as LightDevice | undefined;
  }

  listDevices(filters?: { room?: string; status?: DeviceStatus }): LightDevice[] {
    let sql = "SELECT * FROM lights_devices WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.room) {
      sql += " AND LOWER(room) = LOWER(?)";
      params.push(filters.room);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    sql += " ORDER BY room, name";
    return this.db.prepare(sql).all(...params) as LightDevice[];
  }

  updateDevice(id: string, changes: UpdateDeviceInput): LightDevice | undefined {
    const existing = this.getDevice(id);
    if (!existing) return undefined;

    const updated: LightDevice = {
      ...existing,
      name: changes.name ?? existing.name,
      type: changes.type ?? existing.type,
      ip_address: changes.ip_address ?? existing.ip_address,
      port: changes.port ?? existing.port,
      room: changes.room ?? existing.room,
      num_leds: changes.num_leds ?? existing.num_leds,
      updated_at: isoNow(),
    };

    this.db
      .prepare(
        `UPDATE lights_devices 
         SET name=?, type=?, ip_address=?, port=?, room=?, num_leds=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        updated.name,
        updated.type,
        updated.ip_address,
        updated.port,
        updated.room,
        updated.num_leds,
        updated.updated_at,
        id,
      );

    return updated;
  }

  deleteDevice(id: string): boolean {
    const exists = this.getDevice(id);
    if (!exists) return false;

    this.db.prepare("DELETE FROM lights_devices WHERE id = ?").run(id);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  // Device Control (HTTP to WLED/Tasmota)
  // ─────────────────────────────────────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEVICE_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async sendToWled(device: LightDevice, state: Partial<WledState>): Promise<boolean> {
    try {
      const url = `http://${device.ip_address}:${device.port}/json/state`;
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });

      if (response.ok) {
        this.updateDeviceStatus(device.id, "online");
        return true;
      }
      return false;
    } catch (error) {
      log.warn(`Failed to reach WLED device ${device.name}: ${error}`);
      this.updateDeviceStatus(device.id, "offline");
      return false;
    }
  }

  private async sendToTasmota(device: LightDevice, command: string): Promise<boolean> {
    try {
      const url = `http://${device.ip_address}:${device.port}/cm?cmnd=${encodeURIComponent(command)}`;
      const response = await this.fetchWithTimeout(url);

      if (response.ok) {
        this.updateDeviceStatus(device.id, "online");
        return true;
      }
      return false;
    } catch (error) {
      log.warn(`Failed to reach Tasmota device ${device.name}: ${error}`);
      this.updateDeviceStatus(device.id, "offline");
      return false;
    }
  }

  private updateDeviceStatus(id: string, status: DeviceStatus): void {
    const lastSeen = status === "online" ? isoNow() : null;
    this.db
      .prepare(
        "UPDATE lights_devices SET status=?, last_seen=COALESCE(?, last_seen), updated_at=? WHERE id=?",
      )
      .run(status, lastSeen, isoNow(), id);
  }

  async turnOn(deviceId: string): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    if (device.type === "wled") {
      return this.sendToWled(device, { on: true });
    } else if (device.type === "tasmota") {
      return this.sendToTasmota(device, "Power ON");
    }
    return false;
  }

  async turnOff(deviceId: string): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    if (device.type === "wled") {
      return this.sendToWled(device, { on: false });
    } else if (device.type === "tasmota") {
      return this.sendToTasmota(device, "Power OFF");
    }
    return false;
  }

  async toggle(deviceId: string): Promise<boolean> {
    const state = await this.getDeviceState(deviceId);
    if (state) {
      return state.on ? this.turnOff(deviceId) : this.turnOn(deviceId);
    }
    return false;
  }

  async setBrightness(deviceId: string, brightness: number): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    // Clamp to 0-255
    const bri = Math.max(0, Math.min(255, Math.round(brightness)));

    if (device.type === "wled") {
      return this.sendToWled(device, { on: bri > 0, bri });
    } else if (device.type === "tasmota") {
      return this.sendToTasmota(device, `Dimmer ${Math.round((bri / 255) * 100)}`);
    }
    return false;
  }

  async setColor(deviceId: string, color: RgbColor): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    if (device.type === "wled") {
      return this.sendToWled(device, {
        on: true,
        seg: [{ col: [[color.r, color.g, color.b]] }],
      } as Partial<WledState>);
    } else if (device.type === "tasmota") {
      const hex = this.rgbToHex(color);
      return this.sendToTasmota(device, `Color ${hex}`);
    }
    return false;
  }

  async setEffect(deviceId: string, effectId: number, speed?: number): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    if (device.type === "wled") {
      const payload: Partial<WledState> = {
        on: true,
        seg: [{ fx: effectId, sx: speed ?? 128 }],
      } as Partial<WledState>;
      return this.sendToWled(device, payload);
    }
    return false;
  }

  async setState(deviceId: string, state: Partial<LightState>): Promise<boolean> {
    const device = this.getDevice(deviceId);
    if (!device) return false;

    if (device.type === "wled") {
      const wledState: Partial<WledState> = {};
      if (state.on !== undefined) wledState.on = state.on;
      if (state.brightness !== undefined) wledState.bri = state.brightness;
      if (state.color) {
        wledState.seg = [{ col: [[state.color.r, state.color.g, state.color.b]] }] as WledState["seg"];
      }
      return this.sendToWled(device, wledState);
    }
    return false;
  }

  async getDeviceState(deviceId: string): Promise<LightState | null> {
    const device = this.getDevice(deviceId);
    if (!device) return null;

    try {
      if (device.type === "wled") {
        const url = `http://${device.ip_address}:${device.port}/json/state`;
        const response = await this.fetchWithTimeout(url);

        if (response.ok) {
          const data = (await response.json()) as WledState;
          this.updateDeviceStatus(device.id, "online");

          const seg = data.seg?.[0];
          const col = seg?.col?.[0] ?? [255, 255, 255];

          return {
            on: data.on,
            brightness: data.bri,
            color: { r: col[0], g: col[1], b: col[2] },
            effect: String(seg?.fx ?? 0),
            speed: seg?.sx ?? 128,
          };
        }
      }
    } catch (error) {
      log.debug(`Could not get state for ${device.name}: ${error}`);
      this.updateDeviceStatus(device.id, "offline");
    }

    return null;
  }

  async getDeviceInfo(deviceId: string): Promise<WledInfo | null> {
    const device = this.getDevice(deviceId);
    if (!device || device.type !== "wled") return null;

    try {
      const url = `http://${device.ip_address}:${device.port}/json/info`;
      const response = await this.fetchWithTimeout(url);
      if (response.ok) {
        return (await response.json()) as WledInfo;
      }
    } catch {
      // ignore
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Zone Control
  // ─────────────────────────────────────────────────────────────────

  addZone(input: CreateZoneInput): LightZone {
    const zone: LightZone = {
      id: newId(),
      name: input.name,
      device_ids: input.device_ids,
      created_at: isoNow(),
    };

    this.db
      .prepare(
        "INSERT INTO lights_zones (id, name, device_ids, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(zone.id, zone.name, JSON.stringify(zone.device_ids), zone.created_at);

    return zone;
  }

  getZone(id: string): LightZone | undefined {
    const row = this.db
      .prepare("SELECT * FROM lights_zones WHERE id = ?")
      .get(id) as { id: string; name: string; device_ids: string; created_at: string } | undefined;

    if (!row) return undefined;
    return {
      ...row,
      device_ids: JSON.parse(row.device_ids) as string[],
    };
  }

  getZoneByName(name: string): LightZone | undefined {
    const row = this.db
      .prepare("SELECT * FROM lights_zones WHERE LOWER(name) = LOWER(?)")
      .get(name) as { id: string; name: string; device_ids: string; created_at: string } | undefined;

    if (!row) return undefined;
    return {
      ...row,
      device_ids: JSON.parse(row.device_ids) as string[],
    };
  }

  listZones(): LightZone[] {
    const rows = this.db
      .prepare("SELECT * FROM lights_zones ORDER BY name")
      .all() as Array<{ id: string; name: string; device_ids: string; created_at: string }>;

    return rows.map((row) => ({
      ...row,
      device_ids: JSON.parse(row.device_ids) as string[],
    }));
  }

  deleteZone(id: string): boolean {
    const exists = this.getZone(id);
    if (!exists) return false;

    this.db.prepare("DELETE FROM lights_zones WHERE id = ?").run(id);
    return true;
  }

  async turnOnZone(zoneId: string): Promise<{ success: number; failed: number }> {
    const zone = this.getZone(zoneId);
    if (!zone) return { success: 0, failed: 0 };

    const results = await Promise.all(
      zone.device_ids.map((deviceId) => this.turnOn(deviceId)),
    );

    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  async turnOffZone(zoneId: string): Promise<{ success: number; failed: number }> {
    const zone = this.getZone(zoneId);
    if (!zone) return { success: 0, failed: 0 };

    const results = await Promise.all(
      zone.device_ids.map((deviceId) => this.turnOff(deviceId)),
    );

    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  async setZoneBrightness(
    zoneId: string,
    brightness: number,
  ): Promise<{ success: number; failed: number }> {
    const zone = this.getZone(zoneId);
    if (!zone) return { success: 0, failed: 0 };

    const results = await Promise.all(
      zone.device_ids.map((deviceId) => this.setBrightness(deviceId, brightness)),
    );

    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  async setZoneColor(
    zoneId: string,
    color: RgbColor,
  ): Promise<{ success: number; failed: number }> {
    const zone = this.getZone(zoneId);
    if (!zone) return { success: 0, failed: 0 };

    const results = await Promise.all(
      zone.device_ids.map((deviceId) => this.setColor(deviceId, color)),
    );

    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Scenes
  // ─────────────────────────────────────────────────────────────────

  addScene(input: CreateSceneInput): LightScene {
    const scene: LightScene = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      config: input.config,
      created_at: isoNow(),
    };

    this.db
      .prepare(
        "INSERT INTO lights_scenes (id, name, description, config, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(scene.id, scene.name, scene.description, JSON.stringify(scene.config), scene.created_at);

    return scene;
  }

  getScene(id: string): LightScene | undefined {
    const row = this.db
      .prepare("SELECT * FROM lights_scenes WHERE id = ?")
      .get(id) as { id: string; name: string; description: string; config: string; created_at: string } | undefined;

    if (!row) return undefined;
    return {
      ...row,
      config: JSON.parse(row.config) as SceneConfig,
    };
  }

  getSceneByName(name: string): LightScene | undefined {
    const row = this.db
      .prepare("SELECT * FROM lights_scenes WHERE LOWER(name) = LOWER(?)")
      .get(name) as { id: string; name: string; description: string; config: string; created_at: string } | undefined;

    if (!row) return undefined;
    return {
      ...row,
      config: JSON.parse(row.config) as SceneConfig,
    };
  }

  listScenes(): LightScene[] {
    const rows = this.db
      .prepare("SELECT * FROM lights_scenes ORDER BY name")
      .all() as Array<{ id: string; name: string; description: string; config: string; created_at: string }>;

    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as SceneConfig,
    }));
  }

  deleteScene(id: string): boolean {
    // Don't delete default scenes
    if (id.startsWith("scene-")) return false;

    const exists = this.getScene(id);
    if (!exists) return false;

    this.db.prepare("DELETE FROM lights_scenes WHERE id = ?").run(id);
    return true;
  }

  async applyScene(sceneId: string): Promise<{ success: number; failed: number }> {
    const scene = this.getScene(sceneId) ?? this.getSceneByName(sceneId);
    if (!scene) return { success: 0, failed: 0 };

    const devices = this.listDevices();
    let success = 0;
    let failed = 0;

    for (const device of devices) {
      // Check if scene has specific config for this device, or use wildcard
      const deviceConfig = scene.config.devices[device.id] ?? scene.config.devices["*"];
      if (!deviceConfig) continue;

      const result = await this.setState(device.id, deviceConfig);
      if (result) success++;
      else failed++;
    }

    return { success, failed };
  }

  // ─────────────────────────────────────────────────────────────────
  // Schedules
  // ─────────────────────────────────────────────────────────────────

  addSchedule(input: CreateScheduleInput): LightSchedule {
    const schedule: LightSchedule = {
      id: newId(),
      name: input.name,
      device_id: input.device_id ?? null,
      zone_id: input.zone_id ?? null,
      scene_id: input.scene_id ?? null,
      action: input.action,
      trigger_time: input.trigger_time,
      days: input.days,
      brightness: input.brightness ?? null,
      color: input.color ?? null,
      enabled: true,
      last_triggered: null,
      created_at: isoNow(),
    };

    this.db
      .prepare(
        `INSERT INTO lights_schedules 
         (id, name, device_id, zone_id, scene_id, action, trigger_time, days, brightness, color, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.device_id,
        schedule.zone_id,
        schedule.scene_id,
        schedule.action,
        schedule.trigger_time,
        JSON.stringify(schedule.days),
        schedule.brightness,
        schedule.color ? JSON.stringify(schedule.color) : null,
        schedule.enabled ? 1 : 0,
        schedule.created_at,
      );

    return schedule;
  }

  listSchedules(): LightSchedule[] {
    const rows = this.db
      .prepare("SELECT * FROM lights_schedules ORDER BY trigger_time")
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      device_id: row.device_id as string | null,
      zone_id: row.zone_id as string | null,
      scene_id: row.scene_id as string | null,
      action: row.action as "on" | "off" | "scene",
      trigger_time: row.trigger_time as string,
      days: JSON.parse(row.days as string) as DayOfWeek[],
      brightness: row.brightness as number | null,
      color: row.color ? (JSON.parse(row.color as string) as RgbColor) : null,
      enabled: Boolean(row.enabled),
      last_triggered: row.last_triggered as string | null,
      created_at: row.created_at as string,
    }));
  }

  toggleSchedule(id: string, enabled: boolean): boolean {
    const exists = this.db
      .prepare("SELECT 1 FROM lights_schedules WHERE id = ?")
      .get(id);
    if (!exists) return false;

    this.db
      .prepare("UPDATE lights_schedules SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    return true;
  }

  deleteSchedule(id: string): boolean {
    const exists = this.db
      .prepare("SELECT 1 FROM lights_schedules WHERE id = ?")
      .get(id);
    if (!exists) return false;

    this.db.prepare("DELETE FROM lights_schedules WHERE id = ?").run(id);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  // Convenience: All lights control
  // ─────────────────────────────────────────────────────────────────

  async turnOnAll(): Promise<{ success: number; failed: number }> {
    const devices = this.listDevices();
    const results = await Promise.all(
      devices.map((d) => this.turnOn(d.id)),
    );
    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  async turnOffAll(): Promise<{ success: number; failed: number }> {
    const devices = this.listDevices();
    const results = await Promise.all(
      devices.map((d) => this.turnOff(d.id)),
    );
    return {
      success: results.filter(Boolean).length,
      failed: results.filter((r) => !r).length,
    };
  }

  async getAllStates(): Promise<Array<{ device: LightDevice; state: LightState | null }>> {
    const devices = this.listDevices();
    const states = await Promise.all(
      devices.map(async (device) => ({
        device,
        state: await this.getDeviceState(device.id),
      })),
    );
    return states;
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  parseColor(colorInput: string): RgbColor | null {
    // Check preset colors first
    const preset = PRESET_COLORS[colorInput.toLowerCase()];
    if (preset) return preset;

    // Try RGB format: "255,0,0" or "255 0 0"
    const rgbMatch = colorInput.match(/(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})/);
    if (rgbMatch) {
      return {
        r: Math.min(255, parseInt(rgbMatch[1], 10)),
        g: Math.min(255, parseInt(rgbMatch[2], 10)),
        b: Math.min(255, parseInt(rgbMatch[3], 10)),
      };
    }

    // Try hex format: "#FF0000" or "FF0000"
    const hexMatch = colorInput.match(/^#?([0-9a-fA-F]{6})$/);
    if (hexMatch) {
      const hex = hexMatch[1];
      return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16),
      };
    }

    return null;
  }

  private rgbToHex(color: RgbColor): string {
    const toHex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }

  // Resolve device by ID or name
  resolveDevice(idOrName: string): LightDevice | undefined {
    return this.getDevice(idOrName) ?? this.getDeviceByName(idOrName);
  }

  // Resolve zone by ID or name
  resolveZone(idOrName: string): LightZone | undefined {
    return this.getZone(idOrName) ?? this.getZoneByName(idOrName);
  }

  // Resolve scene by ID or name
  resolveScene(idOrName: string): LightScene | undefined {
    return this.getScene(idOrName) ?? this.getSceneByName(idOrName);
  }
}
