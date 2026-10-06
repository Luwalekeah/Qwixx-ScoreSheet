import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from '@/lib/test/fakeSupabase';

const fakeDb = new FakeSupabase();

vi.mock('@/lib/supabase/server', () => ({ db: fakeDb }));

const { POST } = await import('./route');

function makeRequest(body: unknown, cookie?: string): Request {
  return new Request('http://localhost/api/games', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callCreate(body: unknown, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await POST(makeRequest(body, cookie));
  const json = await res.json();
  return { status: res.status, json };
}

beforeEach(() => {
  fakeDb.tables = {};
  fakeDb.rpcHandlers = {
    consume_rate_limit: () => 1, // plenty of headroom by default
  };
});

describe('POST /api/games (finding S1)', () => {
  it('creates a game for an unauthenticated caller under the rate limit', async () => {
    const { status, json } = await callCreate({ displayName: 'Dan' });

    expect(status).toBe(201);
    expect(json.seat).toBe(1);
    expect(fakeDb.tables.players).toHaveLength(1);
    expect(fakeDb.tables.games).toHaveLength(1);
  });

  it('rejects game creation once the per-IP rate limit is exceeded, before any row is created', async () => {
    fakeDb.rpcHandlers.consume_rate_limit = () => 999; // far over CREATE_IP_LIMIT (5)

    const { status, json } = await callCreate({ displayName: 'Dan' });

    expect(status).toBe(429);
    expect(json.error).toBe('rate_limited');
    // The whole point of finding S1: no players/games/game_players/sheets
    // rows are committed once the caller is throttled.
    expect(fakeDb.tables.players ?? []).toHaveLength(0);
    expect(fakeDb.tables.games ?? []).toHaveLength(0);
  });
});
