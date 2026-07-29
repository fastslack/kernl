/**
 * Parse the raw Google Flights response into structured `FlightResult`s.
 *
 * The endpoint returns a JSON document prefixed with the anti-CSRF
 * sentinel `)]}'`. After stripping that, the layout is:
 *
 *   outer[0][2]      → JSON-encoded shopping payload (string)
 *   shopping[2..3]   → arrays of flight blocks (top + alt offers); each
 *                      block[0] holds the flight rows themselves.
 *
 * Per row (`data`):
 *   data[0][9]       → total duration (minutes)
 *   data[0][2]       → list of legs
 *   data[1][0][-1]   → numeric price
 *   data[1][1]       → price token containing a currency code
 *
 * Per leg (`fl`):
 *   fl[3]            → departure IATA
 *   fl[6]            → arrival IATA
 *   fl[8]            → departure time [hour, minute]
 *   fl[10]           → arrival time   [hour, minute]
 *   fl[11]           → leg duration (minutes)
 *   fl[20]           → departure date [year, month, day]
 *   fl[21]           → arrival date   [year, month, day]
 *   fl[22]           → [airline IATA, flight number]
 *
 * Indices verified against `fli/search/flights.py`. Don't reorder.
 */

import type { FlightLeg, FlightResult } from "./types.js";

/**
 * Strip Google's anti-CSRF prefix `)]}'` (and any leading whitespace) and
 * parse the rest as JSON. Throws if the body is empty or malformed.
 */
export function stripAntiCsrf(body: string): unknown {
  let s = body;
  if (s.startsWith(")]}'")) s = s.slice(4);
  s = s.replace(/^\s+/, "");
  return JSON.parse(s);
}

export function parseSearchResponse(body: string): FlightResult[] {
  const root = stripAntiCsrf(body) as unknown[];
  if (!Array.isArray(root) || !Array.isArray(root[0])) return [];
  const shoppingStr = (root[0] as unknown[])[2];
  if (typeof shoppingStr !== "string" || !shoppingStr) return [];
  const shopping = JSON.parse(shoppingStr) as unknown[];

  const flights: FlightResult[] = [];
  for (const idx of [2, 3]) {
    const block = shopping[idx];
    if (!Array.isArray(block)) continue;
    const rows = block[0];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const parsed = parseRow(row as unknown[]);
      if (parsed) flights.push(parsed);
    }
  }
  return flights;
}

function parseRow(data: unknown[]): FlightResult | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const head = data[0] as unknown[];
  const legsRaw = head[2];
  const duration = typeof head[9] === "number" ? head[9] : 0;
  if (!Array.isArray(legsRaw) || legsRaw.length === 0) return null;

  const { price, currency } = parsePriceBlock(data[1]);

  const legs: FlightLeg[] = [];
  for (const fl of legsRaw as unknown[]) {
    const leg = parseLeg(fl as unknown[]);
    if (leg) legs.push(leg);
  }
  if (legs.length === 0) return null;

  return {
    legs,
    price,
    currency,
    duration,
    stops: legs.length - 1,
  };
}

function parseLeg(fl: unknown[]): FlightLeg | null {
  if (!Array.isArray(fl)) return null;
  const depAirport = fl[3];
  const arrAirport = fl[6];
  const depTime = fl[8];
  const arrTime = fl[10];
  const legDuration = fl[11];
  const depDate = fl[20];
  const arrDate = fl[21];
  const carrier = fl[22];

  if (typeof depAirport !== "string" || typeof arrAirport !== "string") return null;
  if (!Array.isArray(carrier) || typeof carrier[0] !== "string") return null;

  const departureIso = combineDateTime(depDate, depTime);
  const arrivalIso = combineDateTime(arrDate, arrTime);
  if (!departureIso || !arrivalIso) return null;

  return {
    airline: carrier[0] as string,
    flight_number: String(carrier[1] ?? ""),
    departure_airport: depAirport,
    arrival_airport: arrAirport,
    departure_datetime: departureIso,
    arrival_datetime: arrivalIso,
    duration: typeof legDuration === "number" ? legDuration : 0,
  };
}

function combineDateTime(dateArr: unknown, timeArr: unknown): string | null {
  if (!Array.isArray(dateArr) || !Array.isArray(timeArr)) return null;
  const haveDate = dateArr.some((x) => x !== null && x !== undefined);
  const haveTime = timeArr.some((x) => x !== null && x !== undefined);
  if (!haveDate || !haveTime) return null;
  const [y, m, d] = [num(dateArr[0]), num(dateArr[1]), num(dateArr[2])];
  const [hh, mm] = [num(timeArr[0]), num(timeArr[1])];
  // Google returns local airport time, no offset. Emit a plain ISO-like
  // string (no Z) so callers can distinguish naive timestamps from UTC.
  const iso = `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:00`;
  return iso;
}

function parsePriceBlock(block: unknown): { price: number; currency: string | null } {
  let price = 0;
  let currency: string | null = null;
  if (Array.isArray(block)) {
    const priceArr = block[0];
    if (Array.isArray(priceArr) && priceArr.length > 0) {
      const last = priceArr[priceArr.length - 1];
      if (typeof last === "number") price = last;
      else if (typeof last === "string" && !Number.isNaN(parseFloat(last))) price = parseFloat(last);
    }
    if (block.length > 1) {
      currency = extractCurrencyCode(block[1]);
    }
  }
  return { price, currency };
}

/**
 * Extract the ISO currency code from Google's "price token". The token
 * is a URL-safe base64-encoded protobuf message; the currency lives at
 * field 3 → nested field 3 (length-delimited UTF-8 string).
 *
 * Direct port of `fli/core/currency.py::extract_currency_from_price_token`.
 * Returns null on any decode error so callers can fall back gracefully.
 */
function extractCurrencyCode(token: unknown): string | null {
  if (typeof token !== "string" || token.length === 0) return null;
  try {
    const bytes = decodeUrlsafeBase64(token);
    return readCurrencyFromMessage(bytes);
  } catch {
    return null;
  }
}

function decodeUrlsafeBase64(token: string): Uint8Array {
  let s = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (s.length % 4)) % 4;
  s += "=".repeat(pad);
  // Buffer is available in Node + Bun; encoded data is already URL-safe-cleaned.
  return Uint8Array.from(Buffer.from(s, "base64"));
}

function readVarint(data: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, offset];
    shift += 7;
    if (shift >= 64) throw new Error("varint too large");
  }
  throw new Error("unexpected end of data while reading varint");
}

function readLengthDelimited(data: Uint8Array, offset: number): [Uint8Array, number] {
  const [length, after] = readVarint(data, offset);
  const end = after + length;
  if (end > data.length) throw new Error("length-delimited field exceeds payload");
  return [data.subarray(after, end), end];
}

function skipField(data: Uint8Array, offset: number, wireType: number): number {
  if (wireType === 0) return readVarint(data, offset)[1];
  if (wireType === 1) {
    if (offset + 8 > data.length) throw new Error("fixed64 overflow");
    return offset + 8;
  }
  if (wireType === 2) return readLengthDelimited(data, offset)[1];
  if (wireType === 5) {
    if (offset + 4 > data.length) throw new Error("fixed32 overflow");
    return offset + 4;
  }
  throw new Error(`unsupported wire type: ${wireType}`);
}

function readCurrencyFromMessage(data: Uint8Array): string | null {
  let offset = 0;
  while (offset < data.length) {
    const [tag, after] = readVarint(data, offset);
    offset = after;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNumber === 3 && wireType === 2) {
      const [nested, nextOffset] = readLengthDelimited(data, offset);
      offset = nextOffset;
      let inner = 0;
      while (inner < nested.length) {
        const [nestedTag, afterTag] = readVarint(nested, inner);
        inner = afterTag;
        const nestedField = nestedTag >>> 3;
        const nestedWire = nestedTag & 0x07;
        if (nestedField === 3 && nestedWire === 2) {
          const [bytes] = readLengthDelimited(nested, inner);
          return new TextDecoder("utf-8").decode(bytes).toUpperCase();
        }
        inner = skipField(nested, inner, nestedWire);
      }
      continue;
    }
    offset = skipField(data, offset, wireType);
  }
  return null;
}

function num(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

function pad(n: number, width: number): string {
  const s = String(Math.max(0, Math.trunc(n)));
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}
