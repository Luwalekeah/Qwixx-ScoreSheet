import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from '@/lib/test/fakeSupabase';

const fakeDb = new FakeSupabase();

vi.mock('@/lib/supabase/server', () => ({ db: fakeDb }));

const { POST } = await import('./route');

function seedGame(opts: { id: string; joinCode: string; status: 'lobby' | 'active' | 'ended' }): void {
  fakeDb.tables.games ??= [];
  fakeDb.tables.games.push({ id: opts.id, join_code: opts.joinCode, status: opts.status });
}

function makeRequest(body: unknown, cookie?: string): Request {
  return new Request('http://localhost/api/games/join', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callJoin(body: unknown, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await POST(makeRequest(body, cookie));
  const json = await res.json();
  return { status: res.status, json };
}

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

beforeEach(() => {
  fakeDb.tables = {};
  fakeDb.rpcHandlers = {
    consume_rate_limit: () => 1, // plenty of headroom by default
  };
});

describe('join route', () => {
  it('refuses a late join to a game whose status is active', async () => {
    const gameId = uid('game');
    seedGame({ id: gameId, joinCode: 'ABCDEF', status: 'active' });

    const { status, json } = await callJoin({ code: 'ABCDEF', displayName: 'Dan' });

    expect(status).toBe(409);
    expect(json.error).toBe('wrong_status');
  });

  it('refuses joining a game whose status is ended (treated as not found)', async () => {
    const gameId = uid('game');
    seedGame({ id: gameId, joinCode: 'GHJKMN', status: 'ended' });

    const { status, json } = await callJoin({ code: 'GHJKMN', displayName: 'Dan' });

    expect(status).toBe(404);
    expect(json.error).toBe('game_not_found');
  });

  it('allows joining a lobby game and issues a seat cookie', async () => {
    const gameId = uid('game');
    seedGame({ id: gameId, joinCode: 'PQRSTV', status: 'lobby' });

    const { status, json } = await callJoin({ code: 'PQRSTV', displayName: 'Dan' });

    expect(status).toBe(200);
    expect(json.status).toBe('lobby');
    expect(json.seat).toBe(1);
  });

  it('rejects joining once the per-IP rate limit is exceeded', async () => {
    const gameId = uid('game');
    seedGame({ id: gameId, joinCode: 'PQRSTW', status: 'lobby' });
    fakeDb.rpcHandlers.consume_rate_limit = () => 999; // far over IP_LIMIT (10)

    const { status, json } = await callJoin({ code: 'PQRSTW', displayName: 'Dan' });

    expect(status).toBe(429);
    expect(json.error).toBe('rate_limited');
  });
});
