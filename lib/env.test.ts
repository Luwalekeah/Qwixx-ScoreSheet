import { afterEach, describe, expect, it } from 'vitest';
import { assertConfigValid, configErrors } from './env';

// Regression tests for finding B2: a missing or placeholder secret must be
// caught eagerly, not on first use inside a request handler.

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'QWIXX_COOKIE_SECRET', 'QWIXX_IP_HASH_SECRET'] as const;

// vitest.config.ts sets QWIXX_COOKIE_SECRET/QWIXX_IP_HASH_SECRET globally
// for every test. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set at
// all, matching production where the app-layer code never touches Supabase
// directly. Snapshot and restore around every test that mutates process.env.
const snapshot: Record<string, string | undefined> = {};

afterEach(() => {
  for (const name of REQUIRED) {
    if (snapshot[name] === undefined) delete process.env[name];
    else process.env[name] = snapshot[name];
  }
});

function setValid() {
  process.env.SUPABASE_URL = 'http://supabase-kong.supabase.svc.cluster.local:8000';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'a'.repeat(40);
  process.env.QWIXX_COOKIE_SECRET = 'b'.repeat(40);
  process.env.QWIXX_IP_HASH_SECRET = 'c'.repeat(40);
}

for (const name of REQUIRED) snapshot[name] = process.env[name];

describe('configErrors', () => {
  it('returns no errors when every secret is present, long enough, and not a placeholder', () => {
    setValid();
    expect(configErrors()).toEqual([]);
  });

  it('flags a missing secret', () => {
    setValid();
    delete process.env.QWIXX_IP_HASH_SECRET;
    const errors = configErrors();
    expect(errors.some((e) => e.includes('QWIXX_IP_HASH_SECRET'))).toBe(true);
  });

  it('flags a secret shorter than its floor', () => {
    setValid();
    process.env.QWIXX_COOKIE_SECRET = 'short';
    const errors = configErrors();
    expect(errors.some((e) => e.includes('QWIXX_COOKIE_SECRET'))).toBe(true);
  });

  it('flags the .env.example placeholder even when it clears the length floor', () => {
    setValid();
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'replace-me-with-a-real-32-byte-base64-secret';
    const errors = configErrors();
    expect(errors.some((e) => e.includes('SUPABASE_SERVICE_ROLE_KEY'))).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    setValid();
    delete process.env.QWIXX_COOKIE_SECRET;
    delete process.env.QWIXX_IP_HASH_SECRET;
    const errors = configErrors();
    expect(errors).toHaveLength(2);
  });
});

describe('assertConfigValid', () => {
  it('does not throw when configuration is valid', () => {
    setValid();
    expect(() => assertConfigValid()).not.toThrow();
  });

  it('throws, listing the missing variable, when configuration is invalid', () => {
    setValid();
    delete process.env.SUPABASE_URL;
    expect(() => assertConfigValid()).toThrow(/SUPABASE_URL/);
  });
});
