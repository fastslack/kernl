import { createHmac } from "node:crypto";

interface JwtPayload {
  sub: string;        // user ID
  username: string;
  role: string;
  iat: number;        // issued at (epoch seconds)
  exp: number;        // expiry (epoch seconds)
}

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf-8");
}

/** Sign a JWT token */
export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">, secret: string, expiresInSeconds = 86400): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const body = base64url(JSON.stringify(fullPayload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/** Verify and decode a JWT token. Returns payload or null if invalid/expired. */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");

  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(base64urlDecode(body!)) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch {
    return null;
  }
}
