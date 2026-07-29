import { log } from "../../../../../src/core/logger.js";
import type { SqliteDb } from "../../../../../src/core/db/sqlite.js";
import type { KernelConfig } from "../../../../../src/core/config.js";
import type { SystemRegistry } from "../../../../../src/core/system-registry.js";
import { queryDailySummary, queryHabits, queryWaterIntake, queryMoodLog } from "../../../../../src/modules/dashboard/life-queries.js";

// ── Module-level caches ───────────────────────
// DateTimeFormat instances are expensive to construct — reuse across calls
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function getDtf(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let fmt = dtfCache.get(key);
  if (!fmt) { fmt = new Intl.DateTimeFormat(locale, options); dtfCache.set(key, fmt); }
  return fmt;
}

// Easter/holidays are pure functions of the year — memoize by year
const easterCache = new Map<number, Date>();

// ── TTL constants (ms) ────────────────────────
const TTL = {
  weather: 15 * 60_000,
  airQuality: 30 * 60_000,
  pollen: 60 * 60_000,
  sunTimes: 60 * 60_000,
  currency: 60 * 60_000,
  commodities: 15 * 60_000,
  earthquakes: 30 * 60_000,
};

// ── Cache ─────────────────────────────────────
class LifeCache {
  private store = new Map<string, { data: unknown; expiresAt: number }>();
  private registry: SystemRegistry | null = null;
  private registryIds = new Map<string, string>();
  // Failure backoff: when an upstream flaps (e.g. Open-Meteo 429), we arm a
  // cooldown per key so the dashboard's ~15s poll stops re-hammering it. The
  // last good value is kept separately so we can serve slightly-stale data
  // during the cooldown instead of nothing.
  private cooldownUntil = new Map<string, number>();
  private lastGood = new Map<string, unknown>();

  setRegistry(registry: SystemRegistry): void {
    this.registry = registry;
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    const regId = this.registryIds.get(key);
    if (regId) this.registry?.recordCacheHit(regId);
    return entry.data as T;
  }

  /** True while a key is in failure backoff — callers must skip the network. */
  inCooldown(key: string): boolean {
    const until = this.cooldownUntil.get(key);
    return until !== undefined && Date.now() < until;
  }

  /** Arm a failure backoff so a flapping/rate-limited upstream isn't hammered. */
  setCooldown(key: string, ms: number): void {
    this.cooldownUntil.set(key, Date.now() + ms);
  }

  /** Last successfully-fetched value, even after its TTL lapsed. Served during
   *  a cooldown so the UI shows stale data rather than empty. */
  getStale<T>(key: string): T | null {
    return (this.lastGood.get(key) as T) ?? null;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
    this.lastGood.set(key, data);
    this.cooldownUntil.delete(key); // success clears any prior backoff

    // Register or update cache entry in system registry
    if (this.registry) {
      let regId = this.registryIds.get(key);
      if (!regId) {
        regId = this.registry.register({
          name: `Cache: ${key}`,
          type: "cache",
          module: "life",
          description: `TTL cache for ${key} API data`,
          ttlMs,
          status: "idle",
        });
        this.registryIds.set(key, regId);
      }
      this.registry.recordCacheRefresh(regId);
    }
  }
}

// ── Types ─────────────────────────────────────
export interface WeatherData {
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    windDirection: number;
    weatherCode: number;
    uvIndex: number;
  };
  hourly: Array<{
    time: string;
    temperature: number;
    precipitationProbability: number;
    weatherCode: number;
  }>;
  daily: Array<{
    date: string;
    tempMax: number;
    tempMin: number;
    precipitationProbabilityMax: number;
    weatherCode: number;
    uvIndexMax: number;
  }>;
}

export interface AirQualityData {
  europeanAqi: number;
  pm25: number;
  pm10: number;
  ozone: number;
  no2: number;
  pollen: {
    alder: number;
    birch: number;
    grass: number;
    mugwort: number;
  };
}

export interface SunTimesData {
  sunrise: string;
  sunset: string;
  dayLength: number;
  goldenHourMorning: { start: string; end: string };
  goldenHourEvening: { start: string; end: string };
  dayLengthTrend: number;
}

export interface CurrencyPair {
  from: string;
  to: string;
  rate: number;
}

export interface CurrencyData {
  base: string;
  date: string;
  rates: Record<string, number>;
  pairs: CurrencyPair[];
}

export interface CommodityItem {
  symbol: string;
  name: string;
  price: number;
  unit: string;
}

export interface CommodityData {
  items: CommodityItem[];
  fetchedAt: string;
}

export interface EarthquakeData {
  quakes: Array<{
    magnitude: number;
    place: string;
    time: number;
    url: string;
  }>;
}

export interface MoonPhaseData {
  phase: string;
  illumination: number;
  emoji: string;
  age: number;
}

export interface WorldClock {
  timezone: string;
  city: string;
  time: string;
  offset: string;
}

export interface Holiday {
  name: string;
  date: string;
  daysUntil: number;
}

export interface LifeData {
  generatedAt: string;
  weather: WeatherData | null;
  airQuality: AirQualityData | null;
  sunTimes: SunTimesData | null;
  currency: CurrencyData | null;
  commodities: CommodityData | null;
  earthquakes: EarthquakeData | null;
  moonPhase: MoonPhaseData;
  worldClocks: WorldClock[];
  holidays: Holiday[];
  quote: { text: string; author: string };
  dailySummary: ReturnType<typeof queryDailySummary>;
  habits: ReturnType<typeof queryHabits>;
  waterIntake: ReturnType<typeof queryWaterIntake>;
  moodLog: ReturnType<typeof queryMoodLog>;
  waterGoal: number;
}

// ── LifeService ───────────────────────────────
export class LifeService {
  private cache = new LifeCache();
  private config: KernelConfig["life"];
  private db: SqliteDb;

  constructor(db: SqliteDb, config: KernelConfig["life"], registry?: SystemRegistry) {
    this.db = db;
    this.config = config;
    if (registry) this.cache.setRegistry(registry);
  }

  async getLifeData(): Promise<LifeData> {
    const today = new Date().toISOString().split("T")[0]!;

    const results = await Promise.allSettled([
      this.fetchWeather(),
      this.fetchAirQuality(),
      this.fetchSunTimes(),
      this.fetchCurrency(),
      this.fetchCommodities(),
      this.fetchEarthquakes(),
    ]);

    const sunTimes = results[2].status === "fulfilled" ? results[2].value : null;

    return {
      generatedAt: new Date().toISOString(),
      weather: results[0].status === "fulfilled" ? results[0].value : null,
      airQuality: results[1].status === "fulfilled" ? results[1].value : null,
      sunTimes,
      currency: results[3].status === "fulfilled" ? results[3].value : null,
      commodities: results[4].status === "fulfilled" ? results[4].value : null,
      earthquakes: results[5].status === "fulfilled" ? results[5].value : null,
      moonPhase: computeMoonPhase(new Date()),
      worldClocks: computeWorldClocks(this.config.clocks),
      holidays: computeHolidays(),
      quote: getDailyQuote(),
      dailySummary: queryDailySummary(this.db),
      habits: queryHabits(this.db, today),
      waterIntake: queryWaterIntake(this.db, today),
      moodLog: queryMoodLog(this.db, 7),
      waterGoal: this.config.waterGoal,
    };
  }

  /** Public accessor for the cached weather (shared with the `kernel_weather`
   *  tool so it doesn't duplicate the open-meteo fetch). */
  async getWeather(): Promise<WeatherData | null> {
    return this.fetchWeather();
  }

  // ── API Fetchers ──────────────────────────────

  /** Arm a per-key failure backoff so a flapping/rate-limited upstream isn't
   *  re-hit on every dashboard poll. A 429 with a `Retry-After` header is
   *  honoured (clamped to a sane range); otherwise we use a 10-min cooldown for
   *  rate limits and 2 min for transient errors. */
  private armBackoff(key: string, res?: Response): void {
    let ms = 2 * 60_000; // transient error / exception default
    if (res?.status === 429) {
      ms = 10 * 60_000;
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        ms = Math.min(60 * 60_000, Math.max(60_000, retryAfter * 1000));
      }
    }
    this.cache.setCooldown(key, ms);
  }

  private async fetchWeather(): Promise<WeatherData | null> {
    const cached = this.cache.get<WeatherData>("weather");
    if (cached) return cached;
    if (this.cache.inCooldown("weather")) return this.cache.getStale<WeatherData>("weather");
    try {
      const { lat, lon, timezone } = this.config;
      const tz = encodeURIComponent(timezone);
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,uv_index&hourly=temperature_2m,precipitation_probability,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,uv_index_max&timezone=${tz}&forecast_days=7`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn(`Open-Meteo weather returned ${res.status}`);
        this.armBackoff("weather", res);
        return this.cache.getStale<WeatherData>("weather");
      }
      const raw = await res.json() as Record<string, unknown>;
      const parsed = parseWeatherResponse(raw);
      this.cache.set("weather", parsed, TTL.weather);
      return parsed;
    } catch (err) {
      log.error(`Weather fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("weather");
      return this.cache.getStale<WeatherData>("weather");
    }
  }

  private async fetchAirQuality(): Promise<AirQualityData | null> {
    const cached = this.cache.get<AirQualityData>("airQuality");
    if (cached) return cached;
    if (this.cache.inCooldown("airQuality")) return this.cache.getStale<AirQualityData>("airQuality");
    try {
      const { lat, lon, timezone } = this.config;
      const tz = encodeURIComponent(timezone);
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen&timezone=${tz}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn(`Open-Meteo air quality returned ${res.status}`);
        this.armBackoff("airQuality", res);
        return this.cache.getStale<AirQualityData>("airQuality");
      }
      const raw = await res.json() as Record<string, unknown>;
      const parsed = parseAirQualityResponse(raw);
      this.cache.set("airQuality", parsed, TTL.airQuality);
      return parsed;
    } catch (err) {
      log.error(`Air quality fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("airQuality");
      return this.cache.getStale<AirQualityData>("airQuality");
    }
  }

  private async fetchSunTimes(): Promise<SunTimesData | null> {
    const cached = this.cache.get<SunTimesData>("sunTimes");
    if (cached) return cached;
    if (this.cache.inCooldown("sunTimes")) return this.cache.getStale<SunTimesData>("sunTimes");
    try {
      const { lat, lon } = this.config;
      const today = new Date().toISOString().split("T")[0];
      const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&formatted=0&date=${today}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn(`Sunrise-sunset returned ${res.status}`);
        this.armBackoff("sunTimes", res);
        return this.cache.getStale<SunTimesData>("sunTimes");
      }
      const raw = await res.json() as { status: string; results: Record<string, string> };
      if (raw.status !== "OK") { this.armBackoff("sunTimes"); return this.cache.getStale<SunTimesData>("sunTimes"); }
      const parsed = parseSunTimesResponse(raw.results);
      this.cache.set("sunTimes", parsed, TTL.sunTimes);
      return parsed;
    } catch (err) {
      log.error(`Sun times fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("sunTimes");
      return this.cache.getStale<SunTimesData>("sunTimes");
    }
  }

  private async fetchCurrency(): Promise<CurrencyData | null> {
    const cached = this.cache.get<CurrencyData>("currency");
    if (cached) return cached;
    if (this.cache.inCooldown("currency")) return this.cache.getStale<CurrencyData>("currency");
    try {
      const url = `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${this.config.currencies}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn(`Frankfurter returned ${res.status}`);
        this.armBackoff("currency", res);
        return this.cache.getStale<CurrencyData>("currency");
      }
      const raw = await res.json() as { base: string; date: string; rates: Record<string, number> };

      // Build cross rate pairs from EUR base rates
      const pairs: CurrencyPair[] = [];
      const codes = Object.keys(raw.rates);
      // EUR → each currency
      for (const code of codes) {
        pairs.push({ from: "EUR", to: code, rate: raw.rates[code]! });
      }
      // Cross rates between non-EUR currencies (e.g. USD/GBP = EUR_GBP / EUR_USD)
      for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) {
          const a = codes[i]!;
          const b = codes[j]!;
          const rateA = raw.rates[a]!;
          const rateB = raw.rates[b]!;
          pairs.push({ from: a, to: b, rate: rateB / rateA });
        }
      }

      const parsed: CurrencyData = { base: raw.base, date: raw.date, rates: raw.rates, pairs };
      this.cache.set("currency", parsed, TTL.currency);
      return parsed;
    } catch (err) {
      log.error(`Currency fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("currency");
      return this.cache.getStale<CurrencyData>("currency");
    }
  }

  private async fetchCommodities(): Promise<CommodityData | null> {
    const cached = this.cache.get<CommodityData>("commodities");
    if (cached) return cached;
    if (this.cache.inCooldown("commodities")) return this.cache.getStale<CommodityData>("commodities");
    try {
      const symbols: Array<{ pair: string; name: string; unit: string }> = [
        { pair: "XAU/USD", name: "Gold",      unit: "oz" },
        { pair: "XAG/USD", name: "Silver",    unit: "oz" },
        { pair: "XPT/USD", name: "Platinum",  unit: "oz" },
        { pair: "XPD/USD", name: "Palladium", unit: "oz" },
        { pair: "OIL/USD", name: "Brent Oil", unit: "bbl" },
      ];

      const base = "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument";
      const fetches = symbols.map(async (s) => {
        const [from, to] = s.pair.split("/");
        const res = await fetch(`${base}/${from}/${to}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const data = await res.json() as Array<{
          spreadProfilePrices: Array<{ bid: number; ask: number }>;
        }>;
        if (!data.length || !data[0]!.spreadProfilePrices.length) return null;
        const sp = data[0]!.spreadProfilePrices[0]!;
        const mid = (sp.bid + sp.ask) / 2;
        return { symbol: s.pair, name: s.name, price: mid, unit: s.unit };
      });

      const results = await Promise.allSettled(fetches);
      const items: CommodityItem[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) items.push(r.value);
      }
      // Every per-symbol fetch failed (e.g. host rate-limited / down) — arm a
      // backoff so we don't retry all five on the next poll.
      if (items.length === 0) { this.armBackoff("commodities"); return this.cache.getStale<CommodityData>("commodities"); }

      const parsed: CommodityData = { items, fetchedAt: new Date().toISOString() };
      this.cache.set("commodities", parsed, TTL.commodities);
      return parsed;
    } catch (err) {
      log.error(`Commodities fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("commodities");
      return this.cache.getStale<CommodityData>("commodities");
    }
  }

  private async fetchEarthquakes(): Promise<EarthquakeData | null> {
    const cached = this.cache.get<EarthquakeData>("earthquakes");
    if (cached) return cached;
    if (this.cache.inCooldown("earthquakes")) return this.cache.getStale<EarthquakeData>("earthquakes");
    try {
      const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        log.warn(`USGS earthquakes returned ${res.status}`);
        this.armBackoff("earthquakes", res);
        return this.cache.getStale<EarthquakeData>("earthquakes");
      }
      const raw = await res.json() as { features: Array<{ properties: { mag: number; place: string; time: number; url: string } }> };
      const parsed: EarthquakeData = {
        quakes: raw.features.slice(0, 15).map((f) => ({
          magnitude: f.properties.mag,
          place: f.properties.place,
          time: f.properties.time,
          url: f.properties.url,
        })),
      };
      this.cache.set("earthquakes", parsed, TTL.earthquakes);
      return parsed;
    } catch (err) {
      log.error(`Earthquakes fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      this.armBackoff("earthquakes");
      return this.cache.getStale<EarthquakeData>("earthquakes");
    }
  }
}

// ── Response Parsers ──────────────────────────

function parseWeatherResponse(raw: Record<string, unknown>): WeatherData {
  const current = raw.current as Record<string, number>;
  const hourly = raw.hourly as Record<string, unknown[]>;
  const daily = raw.daily as Record<string, unknown[]>;

  const hourlyData: WeatherData["hourly"] = [];
  const hourlyTimes = (hourly.time ?? []) as string[];
  const hourlyTemps = (hourly.temperature_2m ?? []) as number[];
  const hourlyPrecip = (hourly.precipitation_probability ?? []) as number[];
  const hourlyCodes = (hourly.weather_code ?? []) as number[];
  for (let i = 0; i < Math.min(hourlyTimes.length, 24); i++) {
    hourlyData.push({
      time: hourlyTimes[i]!,
      temperature: hourlyTemps[i] ?? 0,
      precipitationProbability: hourlyPrecip[i] ?? 0,
      weatherCode: hourlyCodes[i] ?? 0,
    });
  }

  const dailyData: WeatherData["daily"] = [];
  const dailyDates = (daily.time ?? []) as string[];
  const dailyMax = (daily.temperature_2m_max ?? []) as number[];
  const dailyMin = (daily.temperature_2m_min ?? []) as number[];
  const dailyPrecipMax = (daily.precipitation_probability_max ?? []) as number[];
  const dailyCodes = (daily.weather_code ?? []) as number[];
  const dailyUv = (daily.uv_index_max ?? []) as number[];
  for (let i = 0; i < dailyDates.length; i++) {
    dailyData.push({
      date: dailyDates[i]!,
      tempMax: dailyMax[i] ?? 0,
      tempMin: dailyMin[i] ?? 0,
      precipitationProbabilityMax: dailyPrecipMax[i] ?? 0,
      weatherCode: dailyCodes[i] ?? 0,
      uvIndexMax: dailyUv[i] ?? 0,
    });
  }

  return {
    current: {
      temperature: current.temperature_2m ?? 0,
      feelsLike: current.apparent_temperature ?? 0,
      humidity: current.relative_humidity_2m ?? 0,
      windSpeed: current.wind_speed_10m ?? 0,
      windDirection: current.wind_direction_10m ?? 0,
      weatherCode: current.weather_code ?? 0,
      uvIndex: current.uv_index ?? 0,
    },
    hourly: hourlyData,
    daily: dailyData,
  };
}

function parseAirQualityResponse(raw: Record<string, unknown>): AirQualityData {
  const current = raw.current as Record<string, number>;
  return {
    europeanAqi: current.european_aqi ?? 0,
    pm25: current.pm2_5 ?? 0,
    pm10: current.pm10 ?? 0,
    ozone: current.ozone ?? 0,
    no2: current.nitrogen_dioxide ?? 0,
    pollen: {
      alder: current.alder_pollen ?? 0,
      birch: current.birch_pollen ?? 0,
      grass: current.grass_pollen ?? 0,
      mugwort: current.mugwort_pollen ?? 0,
    },
  };
}

function parseSunTimesResponse(results: Record<string, string>): SunTimesData {
  const sunrise = new Date(results.sunrise);
  const sunset = new Date(results.sunset);
  const dayLengthMs = sunset.getTime() - sunrise.getTime();
  const dayLengthHours = dayLengthMs / 3_600_000;

  // Yesterday's day length estimate for trend
  const yesterday = new Date(Date.now() - 86_400_000);
  const doy = getDayOfYear(new Date());
  const doyYesterday = getDayOfYear(yesterday);
  // Approximate: in northern hemisphere, days get longer from winter to summer solstice
  // Simple estimate: ~2.5 min change per day near equinox, less near solstice
  const trendMinutes = doy > doyYesterday ? estimateDayLengthChange(doy, 52.37) : 0;

  const sunriseStr = sunrise.toISOString();
  const sunsetStr = sunset.toISOString();

  return {
    sunrise: sunriseStr,
    sunset: sunsetStr,
    dayLength: Math.round(dayLengthHours * 100) / 100,
    goldenHourMorning: {
      start: sunriseStr,
      end: new Date(sunrise.getTime() + 3_600_000).toISOString(),
    },
    goldenHourEvening: {
      start: new Date(sunset.getTime() - 3_600_000).toISOString(),
      end: sunsetStr,
    },
    dayLengthTrend: trendMinutes,
  };
}

// ── Local Calculations ────────────────────────

export function computeMoonPhase(date: Date): MoonPhaseData {
  // Reference: Jan 6, 2000 was a new moon
  const refNew = new Date(2000, 0, 6, 18, 14, 0);
  const diffDays = (date.getTime() - refNew.getTime()) / 86_400_000;
  const synodicPeriod = 29.53058867;
  const age = ((diffDays % synodicPeriod) + synodicPeriod) % synodicPeriod;
  const illumination = Math.round((1 - Math.cos((2 * Math.PI * age) / synodicPeriod)) / 2 * 100);

  let phase: string;
  let emoji: string;
  if (age < 1.85) { phase = "New Moon"; emoji = "\u{1F311}"; }
  else if (age < 7.38) { phase = "Waxing Crescent"; emoji = "\u{1F312}"; }
  else if (age < 9.23) { phase = "First Quarter"; emoji = "\u{1F313}"; }
  else if (age < 14.77) { phase = "Waxing Gibbous"; emoji = "\u{1F314}"; }
  else if (age < 16.61) { phase = "Full Moon"; emoji = "\u{1F315}"; }
  else if (age < 22.15) { phase = "Waning Gibbous"; emoji = "\u{1F316}"; }
  else if (age < 23.99) { phase = "Last Quarter"; emoji = "\u{1F317}"; }
  else if (age < 27.68) { phase = "Waning Crescent"; emoji = "\u{1F318}"; }
  else { phase = "New Moon"; emoji = "\u{1F311}"; }

  return { phase, illumination, emoji, age: Math.round(age * 10) / 10 };
}

export function computeWorldClocks(timezones: string[]): WorldClock[] {
  const now = new Date();
  return timezones.map((tz) => {
    const fmt = getDtf("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const offsetFmt = getDtf("en-GB", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    });
    const parts = offsetFmt.formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    const city = tz.split("/").pop()!.replace(/_/g, " ");
    return {
      timezone: tz,
      city,
      time: fmt.format(now),
      offset: offsetPart?.value ?? tz,
    };
  });
}

export function computeHolidays(): Holiday[] {
  const now = new Date();
  const year = now.getFullYear();
  const nextYear = year + 1;

  const easterDate = computeEaster(year);
  const easterNext = computeEaster(nextYear);

  const allHolidays = [
    ...getHolidaysForYear(year, easterDate),
    ...getHolidaysForYear(nextYear, easterNext),
  ];

  const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return allHolidays
    .map((h) => {
      const hMs = new Date(h.date).getTime();
      return { ...h, daysUntil: Math.round((hMs - todayMs) / 86_400_000) };
    })
    .filter((h) => h.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 8);
}

function getHolidaysForYear(year: number, easter: Date): Array<{ name: string; date: string }> {
  const fmt = (d: Date) => d.toISOString().split("T")[0]!;
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

  return [
    { name: "Nieuwjaarsdag", date: `${year}-01-01` },
    { name: "Koningsdag", date: `${year}-04-27` },
    { name: "Bevrijdingsdag", date: `${year}-05-05` },
    { name: "Kerst", date: `${year}-12-25` },
    { name: "Tweede Kerstdag", date: `${year}-12-26` },
    { name: "Goede Vrijdag", date: fmt(addDays(easter, -2)) },
    { name: "Pasen", date: fmt(easter) },
    { name: "Tweede Paasdag", date: fmt(addDays(easter, 1)) },
    { name: "Hemelvaart", date: fmt(addDays(easter, 39)) },
    { name: "Pinksteren", date: fmt(addDays(easter, 49)) },
    { name: "Tweede Pinksterdag", date: fmt(addDays(easter, 50)) },
  ];
}

export function computeEaster(year: number): Date {
  const cached = easterCache.get(year);
  if (cached) return cached;
  // Gauss/Anonymous Gregorian algorithm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const result = new Date(year, month, day);
  easterCache.set(year, result);
  return result;
}

export function getDailyQuote(): { text: string; author: string } {
  const quotes = [
    { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" },
    { text: "In the middle of difficulty lies opportunity.", author: "Albert Einstein" },
    { text: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci" },
    { text: "The best time to plant a tree was 20 years ago. The second best time is now.", author: "Chinese Proverb" },
    { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius" },
    { text: "Be the change that you wish to see in the world.", author: "Mahatma Gandhi" },
    { text: "Not everything that is faced can be changed, but nothing can be changed until it is faced.", author: "James Baldwin" },
    { text: "What we think, we become.", author: "Buddha" },
    { text: "The mind is everything. What you think you become.", author: "Buddha" },
    { text: "An unexamined life is not worth living.", author: "Socrates" },
    { text: "The only impossible journey is the one you never begin.", author: "Tony Robbins" },
    { text: "Life is what happens when you're busy making other plans.", author: "John Lennon" },
    { text: "The purpose of our lives is to be happy.", author: "Dalai Lama" },
    { text: "You only live once, but if you do it right, once is enough.", author: "Mae West" },
    { text: "Many of life's failures are people who did not realize how close they were to success when they gave up.", author: "Thomas Edison" },
    { text: "Tell me and I forget. Teach me and I remember. Involve me and I learn.", author: "Benjamin Franklin" },
    { text: "The greatest glory in living lies not in never falling, but in rising every time we fall.", author: "Nelson Mandela" },
    { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
    { text: "If life were predictable it would cease to be life, and be without flavor.", author: "Eleanor Roosevelt" },
    { text: "Spread love everywhere you go. Let no one ever come to you without leaving happier.", author: "Mother Teresa" },
    { text: "When you reach the end of your rope, tie a knot in it and hang on.", author: "Abraham Lincoln" },
    { text: "Always remember that you are absolutely unique. Just like everyone else.", author: "Margaret Mead" },
    { text: "The future belongs to those who believe in the beauty of their dreams.", author: "Eleanor Roosevelt" },
    { text: "It is during our darkest moments that we must focus to see the light.", author: "Aristotle" },
    { text: "Whoever is happy will make others happy too.", author: "Anne Frank" },
    { text: "Do not go where the path may lead, go instead where there is no path and leave a trail.", author: "Ralph Waldo Emerson" },
    { text: "You must be the change you wish to see in the world.", author: "Mahatma Gandhi" },
    { text: "In three words I can sum up everything I've learned about life: it goes on.", author: "Robert Frost" },
    { text: "The only limit to our realization of tomorrow will be our doubts of today.", author: "Franklin D. Roosevelt" },
    { text: "It is never too late to be what you might have been.", author: "George Eliot" },
    { text: "Everything you've ever wanted is on the other side of fear.", author: "George Addair" },
    { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
    { text: "I have not failed. I've just found 10,000 ways that won't work.", author: "Thomas Edison" },
    { text: "A person who never made a mistake never tried anything new.", author: "Albert Einstein" },
    { text: "What you get by achieving your goals is not as important as what you become by achieving your goals.", author: "Zig Ziglar" },
    { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
    { text: "I find that the harder I work, the more luck I seem to have.", author: "Thomas Jefferson" },
    { text: "Everything has beauty, but not everyone sees it.", author: "Confucius" },
    { text: "The best revenge is massive success.", author: "Frank Sinatra" },
    { text: "Life shrinks or expands in proportion to one's courage.", author: "Anaïs Nin" },
    { text: "We may encounter many defeats but we must not be defeated.", author: "Maya Angelou" },
    { text: "Happiness is not something ready made. It comes from your own actions.", author: "Dalai Lama" },
    { text: "The only person you are destined to become is the person you decide to be.", author: "Ralph Waldo Emerson" },
    { text: "Go confidently in the direction of your dreams! Live the life you've imagined.", author: "Henry David Thoreau" },
    { text: "When I let go of what I am, I become what I might be.", author: "Lao Tzu" },
    { text: "Act as if what you do makes a difference. It does.", author: "William James" },
    { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
    { text: "Don't give up — that is what life is: continuing the journey, chasing your dreams.", author: "Mario Benedetti" },
    { text: "There are those who fight for a day, and they are good. There are those who fight for many days, and they are very good. But there are those who fight their whole lives: those are the indispensable ones.", author: "Bertolt Brecht" },
    { text: "Wanderer, there is no road; the road is made by walking.", author: "Antonio Machado" },
  ];
  const dayOfYear = getDayOfYear(new Date());
  return quotes[dayOfYear % quotes.length]!;
}

// ── Helpers ───────────────────────────────────

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

function estimateDayLengthChange(dayOfYear: number, latitude: number): number {
  // Approximate daily change in day length in minutes
  // Maximum change near equinoxes (~80-82 and ~264-266), minimum near solstices
  const angle = (2 * Math.PI * (dayOfYear - 80)) / 365;
  // At 52°N latitude, max change is about 4.5 min/day
  const maxChange = latitude * 0.086;
  return Math.round(-maxChange * Math.sin(angle) * 10) / 10;
}
