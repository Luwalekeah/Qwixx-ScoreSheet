import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from '@/lib/test/fakeSupabase';
import { cookieHeader, deviceCookiePair, seatCookiePair, tamper } from '@/lib/test/authHelpers';
import { emptyLockedRows, emptySheet } from '@/lib/scoring';

const fakeDb = new FakeSupabase();

vi.mock('@/lib/supabase/server', () => ({ db: fakeDb }));

const { POST } = await import('./route');

// All four helpers push through fakeDb.seed() rather than fakeDb.tables.push()
// directly, so a seeded row's jsonb-shaped columns (locked_rows, crosses,
// locks) come back in the same Postgres key order a row written through the
// route handler would (finding C3 residual). players and game_players carry
// no jsonb column today, but routing them through the same helper keeps
// every write path here consistent and future-proofs against one gaining
// one later.

function seedPlayer(id: string, displayName = 'Player'): void {
  fakeDb.seed('players', { id, display_name: displayName });
}

function seedGame(opts: {
  id: string;
  joinCode: string;
  status: 'lobby' | 'active' | 'ended';
  lockedRows?: ReturnType<typeof emptyLockedRows>;
}): void {
  fakeDb.seed('games', {
    id: opts.id,
    join_code: opts.joinCode,
    status: opts.status,
    locked_rows: opts.lockedRows ?? emptyLockedRows(),
    end_reason: null,
    winner_player_id: null,
    ended_at: null,
  });
}

function seedSeat(gameId: string, playerId: string, seat: number): void {
  fakeDb.seed('game_players', { game_id: gameId, player_id: playerId, seat, final_score: null });
}

function seedSheet(
  gameId: string,
  playerId: string,
  version = 0,
  penalties = 0,
  locks: ReturnType<typeof emptySheet>['locks'] = emptySheet().locks,
): void {
  const sheet = emptySheet();
  fakeDb.seed('sheets', {
    game_id: gameId,
    player_id: playerId,
    crosses: sheet.crosses,
    locks,
    penalties,
    version,
    updated_at: new Date(0).toISOString(),
  });
}

interface GameRow {
  id: string;
  join_code: string;
  status: 'lobby' | 'active' | 'ended';
  locked_rows: Record<string, string | null>;
  end_reason: string | null;
  winner_player_id: string | null;
  ended_at: string | null;
}

interface SheetRow {
  game_id: string;
  player_id: string;
  crosses: Record<string, number[]>;
  locks: Record<string, boolean>;
  penalties: number;
  version: number;
  updated_at: string;
}

function gameRow(id: string): GameRow | undefined {
  return fakeDb.tables.games.find((g) => g.id === id) as GameRow | undefined;
}

function sheetRow(gameId: string, playerId: string): SheetRow | undefined {
  return fakeDb.tables.sheets.find((s) => s.game_id === gameId && s.player_id === playerId) as
    | SheetRow
    | undefined;
}

function makeRequest(code: string, cookie: string | null, body: unknown): Request {
  return new Request(`http://localhost/api/games/${code}/mutations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callMutations(code: string, cookie: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const res = await POST(makeRequest(code, cookie, body), { params: Promise.resolve({ code }) });
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
  fakeDb.errorOnce = {};
  fakeDb.rpcHandlers = {
    // Mirrors supabase/migrations/0004_locked_rows_merge.sql: a per-colour
    // compare-and-swap merge. A key is only overwritten with the caller's
    // new value if the row's CURRENT value for that key still matches what
    // the caller originally read; otherwise a concurrent writer's value for
    // that one key is kept.
    merge_locked_rows: (args) => {
      const game = gameRow(args.p_game_id as string);
      if (!game) return null;
      const prev = args.p_prev as GameRow['locked_rows'];
      const next = args.p_next as GameRow['locked_rows'];
      const merged: GameRow['locked_rows'] = { ...game.locked_rows };
      for (const k of Object.keys(game.locked_rows)) {
        merged[k] = game.locked_rows[k] === prev[k] ? next[k] : game.locked_rows[k];
      }
      game.locked_rows = merged;
      return merged;
    },
  };
});

describe('auth boundary', () => {
  it('rejects a request with no qx_seat (and no qx_device) cookie', async () => {
    const gameId = uid('game');
    const code = 'CODEAA';
    seedGame({ id: gameId, joinCode: code, status: 'active' });

    const { status, json } = await callMutations(code, null, {
      baseVersion: 0,
      mutations: [{ id: 'm1', type: 'penalty' }],
    });

    expect(status).toBe(401);
    expect(json.error).toBe('no_device');
  });

  it('rejects a qx_seat cookie issued for a different game (game A cannot write game B)', async () => {
    const gameAId = uid('game');
    const gameBId = uid('game');
    const player = uid('player');
    seedPlayer(player);
    seedGame({ id: gameAId, joinCode: 'GAMEAAA', status: 'active' });
    seedGame({ id: gameBId, joinCode: 'GAMEBBB', status: 'active' });
    seedSeat(gameAId, player, 1);
    seedSheet(gameAId, player);
    // Deliberately NOT seated in game B.

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameAId, code: 'GAMEAAA', pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { status, json } = await callMutations('GAMEBBB', cookie, {
      baseVersion: 0,
      mutations: [{ id: 'm1', type: 'penalty' }],
    });

    expect(status).toBe(403);
    expect(json.error).toBe('not_seated');
  });

  it('a valid seat cookie for P1 cannot be used to write P2 sheet in the same game', async () => {
    const gameId = uid('game');
    const code = 'GAMECODE';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1);
    seedPlayer(p2);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    seedSheet(gameId, p1);
    seedSheet(gameId, p2);

    const now = Math.floor(Date.now() / 1000);
    // P1's real device cookie, but a forged seat cookie claiming to be P2.
    const [dName, dVal] = deviceCookiePair({ pid: p1, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: p2, seat: 2, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { status, json } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: 'm1', type: 'mark', color: 'red', index: 0 }],
    });

    // The forged seat cookie's pid does not match the verified device's
    // playerId, so resolveSeat falls back to P1's own real seat: the write
    // lands on P1's own sheet, never P2's.
    expect(status).toBe(200);
    expect(sheetRow(gameId, p1)?.crosses.red).toEqual([0]);
    expect(sheetRow(gameId, p2)?.crosses.red).toEqual([]);
    void json;
  });

  it('rejects a tampered / wrongly-signed cookie', async () => {
    const gameId = uid('game');
    const code = 'TAMPERED';
    const player = uid('player');
    seedPlayer(player);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, player, 1);
    seedSheet(gameId, player);

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const cookie = cookieHeader({ [dName]: tamper(dVal) });

    const { status, json } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: 'm1', type: 'penalty' }],
    });

    expect(status).toBe(401);
    expect(json.error).toBe('no_device');
  });
});

describe('game-wide lock semantics', () => {
  it('the first player to lock a colour closes it for everyone', async () => {
    const gameId = uid('game');
    const code = 'LOCKGAME';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1);
    seedPlayer(p2);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    seedSheet(gameId, p1);
    seedSheet(gameId, p2);

    const now = Math.floor(Date.now() / 1000);
    function cookieFor(playerId: string, seat: number): string {
      const [dName, dVal] = deviceCookiePair({ pid: playerId, iat: now });
      const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: playerId, seat, iat: now });
      return cookieHeader({ [dName]: dVal, [sName]: sVal });
    }

    // P1 crosses red 2,3,4,5,6 (five crosses) then locks at index 5 (the
    // sixth cross, index 5 corresponds to the row's 6th slot -- use indices
    // 0..4 for the five crosses and 10 for the lock, matching LOCK_INDEX).
    let version = 0;
    for (const index of [0, 1, 2, 3, 4]) {
      const res = await callMutations(code, cookieFor(p1, 1), {
        baseVersion: version,
        mutations: [{ id: uid('m'), type: 'mark', color: 'red', index }],
      });
      expect(res.status).toBe(200);
      version = res.json.version;
    }
    const lockRes = await callMutations(code, cookieFor(p1, 1), {
      baseVersion: version,
      mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 10 }],
    });
    expect(lockRes.status).toBe(200);
    expect(lockRes.json.lockedRows.red).toBe(p1);
    expect(gameRow(gameId)?.locked_rows.red).toBe(p1);

    // P2 now tries to cross red at all -- refused for everyone, not just P1.
    const p2Attempt = await callMutations(code, cookieFor(p2, 2), {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 0 }],
    });
    expect(p2Attempt.status).toBe(422);
    expect(p2Attempt.json.reason).toBe('row_closed');
    // The row stays closed, still owned by P1.
    expect(gameRow(gameId)?.locked_rows.red).toBe(p1);
  });

  it('undoCross only clears games.locked_rows when the undoing player owns the lock', async () => {
    const gameId = uid('game');
    const code = 'UNDOLOCK';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1);
    seedPlayer(p2);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    seedSheet(gameId, p1);
    seedSheet(gameId, p2);

    const now = Math.floor(Date.now() / 1000);
    function cookieFor(playerId: string, seat: number): string {
      const [dName, dVal] = deviceCookiePair({ pid: playerId, iat: now });
      const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: playerId, seat, iat: now });
      return cookieHeader({ [dName]: dVal, [sName]: sVal });
    }

    let version = 0;
    for (const index of [0, 1, 2, 3, 4]) {
      const res = await callMutations(code, cookieFor(p1, 1), {
        baseVersion: version,
        mutations: [{ id: uid('m'), type: 'mark', color: 'red', index }],
      });
      version = res.json.version;
    }
    const lockRes = await callMutations(code, cookieFor(p1, 1), {
      baseVersion: version,
      mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 10 }],
    });
    version = lockRes.json.version;
    expect(gameRow(gameId)?.locked_rows.red).toBe(p1);

    // P2 has no crosses in red at all: an undo targeting red:10 is illegal
    // for P2 (nothing to undo) and must never touch the shared lock.
    const p2UndoAttempt = await callMutations(code, cookieFor(p2, 2), {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'undo', undoes: { type: 'mark', color: 'red', index: 10 } }],
    });
    expect(p2UndoAttempt.status).toBe(422);
    expect(gameRow(gameId)?.locked_rows.red).toBe(p1); // unchanged: still P1's lock.

    // P1 undoing their own lock cross DOES free the row for everyone.
    const p1Undo = await callMutations(code, cookieFor(p1, 1), {
      baseVersion: version,
      mutations: [{ id: uid('m'), type: 'undo', undoes: { type: 'mark', color: 'red', index: 10 } }],
    });
    expect(p1Undo.status).toBe(200);
    expect(p1Undo.json.lockedRows.red).toBeNull();
    expect(gameRow(gameId)?.locked_rows.red).toBeNull();
  });
});

describe('game end detection and winner tiebreakers, end to end', () => {
  it('ends the game on two locked rows and picks a single winner by highest total', async () => {
    const gameId = uid('game');
    const code = 'ENDGAME1';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1, 'Alice');
    seedPlayer(p2, 'Bob');
    seedGame({ id: gameId, joinCode: code, status: 'active', lockedRows: { ...emptyLockedRows(), yellow: p2 } });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    seedSheet(gameId, p1);
    seedSheet(gameId, p2, 0, 0, { ...emptySheet().locks, yellow: true });

    const now = Math.floor(Date.now() / 1000);
    function cookieFor(playerId: string, seat: number): string {
      const [dName, dVal] = deviceCookiePair({ pid: playerId, iat: now });
      const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: playerId, seat, iat: now });
      return cookieHeader({ [dName]: dVal, [sName]: sVal });
    }

    let version = 0;
    for (const index of [0, 1, 2, 3, 4]) {
      const res = await callMutations(code, cookieFor(p1, 1), {
        baseVersion: version,
        mutations: [{ id: uid('m'), type: 'mark', color: 'red', index }],
      });
      version = res.json.version;
    }
    // Locking red is P1's second locked row across the whole game (yellow
    // is already locked by P2), which must trigger checkGameEnd's
    // two_locks path.
    const lockRes = await callMutations(code, cookieFor(p1, 1), {
      baseVersion: version,
      mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 10 }],
    });

    expect(lockRes.status).toBe(200);
    expect(lockRes.json.gameStatus).toBe('ended');
    expect(lockRes.json.endReason).toBe('two_locks');
    expect(gameRow(gameId)?.status).toBe('ended');
    expect(gameRow(gameId)?.end_reason).toBe('two_locks');

    // P1 crossed red 0..4 then locked at 10: 6 actual crosses plus the
    // locked-row bonus cross -> triangular(7) = 28.
    const p1Row = fakeDb.tables.game_players.find((gp) => gp.player_id === p1);
    const p2Row = fakeDb.tables.game_players.find((gp) => gp.player_id === p2);
    expect(p1Row?.final_score).toBe(28);
    // P2 has an empty sheet plus one locked (empty) yellow row: triangular(1) = 1.
    expect(p2Row?.final_score).toBe(1);
    expect(gameRow(gameId)?.winner_player_id).toBe(p1);

    // The board is now closed to further writes.
    const postEndAttempt = await callMutations(code, cookieFor(p2, 2), {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'penalty' }],
    });
    expect(postEndAttempt.status).toBe(409);
    expect(postEndAttempt.json.error).toBe('wrong_status');
  });

  it('ends the game when any player reaches four penalties, and ties produce a null winner', async () => {
    const gameId = uid('game');
    const code = 'ENDGAME2';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1);
    seedPlayer(p2);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    seedSheet(gameId, p1, 0, 3); // P1 already has 3 penalties, about to take a 4th.
    seedSheet(gameId, p2, 0, 4); // P2 already at 4 penalties, otherwise identical, empty rows.

    const now = Math.floor(Date.now() / 1000);
    function cookieFor(playerId: string, seat: number): string {
      const [dName, dVal] = deviceCookiePair({ pid: playerId, iat: now });
      const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: playerId, seat, iat: now });
      return cookieHeader({ [dName]: dVal, [sName]: sVal });
    }

    const res = await callMutations(code, cookieFor(p1, 1), {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'penalty' }],
    });

    expect(res.status).toBe(200);
    expect(res.json.gameStatus).toBe('ended');
    expect(res.json.endReason).toBe('penalties');

    const p1Row = fakeDb.tables.game_players.find((gp) => gp.player_id === p1);
    const p2Row = fakeDb.tables.game_players.find((gp) => gp.player_id === p2);
    // Both at 4 penalties, empty rows: total -20 each, a genuine tie.
    expect(p1Row?.final_score).toBe(-20);
    expect(p2Row?.final_score).toBe(-20);
    expect(gameRow(gameId)?.winner_player_id).toBeNull();
  });
});

describe('locked_rows concurrency (finding C2)', () => {
  it('two players locking two different colours in overlapping requests both land, neither erases the other', async () => {
    const gameId = uid('game');
    const code = 'LOCKRACE';
    const p1 = uid('player');
    const p2 = uid('player');
    seedPlayer(p1);
    seedPlayer(p2);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, p1, 1);
    seedSeat(gameId, p2, 2);
    // Both players already hold five crosses in a different colour each, so
    // a single mutation (the lock at index 10) is legal for both.
    fakeDb.tables.sheets ??= [];
    fakeDb.tables.sheets.push(
      {
        game_id: gameId,
        player_id: p1,
        crosses: { red: [0, 1, 2, 3, 4], yellow: [], green: [], blue: [] },
        locks: emptySheet().locks,
        penalties: 0,
        version: 0,
        updated_at: new Date(0).toISOString(),
      },
      {
        game_id: gameId,
        player_id: p2,
        crosses: { red: [], yellow: [], green: [0, 1, 2, 3, 4], blue: [] },
        locks: emptySheet().locks,
        penalties: 0,
        version: 0,
        updated_at: new Date(0).toISOString(),
      },
    );

    const now = Math.floor(Date.now() / 1000);
    function cookieFor(playerId: string, seat: number): string {
      const [dName, dVal] = deviceCookiePair({ pid: playerId, iat: now });
      const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: playerId, seat, iat: now });
      return cookieHeader({ [dName]: dVal, [sName]: sVal });
    }

    // Both requests read games.locked_rows (all null) before either writes
    // back -- the FakeSupabase query builder resolves through real
    // microtask boundaries, so Promise.all here interleaves exactly like
    // two overlapping HTTP requests would.
    const [p1Res, p2Res] = await Promise.all([
      callMutations(code, cookieFor(p1, 1), {
        baseVersion: 0,
        mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 10 }],
      }),
      callMutations(code, cookieFor(p2, 2), {
        baseVersion: 0,
        mutations: [{ id: uid('m'), type: 'mark', color: 'green', index: 10 }],
      }),
    ]);

    expect(p1Res.status).toBe(200);
    expect(p2Res.status).toBe(200);

    // Neither write erased the other's colour.
    expect(gameRow(gameId)?.locked_rows.red).toBe(p1);
    expect(gameRow(gameId)?.locked_rows.green).toBe(p2);
  });
});

describe('database read failures (finding C4)', () => {
  it('returns 500, not 404, when the game lookup itself fails', async () => {
    const gameId = uid('game');
    const code = 'DBERROR1';
    const player = uid('player');
    seedPlayer(player);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, player, 1);
    seedSheet(gameId, player);

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    // The seat cookie matches the requested code, so requireSeat's fast path
    // never touches the database -- the first real 'games' select this
    // request makes is the mutations route's own lookup.
    fakeDb.errorOnce['games:select'] = 'connection reset by peer';

    const { status, json } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'penalty' }],
    });

    expect(status).toBe(500);
    expect(json.error).toBe('server_error');
  });

  it('returns 500, not 404, when the sheet lookup itself fails', async () => {
    const gameId = uid('game');
    const code = 'DBERROR2';
    const player = uid('player');
    seedPlayer(player);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, player, 1);
    seedSheet(gameId, player);

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    fakeDb.errorOnce['sheets:select'] = 'connection reset by peer';

    const { status, json } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'penalty' }],
    });

    expect(status).toBe(500);
    expect(json.error).toBe('server_error');
  });

  it('still returns 404 when the game genuinely does not exist (no forced error)', async () => {
    const gameId = uid('game');
    const code = 'GONEGAME';
    const player = uid('player');
    seedPlayer(player);
    // Note: no seedGame() call -- the game genuinely does not exist.

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    // A signed seat cookie whose code matches the request lets requireSeat's
    // fast path succeed without a database read, exactly as it would for a
    // stale cookie pointing at a since-deleted game.
    const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { status, json } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'penalty' }],
    });

    expect(status).toBe(404);
    expect(json.error).toBe('game_not_found');
  });
});

describe('FakeSupabase jsonb key ordering (finding C3 infrastructure)', () => {
  it('reorders jsonb-shaped columns the way Postgres stores them, by key length then bytewise', async () => {
    const gameId = uid('game');
    const code = 'JSONBORD';
    const player = uid('player');
    seedPlayer(player);
    seedGame({ id: gameId, joinCode: code, status: 'active' });
    seedSeat(gameId, player, 1);
    seedSheet(gameId, player);

    const now = Math.floor(Date.now() / 1000);
    const [dName, dVal] = deviceCookiePair({ pid: player, iat: now });
    const [sName, sVal] = seatCookiePair({ gid: gameId, code, pid: player, seat: 1, iat: now });
    const cookie = cookieHeader({ [dName]: dVal, [sName]: sVal });

    const { status } = await callMutations(code, cookie, {
      baseVersion: 0,
      mutations: [{ id: uid('m'), type: 'mark', color: 'red', index: 0 }],
    });
    expect(status).toBe(200);

    // red(3), blue(4), green(5), yellow(6): sorted by length then bytewise,
    // exactly what real Postgres jsonb storage produces (and NOT the
    // red/yellow/green/blue order emptySheet() builds in JS).
    expect(Object.keys(sheetRow(gameId, player)!.crosses)).toEqual(['red', 'blue', 'green', 'yellow']);
  });
});
