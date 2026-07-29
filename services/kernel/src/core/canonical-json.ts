/**
 * Canonical JSON for cross-language hash + signature stability.
 *
 * Mirrors `crates/mtw-attest/src/canonical.rs` byte-for-byte. The whole
 * point is that signing the same logical payload from the Rust server
 * and verifying it from a TS client (or vice versa) produces the same
 * bytes off the wire.
 *
 * ## Rules (must match Rust exactly)
 *
 *   * Object keys sorted lexicographically by UTF-8 code units (= byte
 *     order for ASCII, code-unit order for the rest — JS strings are
 *     UTF-16, so `< >` is already code-unit comparison).
 *   * Numbers serialised via `JSON.stringify` (integers print without
 *     a decimal; floats use the shortest round-trippable form).
 *   * Strings escaped per RFC 8259: `\\`, `\"`, `\n`, `\r`, `\t`,
 *     `\b`, `\f`, `\u00XX` for control chars; non-ASCII printable
 *     pass through as UTF-8 bytes.
 *   * Arrays preserve order; empty containers are `[]` / `{}`.
 *   * No whitespace, no trailing newline.
 *
 * ## What this is NOT
 *
 * Not RFC 8785 — that one normalises numbers more aggressively
 * (always trailing zeros, no exponent). We stay closer to native JSON
 * to make the canonicaliser tiny and the Rust implementation trivial.
 */

export function canonicalize(value: unknown): Uint8Array {
  const out: number[] = [];
  write(out, value);
  return new Uint8Array(out);
}

/** Convenience: canonicalize and decode as UTF-8 string. */
export function canonicalString(value: unknown): string {
  return new TextDecoder().decode(canonicalize(value));
}

function write(out: number[], value: unknown): void {
  if (value === null) {
    pushAscii(out, "null");
    return;
  }
  if (value === true) {
    pushAscii(out, "true");
    return;
  }
  if (value === false) {
    pushAscii(out, "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite numbers are not valid JSON");
    }
    pushAscii(out, JSON.stringify(value));
    return;
  }
  if (typeof value === "bigint") {
    // BigInt has no JSON spec; we serialise as a base-10 integer string,
    // which matches what Rust's serde_json::Number with arbitrary
    // precision would produce.
    pushAscii(out, value.toString());
    return;
  }
  if (typeof value === "string") {
    writeString(out, value);
    return;
  }
  if (Array.isArray(value)) {
    out.push(0x5b); // '['
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(0x2c); // ','
      // Per JSON.stringify semantics, `undefined` and functions in array
      // positions become `null` so the array's length is preserved.
      const elem = value[i];
      if (elem === undefined || typeof elem === "function") {
        pushAscii(out, "null");
      } else {
        write(out, elem);
      }
    }
    out.push(0x5d); // ']'
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Match JSON.stringify: keys whose values are `undefined` (or
    // functions) are omitted from the output entirely. Crucially, this
    // preserves byte-identical output with the Rust side, where a
    // `Some(None)` would simply not appear in `serde_json::to_value`.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
      .sort();
    out.push(0x7b); // '{'
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(0x2c);
      writeString(out, keys[i]);
      out.push(0x3a); // ':'
      write(out, obj[keys[i]]);
    }
    out.push(0x7d); // '}'
    return;
  }
  // Top-level `undefined` / function still throws — mirrors `JSON.stringify(undefined) === undefined`.
  throw new Error(`canonicalize: unsupported value type ${typeof value}`);
}

function writeString(out: number[], s: string): void {
  out.push(0x22); // '"'
  // Iterate by JS code unit but step over surrogate pairs in one shot.
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: pushAscii(out, "\\\""); i++; continue;
      case 0x5c: pushAscii(out, "\\\\"); i++; continue;
      case 0x0a: pushAscii(out, "\\n"); i++; continue;
      case 0x0d: pushAscii(out, "\\r"); i++; continue;
      case 0x09: pushAscii(out, "\\t"); i++; continue;
      case 0x08: pushAscii(out, "\\b"); i++; continue;
      case 0x0c: pushAscii(out, "\\f"); i++; continue;
    }
    if (c < 0x20) {
      pushAscii(out, `\\u${c.toString(16).padStart(4, "0")}`);
      i++;
      continue;
    }
    if (c < 0x80) {
      out.push(c);
      i++;
      continue;
    }
    if (c < 0x800) {
      out.push(0xc0 | (c >> 6));
      out.push(0x80 | (c & 0x3f));
      i++;
      continue;
    }
    // Surrogate pair → one 4-byte UTF-8 sequence.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + (((c - 0xd800) << 10) | (low - 0xdc00));
        out.push(0xf0 | (cp >> 18));
        out.push(0x80 | ((cp >> 12) & 0x3f));
        out.push(0x80 | ((cp >> 6) & 0x3f));
        out.push(0x80 | (cp & 0x3f));
        i += 2;
        continue;
      }
    }
    // BMP non-surrogate (or unpaired surrogate — emit as best-effort 3-byte).
    out.push(0xe0 | (c >> 12));
    out.push(0x80 | ((c >> 6) & 0x3f));
    out.push(0x80 | (c & 0x3f));
    i++;
  }
  out.push(0x22);
}

function pushAscii(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
}
