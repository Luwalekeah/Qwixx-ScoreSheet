// Helpers for route handler tests: build real, correctly-signed cookies
// (and let tests deliberately tamper with them) without duplicating the
// signing logic from lib/cookies.ts.
import {
  signCookie,
  DEVICE_COOKIE_NAME,
  SEAT_COOKIE_NAME,
  type DeviceCookiePayload,
  type SeatCookiePayload,
} from '@/lib/cookies';

export function cookieHeader(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export function deviceCookiePair(payload: DeviceCookiePayload): [string, string] {
  return [DEVICE_COOKIE_NAME, signCookie(payload)];
}

export function seatCookiePair(payload: SeatCookiePayload): [string, string] {
  return [SEAT_COOKIE_NAME, signCookie(payload)];
}

/** Flips the last character of a signed cookie value, invalidating its signature. */
export function tamper(value: string): string {
  return value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');
}
