import { describe, expect, it } from 'vitest';
import {
  signCookie,
  verifyCookie,
  DEVICE_COOKIE_MAX_AGE,
  SEAT_COOKIE_MAX_AGE,
  type DeviceCookiePayload,
} from './cookies';

// Regression tests for finding S4: iat was written into every cookie
// payload but never read, so a captured cookie replayed with the header set
// directly stayed valid forever regardless of the Max-Age the browser was
// told to honour.

describe('verifyCookie expiry (finding S4)', () => {
  it('accepts a freshly-issued cookie', () => {
    const now = Math.floor(Date.now() / 1000);
    const value = signCookie({ pid: 'p1', iat: now } satisfies DeviceCookiePayload);

    const result = verifyCookie<DeviceCookiePayload>(value, DEVICE_COOKIE_MAX_AGE);

    expect(result).toEqual({ pid: 'p1', iat: now });
  });

  it('rejects a cookie whose iat is older than the max age, even though the signature is valid', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredIat = now - DEVICE_COOKIE_MAX_AGE - 60;
    const value = signCookie({ pid: 'p1', iat: expiredIat } satisfies DeviceCookiePayload);

    const result = verifyCookie<DeviceCookiePayload>(value, DEVICE_COOKIE_MAX_AGE);

    expect(result).toBeNull();
  });

  it('accepts a cookie right at the max-age boundary and rejects one just past it', () => {
    const now = Math.floor(Date.now() / 1000);

    const atBoundary = signCookie({ pid: 'p1', iat: now - SEAT_COOKIE_MAX_AGE } satisfies DeviceCookiePayload);
    expect(verifyCookie<DeviceCookiePayload>(atBoundary, SEAT_COOKIE_MAX_AGE)).not.toBeNull();

    const pastBoundary = signCookie({ pid: 'p1', iat: now - SEAT_COOKIE_MAX_AGE - 1 } satisfies DeviceCookiePayload);
    expect(verifyCookie<DeviceCookiePayload>(pastBoundary, SEAT_COOKIE_MAX_AGE)).toBeNull();
  });

  it('rejects a forward-dated (clock-skewed beyond tolerance) payload', () => {
    const now = Math.floor(Date.now() / 1000);
    const value = signCookie({ pid: 'p1', iat: now + 3600 } satisfies DeviceCookiePayload);

    const result = verifyCookie<DeviceCookiePayload>(value, DEVICE_COOKIE_MAX_AGE);

    expect(result).toBeNull();
  });

  it('rejects a payload with no iat field at all', () => {
    const value = signCookie({ pid: 'p1' });

    const result = verifyCookie<DeviceCookiePayload>(value, DEVICE_COOKIE_MAX_AGE);

    expect(result).toBeNull();
  });

  it('a device cookie just past the 7-day seat window is still valid under the 2-year device max age', () => {
    // The two cookie types carry genuinely different windows; verifyCookie
    // must apply whichever maxAgeSeconds the caller passes, not a shared
    // default.
    const now = Math.floor(Date.now() / 1000);
    const iat = now - SEAT_COOKIE_MAX_AGE - 3600; // just past the 7-day seat window
    const value = signCookie({ pid: 'p1', iat } satisfies DeviceCookiePayload);

    expect(verifyCookie<DeviceCookiePayload>(value, SEAT_COOKIE_MAX_AGE)).toBeNull();
    expect(verifyCookie<DeviceCookiePayload>(value, DEVICE_COOKIE_MAX_AGE)).not.toBeNull();
  });
});
