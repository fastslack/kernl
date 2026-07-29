/**
 * Lights module types
 * Supports WLED, Tasmota, and custom LED controllers
 */

// Device types supported
export type DeviceType = "wled" | "tasmota" | "custom" | "hue";

// Device status
export type DeviceStatus = "online" | "offline" | "unknown";

// Light device (ESP32, Raspberry Pi, etc.)
export interface LightDevice {
  id: string;
  name: string;
  type: DeviceType;
  ip_address: string;
  port: number;
  room: string;
  num_leds: number;
  status: DeviceStatus;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

// RGB color
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

// Current state of a light device
export interface LightState {
  on: boolean;
  brightness: number; // 0-255
  color: RgbColor;
  effect: string;
  speed: number; // effect speed 0-255
}

// Scene - predefined lighting configuration
export interface LightScene {
  id: string;
  name: string;
  description: string;
  config: SceneConfig;
  created_at: string;
}

// Scene configuration
export interface SceneConfig {
  devices: Record<string, Partial<LightState>>;
}

// Zone - group of devices
export interface LightZone {
  id: string;
  name: string;
  device_ids: string[];
  created_at: string;
}

// Schedule - automated lighting
export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface LightSchedule {
  id: string;
  name: string;
  device_id: string | null;
  zone_id: string | null;
  scene_id: string | null;
  action: "on" | "off" | "scene";
  trigger_time: string; // HH:MM format
  days: DayOfWeek[];
  brightness: number | null;
  color: RgbColor | null;
  enabled: boolean;
  last_triggered: string | null;
  created_at: string;
}

// Input types for creating/updating
export interface CreateDeviceInput {
  name: string;
  type?: DeviceType;
  ip_address: string;
  port?: number;
  room?: string;
  num_leds?: number;
}

export interface UpdateDeviceInput {
  name?: string;
  type?: DeviceType;
  ip_address?: string;
  port?: number;
  room?: string;
  num_leds?: number;
}

export interface CreateSceneInput {
  name: string;
  description?: string;
  config: SceneConfig;
}

export interface CreateZoneInput {
  name: string;
  device_ids: string[];
}

export interface CreateScheduleInput {
  name: string;
  device_id?: string;
  zone_id?: string;
  scene_id?: string;
  action: "on" | "off" | "scene";
  trigger_time: string;
  days: DayOfWeek[];
  brightness?: number;
  color?: RgbColor;
}

// WLED API response types
export interface WledState {
  on: boolean;
  bri: number;
  seg: Array<{
    col: Array<[number, number, number]>;
    fx: number;
    sx: number;
  }>;
}

export interface WledInfo {
  ver: string;
  name: string;
  leds: {
    count: number;
  };
}

// Preset colors
export const PRESET_COLORS: Record<string, RgbColor> = {
  warm: { r: 255, g: 180, b: 100 },
  cool: { r: 200, g: 220, b: 255 },
  daylight: { r: 255, g: 255, b: 250 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 255, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  purple: { r: 128, g: 0, b: 255 },
  orange: { r: 255, g: 100, b: 0 },
  pink: { r: 255, g: 100, b: 180 },
  cyan: { r: 0, g: 255, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  off: { r: 0, g: 0, b: 0 },
};
