import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  appendMove,
  appendQueue,
  clearQueueForGame,
  deleteQueueEntries,
  getMeta,
  getMovesForGame,
  getQueueForGame,
  getSheetRecord,
  getSnapshot,
  markMoveUndone,
  putMeta,
  putSheetRecord,
  putSnapshot,
} from './idb';
import { emptyLockedRows, emptySheet } from './scoring';

// lib/idb.ts caches a single module-level IndexedDB connection for the
// process, so tests in this file share one database. Each test uses its own
// unique game code / key rather than resetting the database, so tests never
// see each other's rows.
let counter = 0;
function uniqueCode(): string {
  counter += 1;
  return `GAME-${counter}`;
}

describe('meta store', () => {
  it('round-trips a device record', async () => {
    await putMeta({ k: 'device', playerId: 'p1', displayName: 'Dan' });
    const record = await getMeta('device');
    expect(record).toEqual({ k: 'device', playerId: 'p1', displayName: 'Dan' });
  });
});

describe('snapshots store', () => {
  it('round-trips a snapshot keyed by game code', async () => {
    const code = uniqueCode();
    await putSnapshot({ code, fetchedAt: 123, data: { hello: 'world' } });
    const record = await getSnapshot(code);
    expect(record).toEqual({ code, fetchedAt: 123, data: { hello: 'world' } });
  });

  it('is empty for an unknown code', async () => {
    expect(await getSnapshot(uniqueCode())).toBeUndefined();
  });
});

describe('sheets store', () => {
  it('round-trips this device sheet for a game', async () => {
    const code = uniqueCode();
    const record = {
      code,
      serverSheet: emptySheet(),
      lastAckedVersion: 3,
      lockedRows: emptyLockedRows(),
      gameStatus: 'active' as const,
    };
    await putSheetRecord(record);
    expect(await getSheetRecord(code)).toEqual(record);
  });
});

describe('queue store', () => {
  it('appends mutations in order and reads them back for the right game only', async () => {
    const game1 = uniqueCode();
    const game2 = uniqueCode();
    await appendQueue(game1, { id: 'm1', type: 'mark', color: 'red', index: 0 });
    await appendQueue(game1, { id: 'm2', type: 'penalty' });
    await appendQueue(game2, { id: 'm3', type: 'mark', color: 'blue', index: 0 });

    const game1Queue = await getQueueForGame(game1);
    expect(game1Queue.map((q) => q.mutation.id)).toEqual(['m1', 'm2']);
    // seq is autoIncrement, so order of insertion is preserved via seq ascending.
    expect(game1Queue[0].seq).toBeLessThan(game1Queue[1].seq);

    const game2Queue = await getQueueForGame(game2);
    expect(game2Queue.map((q) => q.mutation.id)).toEqual(['m3']);
  });

  it('deleteQueueEntries removes exactly the given seqs, leaving the rest', async () => {
    const game1 = uniqueCode();
    const seq1 = await appendQueue(game1, { id: 'm1', type: 'mark', color: 'red', index: 0 });
    const seq2 = await appendQueue(game1, { id: 'm2', type: 'mark', color: 'red', index: 1 });
    await appendQueue(game1, { id: 'm3', type: 'penalty' });

    await deleteQueueEntries([seq1, seq2]);

    const remaining = await getQueueForGame(game1);
    expect(remaining.map((q) => q.mutation.id)).toEqual(['m3']);
  });

  it('deleteQueueEntries with an empty array is a no-op', async () => {
    const game1 = uniqueCode();
    await appendQueue(game1, { id: 'm1', type: 'mark', color: 'red', index: 0 });
    await deleteQueueEntries([]);
    expect((await getQueueForGame(game1)).length).toBe(1);
  });

  it('clearQueueForGame removes only that game', async () => {
    const game1 = uniqueCode();
    const game2 = uniqueCode();
    await appendQueue(game1, { id: 'm1', type: 'mark', color: 'red', index: 0 });
    await appendQueue(game2, { id: 'm2', type: 'mark', color: 'blue', index: 0 });

    await clearQueueForGame(game1);

    expect(await getQueueForGame(game1)).toEqual([]);
    expect((await getQueueForGame(game2)).length).toBe(1);
  });
});

describe('moves store', () => {
  it('appends moves and marks one undone without touching the rest', async () => {
    const game1 = uniqueCode();
    const seqA = await appendMove({ code: game1, kind: 'mark', color: 'red', index: 0, undone: false });
    const seqB = await appendMove({ code: game1, kind: 'penalty', undone: false });

    await markMoveUndone(seqA);

    const moves = await getMovesForGame(game1);
    const byId = new Map(moves.map((m) => [m.seq, m]));
    expect(byId.get(seqA)?.undone).toBe(true);
    expect(byId.get(seqB)?.undone).toBe(false);
  });

  it('markMoveUndone on a seq that does not exist does not throw', async () => {
    await expect(markMoveUndone(999999)).resolves.toBeUndefined();
  });
});
