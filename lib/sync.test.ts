import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSync } from './sync';
import { ApiError } from './api';
import type { GameStateResponse, MutationsResponse } from './api';
import { applyCross, emptyLockedRows, emptySheet, type Sheet, type LockedRows } from './scoring';
import { appendMove, appendQueue, getMovesForGame, getQueueForGame } from './idb';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, postMutations: vi.fn() };
});

import { postMutations } from './api';
const postMutationsMock = vi.mocked(postMutations);

let counter = 0;
function uniqueCode(): string {
  counter += 1;
  return `GAME-${counter}`;
}

const PLAYER = 'p1';

// Every GameSync created in a test is tracked here so afterEach can stop its
// timers. Without this, each test leaves a 5s periodic flush-loop timer
// running against a destroyed fixture.
let instances: GameSync[] = [];
function makeSync(code: string): GameSync {
  const s = new GameSync(code, PLAYER);
  instances.push(s);
  return s;
}

beforeEach(() => {
  instances = [];
  postMutationsMock.mockReset();
});

afterEach(() => {
  for (const s of instances) s.destroy();
});

function successResponse(sheet: Sheet, version: number, lockedRows: LockedRows): MutationsResponse {
  return {
    version,
    sheet: { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties },
    lockedRows,
    gameStatus: 'active',
    endReason: null,
  };
}

function conflictError(sheet: Sheet, version: number, lockedRows: LockedRows): ApiError {
  return new ApiError(409, {
    error: 'version_conflict',
    message: 'The sheet changed since your last update.',
    version,
    sheet: { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties },
    lockedRows,
    gameStatus: 'active',
  });
}

function rejectedError(
  index: number,
  reason: string,
  sheet: Sheet,
  version: number,
  lockedRows: LockedRows,
): ApiError {
  return new ApiError(422, {
    error: 'mutation_rejected',
    message: 'A mutation in the batch was illegal.',
    index,
    reason,
    version,
    sheet: { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties },
    lockedRows,
    gameStatus: 'active',
  });
}

function pollResponse(overrides: Partial<GameStateResponse>): GameStateResponse {
  return {
    game: {
      code: 'X',
      status: 'active',
      lockedRows: emptyLockedRows(),
      endReason: null,
      winnerPlayerId: null,
      endedAt: null,
      hostPlayerId: PLAYER,
    },
    you: { playerId: PLAYER, seat: 1, displayName: 'Dan', version: 0 },
    players: [],
    standings: null,
    ...overrides,
  };
}

describe('offline queueing and flush-once-online', () => {
  it('a mutation queued while offline survives and flushes in order once reconnected', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    postMutationsMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await sync.mark('red', 0);
    await sync.mark('red', 1);

    // Still offline: nothing dequeued, both survive on disk.
    expect(sync.getSnapshot().pendingCount).toBe(2);
    const persisted = await getQueueForGame(code);
    expect(persisted.map((q) => q.mutation)).toMatchObject([
      { type: 'mark', color: 'red', index: 0 },
      { type: 'mark', color: 'red', index: 1 },
    ]);

    // Simulate reload: a fresh GameSync instance picks the queue back up from IndexedDB.
    const reloaded = makeSync(code);
    await reloaded.init();
    expect(reloaded.getSnapshot().pendingCount).toBe(2);
    expect(reloaded.getSnapshot().localSheet.crosses.red).toEqual([0, 1]);

    // Now "online": the next flush succeeds and both mutations land, in order.
    const expected = applyCross(
      applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet,
      emptyLockedRows(),
      'red',
      1,
      PLAYER,
    ).sheet;
    postMutationsMock.mockReset();
    postMutationsMock.mockResolvedValue(successResponse(expected, 2, emptyLockedRows()));

    reloaded.kickFlush();
    await vi.waitFor(() => expect(reloaded.getSnapshot().pendingCount).toBe(0));

    expect(reloaded.getSnapshot().localSheet.crosses.red).toEqual([0, 1]);
    const sentBatch = postMutationsMock.mock.calls[0][1].mutations;
    expect(sentBatch.map((m) => (m.type === 'mark' ? m.index : m.type))).toEqual([0, 1]);
    expect(await getQueueForGame(code)).toEqual([]);
  });
});

describe('flush protocol: 200', () => {
  it('applies the server response and dequeues exactly the flushed entries', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    const afterMark = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    postMutationsMock.mockResolvedValue(successResponse(afterMark, 1, emptyLockedRows()));

    await sync.mark('red', 0);
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    expect(sync.getSnapshot().lastAckedVersion).toBe(1);
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    expect(sync.getSnapshot().toast).toBeNull();
  });
});

describe('flush protocol: 409 version_conflict', () => {
  it('when the replayed batch matches the authoritative sheet, treats it as a silent 200', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    const afterMark = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    postMutationsMock.mockRejectedValueOnce(conflictError(afterMark, 1, emptyLockedRows()));

    await sync.mark('red', 0);
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    expect(sync.getSnapshot().lastAckedVersion).toBe(1);
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    expect(sync.getSnapshot().toast).toBeNull();
    // The move is a normal acknowledged move, not force-undone.
    const moves = await getMovesForGame(code);
    expect(moves.every((m) => !m.undone)).toBe(true);
  });

  it('treats a jsonb-key-reordered sheet as matching, not a real conflict (finding C3)', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    const applied = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    // Real Postgres jsonb does not preserve the key order a client wrote; it
    // sorts by length then bytewise. Build the "from the database" sheet
    // with that order (red, blue, green, yellow) instead of the JS-natural
    // red/yellow/green/blue order applyCross/emptySheet produce, to prove
    // sheetsEqual compares structurally rather than via JSON.stringify.
    const reordered: Sheet = {
      crosses: {
        red: applied.crosses.red,
        blue: applied.crosses.blue,
        green: applied.crosses.green,
        yellow: applied.crosses.yellow,
      },
      locks: {
        red: applied.locks.red,
        blue: applied.locks.blue,
        green: applied.locks.green,
        yellow: applied.locks.yellow,
      },
      penalties: applied.penalties,
    };
    postMutationsMock.mockRejectedValueOnce(conflictError(reordered, 1, emptyLockedRows()));

    await sync.mark('red', 0);
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    // A false "not saved" alarm on data that was actually saved -- see
    // finding C5 -- would otherwise pin here for the rest of the game.
    expect(sync.getSnapshot().toast).toBeNull();
    const moves = await getMovesForGame(code);
    expect(moves.every((m) => !m.undone)).toBe(true);
  });

  it('a version conflict that does not drop a queued mutation that arrived mid-flight, and does not falsely mark it undone', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    let rejectFirst!: (err: unknown) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    // Kick off the first mutation's flush; it will hang until we reject it below.
    await sync.mark('red', 0);
    // A second mutation is queued while the first flush is still in flight.
    // Per the "only one flush in flight" rule this must NOT start a second
    // network call; it just sits in the queue.
    await sync.mark('red', 1);
    expect(postMutationsMock).toHaveBeenCalledTimes(1);

    // Server sheet diverged from what a replay of the flushed batch (just
    // the red:0 mutation) would produce, forcing the "not equal" branch.
    const diverged = applyCross(emptySheet(), emptyLockedRows(), 'blue', 0, 'someone-else').sheet;
    rejectFirst(conflictError(diverged, 9, emptyLockedRows()));

    await vi.waitFor(() => expect(sync.getSnapshot().toast).not.toBeNull());
    expect(sync.getSnapshot().toast).toBe('Your sheet was updated from the server. Some taps were not saved.');

    // The still-unflushed red:1 mutation must not have been dropped from the queue.
    expect(sync.getSnapshot().pendingCount).toBe(1);
    const remaining = await getQueueForGame(code);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].mutation).toMatchObject({ type: 'mark', color: 'red', index: 1 });

    // Its move-log entry must still say "not undone": the mutation is still
    // pending, not actually undone, so the undo button must still see it.
    const moves = await getMovesForGame(code);
    const pendingMove = moves.find((m) => m.color === 'red' && m.index === 1);
    expect(pendingMove?.undone).toBe(false);

    const flushedMove = moves.find((m) => m.color === 'red' && m.index === 0);
    expect(flushedMove?.undone).toBe(true);
  });
});

describe('flush protocol: 422 mutation_rejected', () => {
  it('surfaces the rejection as a toast, drops only the offending entry, and keeps legal survivors queued', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    let rejectFirst!: (err: unknown) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );

    // The first mark's flush starts immediately (batch = [blue:0]) and hangs
    // until we reject it below. A second mark queued while it is still in
    // flight (the client has stale lockedRows and does not yet know the
    // blue row was closed by another player) must not start a second call.
    await sync.mark('blue', 0);
    await sync.mark('red', 0);
    expect(sync.getSnapshot().pendingCount).toBe(2);
    expect(postMutationsMock).toHaveBeenCalledTimes(1);

    const lockedByOther: LockedRows = { ...emptyLockedRows(), blue: 'other-player' };
    const serverSheet = emptySheet(); // neither mutation applied server-side

    // The automatic re-flush of the surviving red:0 mutation succeeds.
    const afterRed = applyCross(serverSheet, lockedByOther, 'red', 0, PLAYER).sheet;
    postMutationsMock.mockResolvedValue(successResponse(afterRed, 6, lockedByOther));

    rejectFirst(rejectedError(0, 'row_closed', serverSheet, 5, lockedByOther));
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    expect(sync.getSnapshot().toast).toBe('Another player closed that colour.');
    expect(sync.getSnapshot().localLockedRows.blue).toBe('other-player');
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    expect(sync.getSnapshot().localSheet.crosses.blue).toEqual([]);

    // The red mutation was resent (not silently discarded alongside blue).
    const secondCallBatch = postMutationsMock.mock.calls[1][1].mutations;
    expect(secondCallBatch).toHaveLength(1);
    expect(secondCallBatch[0]).toMatchObject({ type: 'mark', color: 'red', index: 0 });

    const moves = await getMovesForGame(code);
    expect(moves.find((m) => m.color === 'blue')?.undone).toBe(true);
    expect(moves.find((m) => m.color === 'red')?.undone).toBe(false);
  });
});

describe('flush protocol: 409 wrong_status', () => {
  it('clears the queue and marks the game ended', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    postMutationsMock.mockRejectedValueOnce(
      new ApiError(409, { error: 'wrong_status', message: 'This game is not active.' }),
    );

    await sync.mark('red', 0);
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    expect(sync.getSnapshot().gameStatus).toBe('ended');
    expect(await getQueueForGame(code)).toEqual([]);
  });
});

describe('flush protocol: 403/404', () => {
  it('stops flushing, clears the queue, and tells the user they are no longer in the game', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    postMutationsMock.mockRejectedValueOnce(
      new ApiError(403, { error: 'not_seated', message: 'You are not seated in this game.' }),
    );

    await sync.mark('red', 0);
    await vi.waitFor(() => expect(sync.getSnapshot().toast).toBe('You are no longer in this game.'));

    expect(sync.getSnapshot().pendingCount).toBe(0);
    expect(await getQueueForGame(code)).toEqual([]);
  });
});

describe('flush protocol: 500 (finding C4, client side)', () => {
  it('a 500 from the server (what a transient DB read failure now correctly returns, not 404) does not clear the queue', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    postMutationsMock.mockRejectedValueOnce(
      new ApiError(500, { error: 'server_error', message: 'Something went wrong.' }),
    );

    await sync.mark('red', 0);
    await vi.waitFor(() => expect((sync as unknown as { flushInFlight: unknown }).flushInFlight).toBeNull());

    // Unlike a genuine 403/404, a 500 must not be terminal: the queue
    // survives on disk and the player is never told they left the game.
    expect(sync.getSnapshot().pendingCount).toBe(1);
    expect(sync.getSnapshot().toast).not.toBe('You are no longer in this game.');
    expect(await getQueueForGame(code)).toHaveLength(1);
  });
});

describe('undo racing an in-flight flush (finding C1)', () => {
  it('variant 1: undoing a single in-flight mark does not resurrect it once the server applies it', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    let resolveFirst!: (value: MutationsResponse) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // The follow-up flush -- the queued undo mutation, sent once the
    // in-flight mark's response lands -- succeeds and reverses it server-side.
    postMutationsMock.mockResolvedValueOnce(successResponse(emptySheet(), 2, emptyLockedRows()));

    await sync.mark('red', 3);
    expect(postMutationsMock).toHaveBeenCalledTimes(1);

    // Undo while the flush for this exact mark is still in flight.
    await sync.undo();
    // The UI reflects the undo immediately.
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([]);
    expect(sync.getSnapshot().canUndo).toBe(false);

    // The server never saw the undo and applies the original mark.
    const afterMark = applyCross(emptySheet(), emptyLockedRows(), 'red', 3, PLAYER).sheet;
    resolveFirst(successResponse(afterMark, 1, emptyLockedRows()));

    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));
    expect(postMutationsMock).toHaveBeenCalledTimes(2);
    const undoBatch = postMutationsMock.mock.calls[1][1].mutations;
    expect(undoBatch).toHaveLength(1);
    expect(undoBatch[0]).toMatchObject({ type: 'undo', undoes: { type: 'mark', color: 'red', index: 3 } });

    // No sequence of taps can bring red:3 back: it is gone for good, exactly
    // as the UI promised the instant Undo was tapped.
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([]);
  });

  it('variant 2: undoing the second entry of a two-item in-flight batch does not drop the first entry', async () => {
    const code = uniqueCode();
    await appendQueue(code, { id: 'a1', type: 'mark', color: 'red', index: 0 });
    await appendMove({ code, kind: 'mark', color: 'red', index: 0, undone: false });
    await appendQueue(code, { id: 'b1', type: 'mark', color: 'red', index: 1 });
    await appendMove({ code, kind: 'mark', color: 'red', index: 1, undone: false });

    const sync = makeSync(code);
    await sync.init();
    expect(sync.getSnapshot().pendingCount).toBe(2);

    let resolveFirst!: (value: MutationsResponse) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const bothApplied = applyCross(
      applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet,
      emptyLockedRows(),
      'red',
      1,
      PLAYER,
    ).sheet;
    // The follow-up flush undoing just B.
    postMutationsMock.mockResolvedValueOnce(
      successResponse(applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet, 3, emptyLockedRows()),
    );

    sync.kickFlush();
    await vi.waitFor(() => expect(postMutationsMock).toHaveBeenCalledTimes(1));
    const sentBatch = postMutationsMock.mock.calls[0][1].mutations;
    expect(sentBatch).toHaveLength(2);

    // Undo the most recent move (B) while both A and B are in the in-flight batch.
    await sync.undo();

    // The server received [A, B] before the undo and applies both.
    resolveFirst(successResponse(bothApplied, 2, emptyLockedRows()));

    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    // A survives; B was undone via a proper follow-up request, not silently
    // dropped from the client's in-memory queue via a count-based splice
    // while the server kept it applied.
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    expect(postMutationsMock).toHaveBeenCalledTimes(2);
    const undoBatch = postMutationsMock.mock.calls[1][1].mutations;
    expect(undoBatch).toHaveLength(1);
    expect(undoBatch[0]).toMatchObject({ type: 'undo', undoes: { type: 'mark', color: 'red', index: 1 } });
  });

  it('variant 3: a tap queued right after undoing an in-flight mark is not lost, with no reload needed', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    let resolveFirst!: (value: MutationsResponse) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // The follow-up flush carries both the undo of A and the new tap C.
    postMutationsMock.mockResolvedValueOnce(
      successResponse(applyCross(emptySheet(), emptyLockedRows(), 'blue', 0, PLAYER).sheet, 3, emptyLockedRows()),
    );

    await sync.mark('red', 5); // A
    expect(postMutationsMock).toHaveBeenCalledTimes(1);

    await sync.undo(); // undoes A while it is still in flight
    await sync.mark('blue', 0); // C, queued after the undo

    // The server never saw the undo and applies only the original A.
    const afterA = applyCross(emptySheet(), emptyLockedRows(), 'red', 5, PLAYER).sheet;
    resolveFirst(successResponse(afterA, 1, emptyLockedRows()));

    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    // C was never dropped and does not require a page reload to reappear;
    // A stays undone.
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([]);
    expect(sync.getSnapshot().localSheet.crosses.blue).toEqual([0]);
  });
});

describe('toast lifecycle (finding C5)', () => {
  // Real timers: fake-indexeddb's request events do not settle under
  // vi.useFakeTimers(), which hangs every awaited IndexedDB call this class
  // makes (init(), mark(), refreshCanUndo()) for the rest of the file. These
  // two tests genuinely wait out the real 4s TOAST_DURATION_MS.
  it(
    'clears itself after its display duration instead of pinning to the screen for the rest of the game',
    async () => {
      const code = uniqueCode();
      const sync = makeSync(code);
      await sync.init();

      const result = await sync.mark('red', 10); // index 10 with 0 crosses: lock_requires_five
      expect(result.ok).toBe(false);
      expect(sync.getSnapshot().toast).toBe('You need five crosses in that row before you can lock it.');

      await vi.waitFor(() => expect(sync.getSnapshot().toast).toBeNull(), { timeout: 4900, interval: 50 });
    },
    6000,
  );

  it(
    'a fresh toast resets the dismiss timer instead of being cut off by the previous one',
    async () => {
      const code = uniqueCode();
      const sync = makeSync(code);
      await sync.init();

      await sync.mark('red', 10); // first toast
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(sync.getSnapshot().toast).not.toBeNull();

      await sync.mark('yellow', 10); // second toast, resets the clock
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // 6s since the first toast, but only 3s since the second: still showing.
      expect(sync.getSnapshot().toast).not.toBeNull();

      await vi.waitFor(() => expect(sync.getSnapshot().toast).toBeNull(), { timeout: 2000, interval: 50 });
    },
    9000,
  );
});

describe('flush protocol: replay idempotency after a lost response', () => {
  it('does not double-apply a mutation the server actually processed but whose response was lost', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();

    // Round 1: the network call itself fails (response never arrives), even
    // though (per this test's premise) the server had already applied it.
    let rejectFirst!: (err: unknown) => void;
    postMutationsMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    await sync.mark('red', 0);
    expect(sync.getSnapshot().pendingCount).toBe(1);

    // Round 2 (retry): the server reports a version conflict, and replaying
    // the same batch against the pre-flush server sheet reproduces exactly
    // what the server already has -- proving the write was not lost, only
    // the acknowledgement.
    const appliedOnce = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    postMutationsMock.mockRejectedValueOnce(conflictError(appliedOnce, 1, emptyLockedRows()));

    rejectFirst(new TypeError('network drop'));
    // Let round 1 fully settle (its own catch runs, backoff is scheduled,
    // flushInFlight clears) before manually kicking round 2, exactly as a
    // real online/backoff-timer retry would after the promise chain unwinds.
    await vi.waitFor(() => expect((sync as unknown as { flushInFlight: unknown }).flushInFlight).toBeNull());

    sync.kickFlush();
    await vi.waitFor(() => expect(sync.getSnapshot().pendingCount).toBe(0));

    // Exactly one cross, not two: the retry did not double-apply.
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
    expect(sync.getSnapshot().lastAckedVersion).toBe(1);
    // A matching replay is treated as a silent success, no toast.
    expect(sync.getSnapshot().toast).toBeNull();
  });
});

describe('poll reconciliation', () => {
  it('does not adopt a server-ahead version while the queue still holds unflushed mutations', async () => {
    const code = uniqueCode();
    // Pre-seed IndexedDB directly so init() picks the queue up without ever
    // attempting a network flush.
    await appendQueue(code, { id: 'q1', type: 'mark', color: 'red', index: 0 });
    await appendMove({ code, kind: 'mark', color: 'red', index: 0, undone: false });

    const sync = makeSync(code);
    await sync.init();
    expect(sync.getSnapshot().pendingCount).toBe(1);
    expect(sync.getSnapshot().lastAckedVersion).toBe(0);

    // Poll reports the server is ahead (as if another flush from a previous
    // session succeeded and the ack was lost), but our queue is non-empty.
    const serverSideCross = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    const res = pollResponse({
      game: {
        code,
        status: 'active',
        lockedRows: emptyLockedRows(),
        endReason: null,
        winnerPlayerId: null,
        endedAt: null,
        hostPlayerId: PLAYER,
      },
      you: { playerId: PLAYER, seat: 1, displayName: 'Dan', version: 5 },
      players: [
        {
          playerId: PLAYER,
          seat: 1,
          displayName: 'Dan',
          crosses: serverSideCross.crosses,
          locks: serverSideCross.locks,
          penalties: 0,
          version: 5,
          rows: { red: 0, yellow: 0, green: 0, blue: 0 },
          total: 0,
          finalScore: null,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    await sync.applyPollResult(res);

    // Must NOT have adopted the server version: the flush still owns reconciliation.
    expect(sync.getSnapshot().lastAckedVersion).toBe(0);
    expect(sync.getSnapshot().pendingCount).toBe(1);
    expect(await getQueueForGame(code)).toHaveLength(1);
    // gameStatus/lockedRows are still safe to take from the poll.
    expect(sync.getSnapshot().gameStatus).toBe('active');
  });

  it('adopts the server version when the queue is empty', async () => {
    const code = uniqueCode();
    const sync = makeSync(code);
    await sync.init();
    expect(sync.getSnapshot().pendingCount).toBe(0);

    const serverSideCross = applyCross(emptySheet(), emptyLockedRows(), 'red', 0, PLAYER).sheet;
    const res = pollResponse({
      you: { playerId: PLAYER, seat: 1, displayName: 'Dan', version: 3 },
      players: [
        {
          playerId: PLAYER,
          seat: 1,
          displayName: 'Dan',
          crosses: serverSideCross.crosses,
          locks: serverSideCross.locks,
          penalties: 0,
          version: 3,
          rows: { red: 0, yellow: 0, green: 0, blue: 0 },
          total: 0,
          finalScore: null,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    await sync.applyPollResult(res);

    expect(sync.getSnapshot().lastAckedVersion).toBe(3);
    expect(sync.getSnapshot().localSheet.crosses.red).toEqual([0]);
  });

  it('discards any remaining queue and stops once the poll reports the game ended', async () => {
    const code = uniqueCode();
    await appendQueue(code, { id: 'q1', type: 'mark', color: 'red', index: 0 });
    const sync = makeSync(code);
    await sync.init();
    expect(sync.getSnapshot().pendingCount).toBe(1);

    const res = pollResponse({
      game: {
        code,
        status: 'ended',
        lockedRows: emptyLockedRows(),
        endReason: 'two_locks',
        winnerPlayerId: PLAYER,
        endedAt: new Date().toISOString(),
        hostPlayerId: PLAYER,
      },
      you: { playerId: PLAYER, seat: 1, displayName: 'Dan', version: 0 },
      players: [],
      standings: [],
    });

    await sync.applyPollResult(res);

    expect(sync.getSnapshot().gameStatus).toBe('ended');
    expect(sync.getSnapshot().pendingCount).toBe(0);
    expect(await getQueueForGame(code)).toEqual([]);
  });
});
