// IndexedDB open, schema, and typed read/write helpers. Browser only.
// Database name qwixx, version 1.

import type { Color, LockedRows, Sheet } from './scoring';

const DB_NAME = 'qwixx';
const DB_VERSION = 1;

export interface MetaDevice {
  k: 'device';
  playerId: string;
  displayName: string;
}

export interface MetaLastGame {
  k: 'lastGame';
  code: string;
}

export type MetaRecord = MetaDevice | MetaLastGame;

export interface SnapshotRecord {
  code: string;
  fetchedAt: number;
  // Verbatim last successful poll response for GET /api/games/[code].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface SheetRecord {
  code: string;
  serverSheet: Sheet;
  lastAckedVersion: number;
  lockedRows: LockedRows;
  gameStatus: 'lobby' | 'active' | 'ended';
}

export type QueuedMutation =
  | { id: string; type: 'mark'; color: Color; index: number }
  | { id: string; type: 'penalty' }
  | {
      id: string;
      type: 'undo';
      undoes: { type: 'mark'; color: Color; index: number } | { type: 'penalty' };
    };

export interface QueueRecord {
  seq?: number;
  code: string;
  mutation: QueuedMutation;
  createdAt: number;
}

export interface MoveRecord {
  seq?: number;
  code: string;
  kind: 'mark' | 'penalty';
  color?: Color;
  index?: number;
  undone: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'code' });
      }
      if (!db.objectStoreNames.contains('sheets')) {
        db.createObjectStore('sheets', { keyPath: 'code' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        const queueStore = db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
        queueStore.createIndex('code', 'code', { unique: false });
      }
      if (!db.objectStoreNames.contains('moves')) {
        const movesStore = db.createObjectStore('moves', { keyPath: 'seq', autoIncrement: true });
        movesStore.createIndex('code', 'code', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function tx<T>(
  db: IDBDatabase,
  storeNames: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    let result: T;
    Promise.resolve(fn(transaction))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// meta

export async function getMeta<T extends MetaRecord>(k: T['k']): Promise<T | undefined> {
  const db = await openDb();
  return tx(db, 'meta', 'readonly', (t) => requestToPromise(t.objectStore('meta').get(k) as IDBRequest<T>));
}

export async function putMeta(record: MetaRecord): Promise<void> {
  const db = await openDb();
  await tx(db, 'meta', 'readwrite', (t) => requestToPromise(t.objectStore('meta').put(record)));
}

// snapshots

export async function getSnapshot(code: string): Promise<SnapshotRecord | undefined> {
  const db = await openDb();
  return tx(db, 'snapshots', 'readonly', (t) =>
    requestToPromise(t.objectStore('snapshots').get(code) as IDBRequest<SnapshotRecord | undefined>),
  );
}

export async function putSnapshot(record: SnapshotRecord): Promise<void> {
  const db = await openDb();
  await tx(db, 'snapshots', 'readwrite', (t) => requestToPromise(t.objectStore('snapshots').put(record)));
}

// sheets (this device's own sheet per game)

export async function getSheetRecord(code: string): Promise<SheetRecord | undefined> {
  const db = await openDb();
  return tx(db, 'sheets', 'readonly', (t) =>
    requestToPromise(t.objectStore('sheets').get(code) as IDBRequest<SheetRecord | undefined>),
  );
}

export async function putSheetRecord(record: SheetRecord): Promise<void> {
  const db = await openDb();
  await tx(db, 'sheets', 'readwrite', (t) => requestToPromise(t.objectStore('sheets').put(record)));
}

// queue

export async function appendQueue(
  code: string,
  mutation: QueuedMutation,
): Promise<number> {
  const db = await openDb();
  return tx(db, 'queue', 'readwrite', (t) => {
    const record: QueueRecord = { code, mutation, createdAt: Date.now() };
    return requestToPromise(t.objectStore('queue').add(record) as IDBRequest<number>);
  });
}

export async function getQueueForGame(code: string): Promise<Required<QueueRecord>[]> {
  const db = await openDb();
  return tx(db, 'queue', 'readonly', (t) => {
    const index = t.objectStore('queue').index('code');
    return requestToPromise(index.getAll(code) as IDBRequest<Required<QueueRecord>[]>);
  });
}

export async function deleteQueueEntries(seqs: number[]): Promise<void> {
  if (seqs.length === 0) return;
  const db = await openDb();
  await tx(db, 'queue', 'readwrite', (t) => {
    const store = t.objectStore('queue');
    for (const seq of seqs) store.delete(seq);
  });
}

export async function clearQueueForGame(code: string): Promise<void> {
  const entries = await getQueueForGame(code);
  await deleteQueueEntries(entries.map((e) => e.seq));
}

// moves

export async function appendMove(record: Omit<MoveRecord, 'seq'>): Promise<number> {
  const db = await openDb();
  return tx(db, 'moves', 'readwrite', (t) =>
    requestToPromise(t.objectStore('moves').add(record) as IDBRequest<number>),
  );
}

export async function getMovesForGame(code: string): Promise<Required<MoveRecord>[]> {
  const db = await openDb();
  return tx(db, 'moves', 'readonly', (t) => {
    const index = t.objectStore('moves').index('code');
    return requestToPromise(index.getAll(code) as IDBRequest<Required<MoveRecord>[]>);
  });
}

export async function markMoveUndone(seq: number): Promise<void> {
  const db = await openDb();
  await tx(db, 'moves', 'readwrite', (t) => {
    const store = t.objectStore('moves');
    return new Promise<void>((resolve, reject) => {
      const getRequest = store.get(seq);
      getRequest.onsuccess = () => {
        const record = getRequest.result as MoveRecord | undefined;
        if (!record) {
          resolve();
          return;
        }
        record.undone = true;
        const putRequest = store.put(record);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  });
}
