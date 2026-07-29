/**
 * Life-domain MCP tools. Moved here from the core dashboard module so the tools
 * live with the table (`life_log`) and the service that own them. `kernel_weather`
 * is backed by LifeService.getWeather() (shared 15-min cache) instead of its own
 * open-meteo fetch — no more duplicate calls.
 */

import { z } from "zod";
import type { ToolDefinition } from "../../../../../src/core/types.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import { textResult, errorResult, newId, isoNow } from "../../../../../src/core/helpers.js";
import {
  queryHabits,
  queryWaterIntake,
  queryMoodLog,
  queryDailySummary,
} from "../../../../../src/modules/dashboard/life-queries.js";
import type { LifeService } from "./life-service.js";

const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Moderate drizzle",
  55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Light freezing rain",
  67: "Heavy freezing rain", 71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ slight hail", 99: "Thunderstorm w/ heavy hail",
};

export function lifeTools(service: LifeService, db: SqliteDb): ToolDefinition[] {
  return [
    {
      name: "kernel_life_log",
      description:
        "Log a personal life entry: habit completion, water glass, mood (1-5), exercise, or daily note.",
      inputSchema: z.object({
        type: z.enum(["habit", "water", "mood", "note", "exercise"]).describe("Type of log entry"),
        value: z.string().describe("For habit: habit name. For mood: 1-5. For water: ignored. For exercise/note: description."),
        date: z.string().optional().describe("Date (YYYY-MM-DD). Defaults to today."),
      }),
      handler: async (args) => {
        const input = args as { type: string; value: string; date?: string };
        const date = input.date ?? new Date().toISOString().split("T")[0]!;
        try {
          db.prepare(
            `INSERT INTO life_log (id, type, value, date, created_at) VALUES (?, ?, ?, ?, ?)`,
          ).run(newId(), input.type, input.value, date, isoNow());
          return textResult(`Logged ${input.type}: ${input.value || "(recorded)"} for ${date}`);
        } catch (err) {
          return errorResult(`Failed to log: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: "kernel_life_status",
      description:
        "Get today's life tracking status: habits with streaks, water intake, mood, and daily summary.",
      inputSchema: z.object({}),
      handler: async () => {
        const today = new Date().toISOString().split("T")[0]!;
        const sections: string[] = ["# Life Status", `Date: ${today}`, ""];

        const summary = queryDailySummary(db);
        sections.push("## Daily Summary");
        sections.push(`- Tasks done: ${summary.tasksDone}`);
        sections.push(`- Tasks created: ${summary.tasksCreated}`);
        sections.push(`- Interactions: ${summary.interactions}`);
        sections.push(`- Reminders fired: ${summary.remindersFired}`);
        sections.push(`- Purchases: ${summary.purchases}`);
        if (summary.issuesClosed > 0) sections.push(`- Issues closed: ${summary.issuesClosed}`);
        sections.push("");

        const habits = queryHabits(db, today);
        sections.push(`## Habits (${habits.length})`);
        if (habits.length > 0) {
          for (const h of habits) {
            const check = h.doneToday ? "✅" : "⬜";
            sections.push(`- ${check} ${h.name} — streak: ${h.streak}d`);
          }
        } else {
          sections.push("No habits tracked yet.");
        }
        sections.push("");

        const water = queryWaterIntake(db, today);
        sections.push(`## Water Intake`, `${water.glasses}/${water.goal} glasses`, "");

        const moods = queryMoodLog(db, 7);
        sections.push(`## Mood (last 7 entries)`);
        if (moods.length > 0) {
          const moodEmojis = ["", "\u{1F62D}", "\u{1F614}", "\u{1F610}", "\u{1F60A}", "\u{1F929}"];
          for (const m of moods) sections.push(`- ${m.date}: ${moodEmojis[m.value] ?? m.value}`);
        } else {
          sections.push("No mood entries yet.");
        }

        return textResult(sections.join("\n"));
      },
    },
    {
      name: "kernel_weather",
      description:
        "Get current weather, hourly rain probability for the next 24h, and 7-day forecast. Returns temperature, conditions, wind, UV, and precipitation data.",
      inputSchema: z.object({}),
      handler: async () => {
        try {
          const w = await service.getWeather();
          if (!w) return errorResult("Weather unavailable (open-meteo fetch failed or no location set).");
          const city = process.env.LIFE_CITY ?? "Weather";
          const cur = w.current;
          const lines: string[] = [
            `# Weather — ${city}`,
            `**Now:** ${cur.temperature}°C (feels ${cur.feelsLike}°C) | ${WEATHER_CODES[cur.weatherCode] ?? "Unknown"} | Humidity ${cur.humidity}% | Wind ${cur.windSpeed}km/h | UV ${cur.uvIndex}`,
            "",
            "## Rain Probability (next 24h)",
          ];
          const now = Date.now();
          let maxRain = 0;
          for (const h of w.hourly) {
            const t = new Date(h.time).getTime();
            if (t < now || t - now > 24 * 3600_000) continue;
            const prob = h.precipitationProbability ?? 0;
            if (prob > maxRain) maxRain = prob;
            const hh = new Date(h.time).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: process.env.TIMEZONE ?? "UTC" });
            const filled = Math.round(prob / 10);
            const bar = "█".repeat(filled) + "░".repeat(10 - filled);
            lines.push(`${hh}  ${bar} ${prob}%  ${WEATHER_CODES[h.weatherCode] ?? ""}`);
          }
          lines.push("", `**Peak rain probability:** ${maxRain}%`, "", "## 7-Day Forecast");
          for (const d of w.daily) {
            lines.push(`${d.date}  ${d.tempMin}–${d.tempMax}°C  Rain: ${d.precipitationProbabilityMax}%  UV: ${d.uvIndexMax}  ${WEATHER_CODES[d.weatherCode] ?? ""}`);
          }
          return textResult(lines.join("\n"));
        } catch (err) {
          return errorResult(`Weather fetch failed: ${String(err)}`);
        }
      },
    },
  ];
}
