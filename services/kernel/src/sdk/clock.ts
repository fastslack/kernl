/**
 * Calendar dates in the kernel's timezone.
 *
 * `today()` used to be `new Date().toISOString().split("T")[0]`, which is the
 * UTC date: in UTC-3 "today" became tomorrow at 21:00, while cron schedules
 * already ran in the TIMEZONE setting. Every "today" now follows that
 * setting, read through the host, so an extension's bundled copy of this file
 * sees the kernel's value too. An unset TIMEZONE is UTC, which is what these
 * helpers always returned.
 *
 * Calendar columns (due_date, next_due, date) hold local dates and compare
 * with `today()`. Timestamp columns (created_at, updated_at, *_at) hold UTC
 * instants and compare with `localDayRange()`.
 */

import { getHost } from "./host.js";

// One formatter per zone: building an Intl.DateTimeFormat is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    try {
      formatters.set(tz, new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }));
    } catch {
      formatters.set(tz, null); // not a zone name Intl knows
    }
  }
  return formatters.get(tz)!;
}

/** The kernel's IANA timezone; UTC when none is set or the name is not valid. */
export function kernelTimezone(): string {
  const tz = getHost().timezone?.() || "UTC";
  return formatterFor(tz) ? tz : "UTC";
}

/** Offset of `tz` from UTC at `at`, in ms (UTC-3 → -10_800_000). */
function offsetMs(tz: string, at: Date): number {
  const parts = formatterFor(tz)!.formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The wall-clock date and time of `at` in the kernel's timezone, "YYYY-MM-DDTHH:MM:SS" (no zone). */
export function localDateTime(at: Date = new Date()): string {
  return new Date(at.getTime() + offsetMs(kernelTimezone(), at)).toISOString().slice(0, 19);
}

/** The calendar date (YYYY-MM-DD) of `at` in the kernel's timezone. */
export function localDate(at: Date = new Date()): string {
  return localDateTime(at).slice(0, 10);
}

/** Calendar arithmetic on a YYYY-MM-DD date; DST never shifts the result. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in the kernel's timezone. */
export function today(now: Date = new Date()): string {
  return localDate(now);
}

/** The date N days from today (YYYY-MM-DD) in the kernel's timezone. */
export function daysFromNow(n: number, now: Date = new Date()): string {
  return addDays(today(now), n);
}

/** The UTC instant (ms) of a wall-clock time in the kernel's timezone. */
function wallToUtcMs(date: string, h = 0, m = 0, s = 0): number {
  const tz = kernelTimezone();
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y!, mo! - 1, d!, h, m, s);
  // Two passes: the offset at a guess can differ from the offset at the
  // wall time itself when DST changes that day.
  let t = wall - offsetMs(tz, new Date(wall));
  t = wall - offsetMs(tz, new Date(t));
  return t;
}

/**
 * The UTC instant (ISO) at which a local calendar day starts, for comparing
 * timestamp columns. It replaces `${date}T00:00:00`, which was always UTC
 * midnight; with no TIMEZONE set it is the same instant.
 */
export function dayStart(date: string): string {
  return new Date(wallToUtcMs(date)).toISOString();
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// SQLite's datetime()/CURRENT_TIMESTAMP output: UTC, space-separated.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
// ISO without a zone designator: a wall-clock time.
const WALL_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * A stored or incoming timestamp as a UTC instant (ISO with Z), or null when
 * it is not a date at all. The storage rule for timestamps is "UTC instant";
 * this is how values that do not follow it are read:
 *   - with Z or an offset: already an instant;
 *   - "YYYY-MM-DD HH:MM:SS" (SQLite's own format): UTC;
 *   - "YYYY-MM-DDTHH:MM" with no zone: wall-clock time in the kernel's
 *     timezone, which is what a person or a datetime-local input means;
 *   - "YYYY-MM-DD": the start of that local day.
 */
export function toInstant(value: string): string | null {
  const v = value.trim();
  if (DATE_ONLY.test(v)) return dayStart(v);
  const sqlite = v.match(SQLITE_UTC);
  if (sqlite) return new Date(`${sqlite[1]}T${sqlite[2]}Z`).toISOString();
  const wall = v.match(WALL_TIME);
  if (wall) return new Date(wallToUtcMs(wall[1]!, Number(wall[2]), Number(wall[3]), Number(wall[4] ?? 0))).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * The local calendar date and HH:MM of a stored timestamp, for putting a row
 * on the right day. Replaces `ts.split("T")[0]` / `ts.split("T")[1].slice(0, 5)`,
 * which read the UTC day. A bare date has no time; something that is not a
 * timestamp is split as before.
 */
export function localParts(value: string): { date: string; time: string | null } {
  if (DATE_ONLY.test(value)) return { date: value, time: null };
  const instant = toInstant(value);
  if (!instant) return { date: value.split("T")[0]!, time: value.split("T")[1]?.slice(0, 5) ?? null };
  const wall = localDateTime(new Date(instant));
  return { date: wall.slice(0, 10), time: wall.slice(11, 16) };
}

/** The local calendar date of a stored timestamp. */
export function localDateOf(value: string): string {
  return localParts(value).date;
}

/**
 * The UTC instants [start, end) that bound a local calendar day, for
 * comparing timestamp columns: `updated_at >= ? AND updated_at < ?`.
 */
export function localDayRange(date: string = today()): [start: string, end: string] {
  return [dayStart(date), dayStart(addDays(date, 1))];
}
