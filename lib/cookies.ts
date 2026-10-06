import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-SHA256 signing and verification for the two cookies. Hand-rolled because
// the payloads are two and three fields each and a JWT library would bring
// algorithm negotiation this project does not want.
//
// Format: <base64url(JSON.stringify(payload))>.<base64url(hmacSha256(secret, base64urlPayload))>

function getSecret(): string {
  const secret = process.env.QWIXX_COOKIE_SECRET;
  if (!secret) throw new Error('QWIXX_COOKIE_SECRET is required.');
  return secret;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function sign(payloadB64: string): string {
  const mac = createHmac('sha256', getSecret()).update(payloadB64).digest();
  return base64url(mac);
}

export function signCookie(payload: unknown): string {
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * maxAgeSeconds is not optional. `iat` has been written into every cookie
 * payload since the format was designed, but nothing ever read it: Max-Age
 * on the Set-Cookie header is a browser-side hint only, and an attacker
 * replaying a captured, still-correctly-signed cookie by setting the request
 * header directly stayed valid forever. Enforce the same window server-side.
 */
export function verifyCookie<T>(value: string | undefined | null, maxAgeSeconds: number): T | null {
  if (!value) return null;
  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1) return null;

  const payloadB64 = value.slice(0, lastDot);
  const providedSig = value.slice(lastDot + 1);
  const expectedSig = sign(payloadB64);

  const providedBuf = Buffer.from(providedSig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  let parsed: unknown;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const iat = (parsed as { iat?: unknown } | null)?.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - iat;
  // A little slack for clock skew; beyond that a negative age means a
  // forward-dated payload, which is just as invalid as an expired one.
  if (ageSeconds < -60 || ageSeconds > maxAgeSeconds) return null;

  return parsed as T;
}

export interface DeviceCookiePayload {
  pid: string;
  iat: number;
}

export interface SeatCookiePayload {
  gid: string;
  code: string;
  pid: string;
  seat: number;
  iat: number;
}

export const DEVICE_COOKIE_NAME = 'qx_device';
export const SEAT_COOKIE_NAME = 'qx_seat';

export const DEVICE_COOKIE_MAX_AGE = 63072000; // 2 years
export const SEAT_COOKIE_MAX_AGE = 604800; // 7 days

export function deviceCookieHeader(payload: DeviceCookiePayload): string {
  const value = signCookie(payload);
  return `${DEVICE_COOKIE_NAME}=${value}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function seatCookieHeader(payload: SeatCookiePayload): string {
  const value = signCookie(payload);
  return `${SEAT_COOKIE_NAME}=${value}; Path=/; Max-Age=${SEAT_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}
