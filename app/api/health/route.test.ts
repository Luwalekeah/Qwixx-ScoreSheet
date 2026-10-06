import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

// Regression test for finding B2: /api/health must fail when configuration
// is invalid, without ever touching the database (no mock of
// lib/supabase/server is set up in this file -- if the route imported it,
// this test would throw on missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// before it even got to an assertion).

const KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'QWIXX_COOKIE_SECRET', 'QWIXX_IP_HASH_SECRET'] as const;
const snapshot: Record<string, string | undefined> = {};
for (const k of KEYS) snapshot[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

describe('GET /api/health', () => {
  it('returns 200 ok when configuration is valid', async () => {
    process.env.SUPABASE_URL = 'http://supabase-kong.supabase.svc.cluster.local:8000';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a'.repeat(40);
    process.env.QWIXX_COOKIE_SECRET = 'b'.repeat(40);
    process.env.QWIXX_IP_HASH_SECRET = 'c'.repeat(40);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 503 when a required secret is missing, instead of reporting healthy', async () => {
    process.env.SUPABASE_URL = 'http://supabase-kong.supabase.svc.cluster.local:8000';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a'.repeat(40);
    delete process.env.QWIXX_COOKIE_SECRET;
    process.env.QWIXX_IP_HASH_SECRET = 'c'.repeat(40);

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('error');
  });
});
