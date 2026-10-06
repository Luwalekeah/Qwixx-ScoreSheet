// Local truth, mutation queue, flush protocol, poll reconciliation. Browser only.
//
// Rendering never waits on the network. Every tap writes to IndexedDB and
// updates local state synchronously. The network is a background flush.

import {
  applyCross,
  applyPenalty,
  undoCross,
  undoPenalty,
  canCross,
  canPenalty,
  canUndoCross,
  emptySheet,
  emptyLockedRows,
  type Sheet,
  type LockedRows,
  type Color,
  type RejectReason,
} from './scoring';
import {
  getSheetRecord,
  putSheetRecord,
  getQueueForGame,
  deleteQueueEntries,
  appendQueue,
  getMovesForGame,
  appendMove,
  markMoveUndone,
  putSnapshot,
  putMeta,
  type QueuedMutation,
  type SheetRecord,
} from './idb';
import { postMutations, type GameStateResponse, ApiError } from './api';

const FLUSH_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 3000;
const BACKOFF_SCHEDULE = [1000, 2000, 5000, 10000, 15000];
// Matches components/Toast.tsx's own 4s auto-dismiss timer. GameSync owns
// clearing its own toast on the same schedule so the message cannot outlive
// its visual lifetime even though Toast's onDismiss only kicks a flush, not
// the toast text itself (see finding C5).
const TOAST_DURATION_MS = 4000;

const REASON_MESSAGES: Record<RejectReason, string> = {
  row_closed: 'Another player closed that colour.',
  not_strictly_right: 'You can only cross a number to the right of your last one.',
  lock_requires_five: 'You need five crosses in that row before you can lock it.',
  max_penalties: 'You already have four penalties.',
  nothing_to_undo: 'There is nothing left to undo.',
  out_of_range: 'That number is not in this row.',
};

function replay(
  serverSheet: Sheet,
  lockedRows: LockedRows,
  mutations: QueuedMutation[],
  playerId: string,
): { sheet: Sheet; lockedRows: LockedRows } {
  let sheet = serverSheet;
  let lr = lockedRows;
  for (const m of mutations) {
    if (m.type === 'mark') {
      const result = applyCross(sheet, lr, m.color, m.index, playerId);
      sheet = result.sheet;
      lr = result.lockedRows;
    } else if (m.type === 'penalty') {
      sheet = applyPenalty(sheet);
    } else if (m.undoes.type === 'mark') {
      const result = undoCross(sheet, lr, m.undoes.color, m.undoes.index, playerId);
      sheet = result.sheet;
      lr = result.lockedRows;
    } else {
      sheet = undoPenalty(sheet);
    }
  }
  return { sheet, lockedRows: lr };
}

// `crosses` and `locks` are jsonb columns. Postgres does not preserve the
// key order a client wrote; it stores object keys sorted by length then
// bytewise, so a sheet read back from the database can have a different
// JSON.stringify() output than the locally-replayed sheet even when every
// value is identical. Compare structurally instead (see finding C3).
function sheetsEqual(a: Sheet, b: Sheet): boolean {
  if (a.penalties !== b.penalties) return false;
  for (const color of ['red', 'yellow', 'green', 'blue'] as const) {
    if (a.locks[color] !== b.locks[color]) return false;
    const ac = a.crosses[color];
    const bc = b.crosses[color];
    if (ac.length !== bc.length) return false;
    for (let i = 0; i < ac.length; i++) {
      if (ac[i] !== bc[i]) return false;
    }
  }
  return true;
}

export interface GameSyncSnapshot {
  localSheet: Sheet;
  localLockedRows: LockedRows;
  gameStatus: 'lobby' | 'active' | 'ended';
  lastAckedVersion: number;
  pendingCount: number;
  canUndo: boolean;
  online: boolean;
  toast: string | null;
}

export type Listener = (snapshot: GameSyncSnapshot) => void;

export class GameSync {
  private code: string;
  private playerId: string;

  private serverSheet: Sheet = emptySheet();
  private lastAckedVersion = 0;
  private lockedRows: LockedRows = emptyLockedRows();
  private gameStatus: 'lobby' | 'active' | 'ended' = 'lobby';

  private queue: QueuedMutation[] = [];
  private queueSeqs: number[] = [];

  private listeners = new Set<Listener>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushInFlight: Promise<boolean> | null = null;
  private backoffIndex = 0;
  private toast: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private online = typeof navigator === 'undefined' ? true : navigator.onLine;
  private stopped = false;

  // Seqs currently inside a batch `doFlush()` has sent and is awaiting a
  // response for. `undo()` consults this to decide whether it is still safe
  // to delete a queue entry locally, or whether the server may already be
  // applying it (see finding C1).
  private inFlightSeqs = new Set<number>();

  constructor(code: string, playerId: string) {
    this.code = code;
    this.playerId = playerId;
  }

  async init(): Promise<void> {
    await putMeta({ k: 'lastGame', code: this.code });

    const record = await getSheetRecord(this.code);
    if (record) {
      this.serverSheet = record.serverSheet;
      this.lastAckedVersion = record.lastAckedVersion;
      this.lockedRows = record.lockedRows;
      this.gameStatus = record.gameStatus;
    } else {
      await putSheetRecord({
        code: this.code,
        serverSheet: this.serverSheet,
        lastAckedVersion: this.lastAckedVersion,
        lockedRows: this.lockedRows,
        gameStatus: this.gameStatus,
      });
    }

    const queued = await getQueueForGame(this.code);
    this.queue = queued.map((q) => q.mutation);
    this.queueSeqs = queued.map((q) => q.seq);

    this.emit();
    this.scheduleFlushLoop();
  }

  private localState(): { sheet: Sheet; lockedRows: LockedRows } {
    try {
      return replay(this.serverSheet, this.lockedRows, this.queue, this.playerId);
    } catch {
      // A replay failure means the queue has drifted from truth. Surface the
      // server sheet unmodified; the next poll or flush will reconcile.
      return { sheet: this.serverSheet, lockedRows: this.lockedRows };
    }
  }

  getSnapshot(): GameSyncSnapshot {
    const { sheet, lockedRows } = this.localState();
    return {
      localSheet: sheet,
      localLockedRows: lockedRows,
      gameStatus: this.gameStatus,
      lastAckedVersion: this.lastAckedVersion,
      pendingCount: this.queue.length,
      canUndo: this.hasUndoableMove(),
      online: this.online,
      toast: this.toast,
    };
  }

  private hasUndoableMove(): boolean {
    // Populated lazily by callers awaiting getMovesForGame; kept synchronous
    // here by tracking a cached flag updated on each mutating operation.
    return this.cachedCanUndo;
  }

  private cachedCanUndo = false;

  private async refreshCanUndo(): Promise<void> {
    const moves = await getMovesForGame(this.code);
    this.cachedCanUndo = moves.some((m) => !m.undone);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const l of this.listeners) l(snapshot);
  }

  private setToast(message: string | null): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast = message;
    if (message !== null) {
      // Nothing else in this class ever calls setToast(null); Toast.tsx's
      // own 4s timer only kicks a flush, it never clears the message prop.
      // Own the full lifecycle here so a toast cannot pin to the screen for
      // the rest of the game (see finding C5).
      this.toastTimer = setTimeout(() => {
        this.toastTimer = null;
        this.toast = null;
        this.emit();
      }, TOAST_DURATION_MS);
    }
    this.emit();
  }

  // 8.3 Tap path

  async mark(color: Color, index: number): Promise<{ ok: boolean; reason?: RejectReason }> {
    const { sheet, lockedRows } = this.localState();
    const legality = canCross(sheet, lockedRows, color, index);
    if (!legality.ok) {
      this.setToast(REASON_MESSAGES[legality.reason]);
      return { ok: false, reason: legality.reason };
    }

    const mutation: QueuedMutation = { id: crypto.randomUUID(), type: 'mark', color, index };
    const seq = await appendQueue(this.code, mutation);
    await appendMove({ code: this.code, kind: 'mark', color, index, undone: false });

    this.queue.push(mutation);
    this.queueSeqs.push(seq);
    await this.refreshCanUndo();
    this.emit();
    this.kickFlush();

    return { ok: true };
  }

  async penalty(): Promise<{ ok: boolean; reason?: RejectReason }> {
    const { sheet } = this.localState();
    const legality = canPenalty(sheet);
    if (!legality.ok) {
      this.setToast(REASON_MESSAGES[legality.reason]);
      return { ok: false, reason: legality.reason };
    }

    const mutation: QueuedMutation = { id: crypto.randomUUID(), type: 'penalty' };
    const seq = await appendQueue(this.code, mutation);
    await appendMove({ code: this.code, kind: 'penalty', undone: false });

    this.queue.push(mutation);
    this.queueSeqs.push(seq);
    await this.refreshCanUndo();
    this.emit();
    this.kickFlush();

    return { ok: true };
  }

  // 8.4 Undo

  async undo(): Promise<void> {
    const moves = await getMovesForGame(this.code);
    const lastUndoable = [...moves].reverse().find((m) => !m.undone);
    if (!lastUndoable) return;

    // Is this move still sitting unflushed in the local queue? If so, the
    // matching queue entry has the same kind/color/index as the last queued
    // mutation of that kind; since taps are queued FIFO and moves mirror the
    // queue 1:1 for marks/penalties, the last queue entry aligned with this
    // move is the last entry of the matching type at the tail of the queue.
    const stillQueuedIndex = this.findQueueIndexForMove(lastUndoable);
    const stillQueuedSeq = stillQueuedIndex !== -1 ? this.queueSeqs[stillQueuedIndex] : undefined;

    // If the matching entry is still queued AND not already inside a batch
    // doFlush() is awaiting a response for, it is safe to delete it locally:
    // the server has never seen it. If it IS in flight, the server may be
    // applying it right now (or already has, with the response still in
    // transit); deleting it here would desync from doFlush(), which removes
    // its batch by seq once the response lands, not by counting entries.
    // Fall through to the "already acknowledged" path instead, which queues
    // a proper undo mutation (see finding C1).
    if (stillQueuedIndex !== -1 && stillQueuedSeq !== undefined && !this.inFlightSeqs.has(stillQueuedSeq)) {
      await deleteQueueEntries([stillQueuedSeq]);
      this.queue.splice(stillQueuedIndex, 1);
      this.queueSeqs.splice(stillQueuedIndex, 1);
      await markMoveUndone(lastUndoable.seq);
      await this.refreshCanUndo();
      this.emit();
      return;
    }

    // Already acknowledged: push an undo mutation describing exactly what it
    // removes.
    const undoes: { type: 'mark'; color: Color; index: number } | { type: 'penalty' } =
      lastUndoable.kind === 'mark'
        ? { type: 'mark', color: lastUndoable.color as Color, index: lastUndoable.index as number }
        : { type: 'penalty' };

    const mutation: QueuedMutation = { id: crypto.randomUUID(), type: 'undo', undoes };
    const seq = await appendQueue(this.code, mutation);
    this.queue.push(mutation);
    this.queueSeqs.push(seq);
    await markMoveUndone(lastUndoable.seq);
    await this.refreshCanUndo();
    this.emit();
    this.kickFlush();
  }

  // Removes queue entries by seq, matching the IndexedDB deletion this is
  // always paired with. Never remove by count/index: `this.queue` can have
  // shifted since a batch was snapshotted, because undo() may have inserted
  // a new "undo" mutation ahead of entries that were in flight (finding C1).
  private removeQueueEntriesBySeq(seqsToRemove: number[]): void {
    if (seqsToRemove.length === 0) return;
    const removeSet = new Set(seqsToRemove);
    const survivingQueue: QueuedMutation[] = [];
    const survivingSeqs: number[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      if (!removeSet.has(this.queueSeqs[i])) {
        survivingQueue.push(this.queue[i]);
        survivingSeqs.push(this.queueSeqs[i]);
      }
    }
    this.queue = survivingQueue;
    this.queueSeqs = survivingSeqs;
  }

  private findQueueIndexForMove(move: { kind: 'mark' | 'penalty'; color?: Color; index?: number }): number {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const m = this.queue[i];
      if (move.kind === 'mark' && m.type === 'mark' && m.color === move.color && m.index === move.index) {
        return i;
      }
      if (move.kind === 'penalty' && m.type === 'penalty') {
        return i;
      }
    }
    return -1;
  }

  // 8.5 Flush protocol

  kickFlush(): void {
    if (this.stopped) return;
    void this.flush();
  }

  private scheduleFlushLoop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (!this.stopped && this.gameStatus !== 'ended' && this.isVisible() && this.queue.length > 0) {
        void this.flush();
      }
      this.scheduleFlushLoop();
    }, FLUSH_INTERVAL_MS);
  }

  private isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }

  // A plain function call breaks TypeScript's control-flow narrowing of
  // `this.gameStatus`, which otherwise stays (incorrectly) pinned to
  // whatever it was narrowed to earlier in flush(), even after an awaited
  // doFlush() call reassigns it.
  private currentStatus(): 'lobby' | 'active' | 'ended' {
    return this.gameStatus;
  }

  private async flush(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
      return;
    }
    if (this.queue.length === 0 || this.gameStatus === 'ended') return;

    this.flushInFlight = this.doFlush();
    let progressed = false;
    try {
      progressed = await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }

    // doFlush() itself calls kickFlush() when it leaves the queue non-empty
    // (a batch >50, or a tap that landed mid-flight), but that call lands
    // while flushInFlight above still points at the just-finished doFlush()
    // promise, so it always no-ops. Owning the continuation here, after
    // flushInFlight is actually cleared, is what makes that continuation
    // real instead of dead code. Only do this when doFlush() actually
    // resolved the in-flight batch one way or another -- a network failure
    // or 5xx leaves the queue untouched and already scheduled its own
    // backoff retry; auto-continuing here too would ignore that backoff and
    // spin a tight retry loop against a still-failing server.
    if (!this.stopped && this.currentStatus() !== 'ended' && this.queue.length > 0 && progressed) {
      void this.flush();
    }
  }

  private async doFlush(): Promise<boolean> {
    const batch = this.queue.slice(0, 50);
    const batchSeqs = this.queueSeqs.slice(0, 50);
    const baseVersion = this.lastAckedVersion;

    // Mark these entries in flight before the network round trip starts so
    // undo() can tell the server may already be applying them (finding C1).
    // Cleared in `finally`, after handleFlushError (awaited below) has
    // finished deciding what happens to the queue.
    for (const s of batchSeqs) this.inFlightSeqs.add(s);

    try {
      const res = await postMutations(this.code, { baseVersion, mutations: batch });

      this.serverSheet = { crosses: res.sheet.crosses, locks: res.sheet.locks, penalties: res.sheet.penalties };
      this.lastAckedVersion = res.version;
      this.lockedRows = res.lockedRows;
      this.gameStatus = res.gameStatus;

      await deleteQueueEntries(batchSeqs);
      this.removeQueueEntriesBySeq(batchSeqs);

      await this.persistSheetRecord();
      this.backoffIndex = 0;

      if (res.gameStatus === 'ended') {
        this.stopFlushing();
      }

      this.emit();

      if (this.queue.length > 0) {
        this.kickFlush();
      }

      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        return await this.handleFlushError(err, batch, batchSeqs);
      }
      // Network failure or 5xx already surfaced as ApiError with status 500+,
      // anything else (offline) leaves the queue untouched and retries with
      // backoff.
      this.scheduleBackoffRetry();
      return false;
    } finally {
      for (const s of batchSeqs) this.inFlightSeqs.delete(s);
    }
  }

  private async handleFlushError(
    err: ApiError,
    batch: QueuedMutation[],
    batchSeqs: number[],
  ): Promise<boolean> {
    const body = err.body as {
      version?: number;
      sheet?: { crosses: Sheet['crosses']; locks: Sheet['locks']; penalties: number };
      lockedRows?: LockedRows;
      gameStatus?: 'active' | 'ended';
      index?: number;
      reason?: RejectReason;
    };

    if (err.status === 409 && err.body.error === 'version_conflict' && body.sheet && body.version !== undefined) {
      const authoritative: Sheet = { crosses: body.sheet.crosses, locks: body.sheet.locks, penalties: body.sheet.penalties };
      let matches = false;
      try {
        const replayed = replay(this.serverSheet, this.lockedRows, batch, this.playerId);
        matches = sheetsEqual(replayed.sheet, authoritative);
      } catch {
        matches = false;
      }

      this.serverSheet = authoritative;
      this.lastAckedVersion = body.version;
      if (body.lockedRows) this.lockedRows = body.lockedRows;
      if (body.gameStatus) this.gameStatus = body.gameStatus;

      await deleteQueueEntries(batchSeqs);
      this.removeQueueEntriesBySeq(batchSeqs);

      if (!matches) {
        // Only the flushed batch's moves are "not saved" here -- anything
        // still sitting in the queue (added mid-flight, after this batch
        // was already snapshotted for sending) is untouched and will still
        // be sent on the next flush. Marking those undone too would corrupt
        // the undo log for a mutation that was never actually dropped.
        const moves = await getMovesForGame(this.code);
        const descriptors = batch.map((m) => this.describeMutation(m));
        for (const move of [...moves].filter((m) => !m.undone).reverse()) {
          const descriptor = move.kind === 'mark' ? `mark:${move.color}:${move.index}` : 'penalty';
          const idx = descriptors.indexOf(descriptor);
          if (idx !== -1) {
            await markMoveUndone(move.seq);
            descriptors.splice(idx, 1);
          }
        }
        this.setToast('Your sheet was updated from the server. Some taps were not saved.');
      }

      await this.persistSheetRecord();
      await this.refreshCanUndo();
      this.backoffIndex = 0;
      this.emit();
      if (this.queue.length > 0) this.kickFlush();
      return true;
    }

    if (err.status === 422 && body.sheet && body.version !== undefined && body.index !== undefined) {
      const authoritative: Sheet = { crosses: body.sheet.crosses, locks: body.sheet.locks, penalties: body.sheet.penalties };
      this.serverSheet = authoritative;
      this.lastAckedVersion = body.version;
      if (body.lockedRows) this.lockedRows = body.lockedRows;
      if (body.gameStatus) this.gameStatus = body.gameStatus;

      const offendingSeq = batchSeqs[body.index];
      await deleteQueueEntries([offendingSeq]);

      const removeIndex = this.queueSeqs.indexOf(offendingSeq);
      if (removeIndex !== -1) {
        this.queue.splice(removeIndex, 1);
        this.queueSeqs.splice(removeIndex, 1);
      }

      // Re-validate every remaining queued mutation for this game in order.
      let workingSheet = this.serverSheet;
      let workingLockedRows = this.lockedRows;
      const survivorsQueue: QueuedMutation[] = [];
      const survivorsSeqs: number[] = [];
      const toRemoveSeqs: number[] = [];
      const toRemoveDescriptors: string[] = [];

      for (let i = 0; i < this.queue.length; i++) {
        const m = this.queue[i];
        const seq = this.queueSeqs[i];
        let stillLegal = true;
        try {
          if (m.type === 'mark') {
            const legality = canCross(workingSheet, workingLockedRows, m.color, m.index);
            stillLegal = legality.ok;
            if (stillLegal) {
              const result = applyCross(workingSheet, workingLockedRows, m.color, m.index, this.playerId);
              workingSheet = result.sheet;
              workingLockedRows = result.lockedRows;
            }
          } else if (m.type === 'penalty') {
            const legality = canPenalty(workingSheet);
            stillLegal = legality.ok;
            if (stillLegal) workingSheet = applyPenalty(workingSheet);
          } else if (m.undoes.type === 'mark') {
            stillLegal = canUndoCross(workingSheet, m.undoes.color, m.undoes.index);
            if (stillLegal) {
              const result = undoCross(workingSheet, workingLockedRows, m.undoes.color, m.undoes.index, this.playerId);
              workingSheet = result.sheet;
              workingLockedRows = result.lockedRows;
            }
          } else {
            stillLegal = workingSheet.penalties > 0;
            if (stillLegal) workingSheet = undoPenalty(workingSheet);
          }
        } catch {
          stillLegal = false;
        }

        if (stillLegal) {
          survivorsQueue.push(m);
          survivorsSeqs.push(seq);
        } else {
          toRemoveSeqs.push(seq);
          toRemoveDescriptors.push(this.describeMutation(m));
        }
      }

      if (toRemoveSeqs.length > 0) await deleteQueueEntries(toRemoveSeqs);
      this.queue = survivorsQueue;
      this.queueSeqs = survivorsSeqs;

      const moves = await getMovesForGame(this.code);
      // Mark moves undone for anything we removed (offending + illegal
      // survivors). Best-effort matching by kind/color/index against
      // whichever moves are still marked not undone.
      const removedDescriptors = [this.describeMutation(batch[body.index]), ...toRemoveDescriptors];
      for (const move of moves.filter((m) => !m.undone).reverse()) {
        const descriptor = move.kind === 'mark' ? `mark:${move.color}:${move.index}` : 'penalty';
        const idx = removedDescriptors.indexOf(descriptor);
        if (idx !== -1) {
          await markMoveUndone(move.seq);
          removedDescriptors.splice(idx, 1);
        }
      }

      await this.persistSheetRecord();
      await this.refreshCanUndo();
      this.backoffIndex = 0;

      const reason = body.reason ?? 'nothing_to_undo';
      this.setToast(REASON_MESSAGES[reason]);
      this.emit();
      if (this.queue.length > 0) this.kickFlush();
      return true;
    }

    if (err.status === 409 && err.body.error === 'wrong_status') {
      await deleteQueueEntries(batchSeqs);
      this.removeQueueEntriesBySeq(batchSeqs);
      this.gameStatus = 'ended';
      await this.persistSheetRecord();
      this.stopFlushing();
      this.emit();
      return true;
    }

    if (err.status === 403 || err.status === 404) {
      await deleteQueueEntries(this.queueSeqs);
      this.queue = [];
      this.queueSeqs = [];
      this.setToast('You are no longer in this game.');
      this.stopFlushing();
      return true;
    }

    // 5xx or anything unexpected: leave the queue untouched, retry with backoff.
    this.scheduleBackoffRetry();
    return false;
  }

  private describeMutation(mutation: QueuedMutation): string {
    if (mutation.type === 'mark') return `mark:${mutation.color}:${mutation.index}`;
    if (mutation.type === 'penalty') return 'penalty';
    return mutation.undoes.type === 'mark' ? `mark:${mutation.undoes.color}:${mutation.undoes.index}` : 'penalty';
  }

  private scheduleBackoffRetry(): void {
    const delay = BACKOFF_SCHEDULE[Math.min(this.backoffIndex, BACKOFF_SCHEDULE.length - 1)];
    this.backoffIndex++;
    setTimeout(() => {
      if (!this.stopped && this.queue.length > 0) void this.flush();
    }, delay);
  }

  private stopFlushing(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async persistSheetRecord(): Promise<void> {
    const record: SheetRecord = {
      code: this.code,
      serverSheet: this.serverSheet,
      lastAckedVersion: this.lastAckedVersion,
      lockedRows: this.lockedRows,
      gameStatus: this.gameStatus,
    };
    await putSheetRecord(record);
  }

  // 8.6 Poll and reconciliation

  async applyPollResult(res: GameStateResponse): Promise<void> {
    await putSnapshot({ code: this.code, fetchedAt: Date.now(), data: res });

    this.lockedRows = res.game.lockedRows;
    this.gameStatus = res.game.status;

    if (res.you.version === this.lastAckedVersion) {
      // agree, do nothing to serverSheet
    } else if (res.you.version < this.lastAckedVersion) {
      // stale read, ignore
    } else if (this.queue.length === 0) {
      const you = res.players.find((p) => p.playerId === res.you.playerId);
      if (you) {
        this.serverSheet = { crosses: you.crosses, locks: you.locks, penalties: you.penalties };
        this.lastAckedVersion = res.you.version;
      }
    }
    // else: queue non-empty and server ahead, let the flush own it.

    await this.persistSheetRecord();

    if (res.game.status === 'ended') {
      await deleteQueueEntries(this.queueSeqs);
      this.queue = [];
      this.queueSeqs = [];
      this.stopFlushing();
    }

    this.emit();
  }

  destroy(): void {
    this.stopFlushing();
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.listeners.clear();
  }
}

export { POLL_INTERVAL_MS };
