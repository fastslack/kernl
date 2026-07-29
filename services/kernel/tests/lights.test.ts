import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/core/db/migrations.js";
import { lightsMigrations } from "../assets/extensions/house/lights/_module/migrations/001_lights.js";
import { LightsService } from "../assets/extensions/house/lights/_module/service.js";
import { PRESET_COLORS } from "../assets/extensions/house/lights/_module/types.js";

describe("LightsService", () => {
  let db: Database;
  let service: LightsService;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    runMigrations(db, "lights", lightsMigrations);
    service = new LightsService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Seeds ──────────────────────────────────────────

  it("seeds default scenes", () => {
    const scenes = service.listScenes();
    expect(scenes.length).toBe(5);
    expect(scenes.find((s) => s.name === "Relax")).toBeTruthy();
    expect(scenes.find((s) => s.name === "Focus")).toBeTruthy();
    expect(scenes.find((s) => s.name === "Movie")).toBeTruthy();
    expect(scenes.find((s) => s.name === "Night")).toBeTruthy();
    expect(scenes.find((s) => s.name === "Party")).toBeTruthy();
  });

  // ── Devices ──────────────────────────────────────────

  it("adds a device", () => {
    const device = service.addDevice({
      name: "Living Room Strip",
      ip_address: "192.168.1.50",
      room: "living_room",
      num_leds: 60,
    });

    expect(device.id).toBeTruthy();
    expect(device.name).toBe("Living Room Strip");
    expect(device.type).toBe("wled");
    expect(device.ip_address).toBe("192.168.1.50");
    expect(device.port).toBe(80);
    expect(device.room).toBe("living_room");
    expect(device.num_leds).toBe(60);
    expect(device.status).toBe("unknown");
  });

  it("lists devices", () => {
    service.addDevice({ name: "Device 1", ip_address: "192.168.1.50", room: "living" });
    service.addDevice({ name: "Device 2", ip_address: "192.168.1.51", room: "bedroom" });
    service.addDevice({ name: "Device 3", ip_address: "192.168.1.52", room: "living" });

    const all = service.listDevices();
    expect(all.length).toBe(3);

    const living = service.listDevices({ room: "living" });
    expect(living.length).toBe(2);
  });

  it("gets device by ID", () => {
    const created = service.addDevice({ name: "Test", ip_address: "192.168.1.50" });
    const fetched = service.getDevice(created.id);

    expect(fetched).toBeTruthy();
    expect(fetched?.name).toBe("Test");
  });

  it("gets device by name (case-insensitive)", () => {
    service.addDevice({ name: "Living Room", ip_address: "192.168.1.50" });

    expect(service.getDeviceByName("Living Room")).toBeTruthy();
    expect(service.getDeviceByName("living room")).toBeTruthy();
    expect(service.getDeviceByName("LIVING ROOM")).toBeTruthy();
  });

  it("updates a device", () => {
    const device = service.addDevice({ name: "Test", ip_address: "192.168.1.50" });
    const updated = service.updateDevice(device.id, {
      name: "Updated Name",
      room: "bedroom",
    });

    expect(updated?.name).toBe("Updated Name");
    expect(updated?.room).toBe("bedroom");
    expect(updated?.ip_address).toBe("192.168.1.50"); // unchanged
  });

  it("deletes a device", () => {
    const device = service.addDevice({ name: "Test", ip_address: "192.168.1.50" });
    expect(service.deleteDevice(device.id)).toBe(true);
    expect(service.getDevice(device.id)).toBeFalsy();
  });

  it("resolveDevice works with ID or name", () => {
    const device = service.addDevice({ name: "Test Device", ip_address: "192.168.1.50" });

    expect(service.resolveDevice(device.id)?.name).toBe("Test Device");
    expect(service.resolveDevice("Test Device")?.name).toBe("Test Device");
    expect(service.resolveDevice("test device")?.name).toBe("Test Device");
    expect(service.resolveDevice("nonexistent")).toBeFalsy();
  });

  // ── Zones ──────────────────────────────────────────

  it("adds a zone", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    const d2 = service.addDevice({ name: "D2", ip_address: "192.168.1.51" });

    const zone = service.addZone({
      name: "Downstairs",
      device_ids: [d1.id, d2.id],
    });

    expect(zone.id).toBeTruthy();
    expect(zone.name).toBe("Downstairs");
    expect(zone.device_ids).toEqual([d1.id, d2.id]);
  });

  it("lists zones", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    service.addZone({ name: "Zone 1", device_ids: [d1.id] });
    service.addZone({ name: "Zone 2", device_ids: [d1.id] });

    const zones = service.listZones();
    expect(zones.length).toBe(2);
  });

  it("gets zone by name (case-insensitive)", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    service.addZone({ name: "Downstairs", device_ids: [d1.id] });

    expect(service.getZoneByName("Downstairs")).toBeTruthy();
    expect(service.getZoneByName("downstairs")).toBeTruthy();
  });

  it("deletes a zone", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    const zone = service.addZone({ name: "Test", device_ids: [d1.id] });

    expect(service.deleteZone(zone.id)).toBe(true);
    expect(service.getZone(zone.id)).toBeUndefined();
  });

  it("resolveZone works with ID or name", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    const zone = service.addZone({ name: "Test Zone", device_ids: [d1.id] });

    expect(service.resolveZone(zone.id)?.name).toBe("Test Zone");
    expect(service.resolveZone("Test Zone")?.name).toBe("Test Zone");
    expect(service.resolveZone("test zone")?.name).toBe("Test Zone");
  });

  // ── Scenes ──────────────────────────────────────────

  it("adds a custom scene", () => {
    const scene = service.addScene({
      name: "Custom",
      description: "My custom scene",
      config: {
        devices: {
          "*": { on: true, brightness: 128 },
        },
      },
    });

    expect(scene.id).toBeTruthy();
    expect(scene.name).toBe("Custom");
    expect(scene.config.devices["*"].brightness).toBe(128);
  });

  it("gets scene by name (case-insensitive)", () => {
    expect(service.getSceneByName("Relax")).toBeTruthy();
    expect(service.getSceneByName("relax")).toBeTruthy();
    expect(service.getSceneByName("RELAX")).toBeTruthy();
  });

  it("cannot delete default scenes", () => {
    // Default scenes have IDs like "scene-relax"
    expect(service.deleteScene("scene-relax")).toBe(false);
  });

  it("can delete custom scenes", () => {
    const scene = service.addScene({
      name: "Custom",
      config: { devices: {} },
    });

    expect(service.deleteScene(scene.id)).toBe(true);
  });

  it("resolveScene works with ID or name", () => {
    expect(service.resolveScene("scene-relax")?.name).toBe("Relax");
    expect(service.resolveScene("Relax")?.name).toBe("Relax");
    expect(service.resolveScene("relax")?.name).toBe("Relax");
  });

  // ── Schedules ──────────────────────────────────────

  it("adds a schedule", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });

    const schedule = service.addSchedule({
      name: "Morning On",
      device_id: d1.id,
      action: "on",
      trigger_time: "07:00",
      days: ["mon", "tue", "wed", "thu", "fri"],
      brightness: 200,
    });

    expect(schedule.id).toBeTruthy();
    expect(schedule.name).toBe("Morning On");
    expect(schedule.trigger_time).toBe("07:00");
    expect(schedule.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(schedule.enabled).toBe(true);
  });

  it("lists schedules", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    service.addSchedule({ name: "S1", device_id: d1.id, action: "on", trigger_time: "07:00", days: ["mon"] });
    service.addSchedule({ name: "S2", device_id: d1.id, action: "off", trigger_time: "23:00", days: ["mon"] });

    const schedules = service.listSchedules();
    expect(schedules.length).toBe(2);
  });

  it("toggles schedule enabled/disabled", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    const schedule = service.addSchedule({
      name: "Test",
      device_id: d1.id,
      action: "on",
      trigger_time: "07:00",
      days: ["mon"],
    });

    expect(service.toggleSchedule(schedule.id, false)).toBe(true);
    const updated = service.listSchedules().find((s) => s.id === schedule.id);
    expect(updated?.enabled).toBe(false);
  });

  it("deletes a schedule", () => {
    const d1 = service.addDevice({ name: "D1", ip_address: "192.168.1.50" });
    const schedule = service.addSchedule({
      name: "Test",
      device_id: d1.id,
      action: "on",
      trigger_time: "07:00",
      days: ["mon"],
    });

    expect(service.deleteSchedule(schedule.id)).toBe(true);
    expect(service.listSchedules().length).toBe(0);
  });

  // ── Color Parsing ──────────────────────────────────

  it("parses preset colors", () => {
    expect(service.parseColor("warm")).toEqual(PRESET_COLORS.warm);
    expect(service.parseColor("WARM")).toEqual(PRESET_COLORS.warm);
    expect(service.parseColor("red")).toEqual({ r: 255, g: 0, b: 0 });
    expect(service.parseColor("blue")).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("parses RGB format", () => {
    expect(service.parseColor("255,0,0")).toEqual({ r: 255, g: 0, b: 0 });
    expect(service.parseColor("255, 128, 64")).toEqual({ r: 255, g: 128, b: 64 });
    expect(service.parseColor("0 255 0")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("parses hex format", () => {
    expect(service.parseColor("#FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(service.parseColor("FF0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(service.parseColor("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("returns null for invalid colors", () => {
    expect(service.parseColor("invalid")).toBeNull();
    expect(service.parseColor("123")).toBeNull();
    expect(service.parseColor("#GGG")).toBeNull();
  });

  // ── Clamps RGB values ──────────────────────────────

  it("clamps RGB values to 0-255", () => {
    const color = service.parseColor("300,400,500");
    expect(color).toEqual({ r: 255, g: 255, b: 255 });
  });
});

// ── Preset Colors ──────────────────────────────────────

describe("PRESET_COLORS", () => {
  it("has all expected presets", () => {
    expect(PRESET_COLORS.warm).toBeTruthy();
    expect(PRESET_COLORS.cool).toBeTruthy();
    expect(PRESET_COLORS.daylight).toBeTruthy();
    expect(PRESET_COLORS.red).toEqual({ r: 255, g: 0, b: 0 });
    expect(PRESET_COLORS.green).toEqual({ r: 0, g: 255, b: 0 });
    expect(PRESET_COLORS.blue).toEqual({ r: 0, g: 0, b: 255 });
    expect(PRESET_COLORS.white).toEqual({ r: 255, g: 255, b: 255 });
    expect(PRESET_COLORS.off).toEqual({ r: 0, g: 0, b: 0 });
  });
});
