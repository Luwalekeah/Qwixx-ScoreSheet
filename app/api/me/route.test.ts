import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from '@/lib/test/fakeSupabase';
import { cookieHeader, deviceCookiePair, seatCookiePair } from '@/lib/test/authHelpers';

const fakeDb = new FakeSupabase();

vi.mock('@/lib/supabase/server', () => ({ db: fakeDb }));

const { GET } = await import('./route');

function seedPlayer(id: string, displayName = 'Player'): void {
  fakeDb.tables.players ??= [];
  fakeDb.tables.players.push({ id, display_name: displayName });
}

function makeRequest(cookie?: string): Request {
  return new Request('http://localhost/api/me', {
    method: 'GET',
    headers: cookie ? { cookie } : {},
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callMe(cookie?: string): Promise<{ status: number; json: any }> {
  const res = await GET(makeRequest(cookie));
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
});

describe('GET /api/me (finding S1)', () => {
  it('never creates a players row: a caller with no device cookie gets a null identity', async () => {
    const { status, json } = await callMe();

    expect(status).toBe(200);
    expect(json.playerId).toBeNull();
    expect(json.displayName).toBeNull();
    expect(json.activeSeat).toBeNull();
    // The whole point: this GET, reachable by crawlers and link-preview
    // bots with no cookie at all, must not commit a row.
    expect(fakeDb.tables.players ?? []).toHaveLength(0);
  });

  it('returns the existing device identity for a caller with a valid device cookie, without creating a second row', async () => {
    const player = uid('player');
    seedPlayer(player, 'Dan');

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const cookie = cookieHeader({ [dName]: dVal });

    const { status, json } = await callMe(cookie);

    expect(status).toBe(200);
    expect(json.playerId).toBe(player);
    expect(json.displayName).toBe('Dan');
    expect(fakeDb.tables.players).toHaveLength(1);
  });

  it('reports the active seat for a valid seat cookie pointing at a lobby game', async () => {
    const player = uid('player');
    seedPlayer(player, 'Dan');
    const gameId = uid('game');
    fakeDb.tables.games ??= [];
    fakeDb.tables.games.push({ id: gameId, join_code: 'ABCDEF', status: 'lobby' });

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameId, code: 'ABCDEF', pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { json } = await callMe(cookie);

    expect(json.activeSeat).toEqual({ code: 'ABCDEF', seat: 1 });
  });

  it('REGRESSION finding L1: a captured seat cookie paired with another device discloses nothing', async () => {
    // resolveSeat() in lib/auth.ts enforces seatPayload.pid === device.playerId.
    // This route did not, so an attacker who captured victim's qx_seat could
    // pair it with their own qx_device and read back the victim's game code,
    // which is the join credential for that game.
    const victim = uid('player');
    const attacker = uid('player');
    seedPlayer(victim, 'Victim');
    seedPlayer(attacker, 'Attacker');

    const gameId = uid('game');
    fakeDb.tables.games ??= [];
    fakeDb.tables.games.push({ id: gameId, join_code: 'SECRET', status: 'active' });

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: attacker, iat: now });
    // A genuinely valid, correctly signed seat cookie belonging to the victim.
    const [sName, sVal] = seatCookiePair({ gid: gameId, code: 'SECRET', pid: victim, seat: 2, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { status, json } = await callMe(cookie);

    expect(status).toBe(200);
    expect(json.playerId).toBe(attacker);
    expect(json.activeSeat).toBeNull();
  });
});
