// PURE scoring and rules engine.
//
// This module imports nothing except types from lib/types.ts. It must never:
// - import React or anything from next/*
// - perform network calls
// - call Date.now(), new Date(), performance.now()
// - call Math.random() or crypto
// - mutate any argument
//
// Every function returns new objects.

import type { Color } from './types';

export type { Color };

export const COLORS: readonly Color[] = ['red', 'yellow', 'green', 'blue'];

export const ROW_LENGTH = 11;
export const LOCK_INDEX = 10;
export const MAX_PENALTIES = 4;
export const PENALTY_POINTS = -5;
export const MIN_CROSSES_TO_LOCK = 5;
export const LOCKS_TO_END_GAME = 2;

const ASCENDING_COLORS = new Set<Color>(['red', 'yellow']);

export interface Sheet {
  crosses: Record<Color, number[]>;
  locks: Record<Color, boolean>;
  penalties: number;
}

export type LockedRows = Record<Color, string | null>;

export interface PlayerState {
  playerId: string;
  seat: number;
  sheet: Sheet;
}

export interface GameState {
  players: PlayerState[];
  lockedRows: LockedRows;
}

export interface SheetScore {
  rows: Record<Color, number>;
  rowsTotal: number;
  penaltyPoints: number;
  total: number;
}

export type RejectReason =
  | 'out_of_range'
  | 'row_closed'
  | 'not_strictly_right'
  | 'lock_requires_five'
  | 'max_penalties'
  | 'nothing_to_undo';

export type Legality =
  | { ok: true; locksRow: boolean }
  | { ok: false; reason: RejectReason };

export type EndReason = 'penalties' | 'two_locks';

export interface Standing {
  playerId: string;
  seat: number;
  rows: Record<Color, number>;
  total: number;
  penalties: number;
  bestRowCrosses: number;
  rank: number;
}

function isAscending(color: Color): boolean {
  return ASCENDING_COLORS.has(color);
}

export function numberAt(color: Color, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > ROW_LENGTH - 1) {
    throw new RangeError(`index out of range: ${index}`);
  }
  return isAscending(color) ? index + 2 : 12 - index;
}

export function indexOfNumber(color: Color, value: number): number {
  if (value < 2 || value > 12) return -1;
  const index = isAscending(color) ? value - 2 : 12 - value;
  if (index < 0 || index > ROW_LENGTH - 1) return -1;
  return index;
}

export function triangular(n: number): number {
  if (n < 0 || n > 12) {
    throw new RangeError(`triangular out of range: ${n}`);
  }
  return (n * (n + 1)) / 2;
}

export function scoreRow(crossCount: number, locked: boolean): number {
  return triangular(crossCount + (locked ? 1 : 0));
}

export function emptySheet(): Sheet {
  return {
    crosses: { red: [], yellow: [], green: [], blue: [] },
    locks: { red: false, yellow: false, green: false, blue: false },
    penalties: 0,
  };
}

export function emptyLockedRows(): LockedRows {
  return { red: null, yellow: null, green: null, blue: null };
}

export function crossCount(sheet: Sheet, color: Color): number {
  return sheet.crosses[color].length;
}

export function rightmostIndex(sheet: Sheet, color: Color): number {
  const arr = sheet.crosses[color];
  if (arr.length === 0) return -1;
  return arr[arr.length - 1];
}

export function scoreSheet(sheet: Sheet): SheetScore {
  const rows = {} as Record<Color, number>;
  let rowsTotal = 0;
  for (const c of COLORS) {
    const r = scoreRow(crossCount(sheet, c), sheet.locks[c]);
    rows[c] = r;
    rowsTotal += r;
  }
  const penaltyPoints = sheet.penalties === 0 ? 0 : sheet.penalties * PENALTY_POINTS;
  return { rows, rowsTotal, penaltyPoints, total: rowsTotal + penaltyPoints };
}

export function canCross(
  sheet: Sheet,
  lockedRows: LockedRows,
  color: Color,
  index: number,
): Legality {
  if (!Number.isInteger(index) || index < 0 || index > ROW_LENGTH - 1) {
    return { ok: false, reason: 'out_of_range' };
  }
  if (lockedRows[color] !== null) {
    return { ok: false, reason: 'row_closed' };
  }
  if (!(index > rightmostIndex(sheet, color))) {
    return { ok: false, reason: 'not_strictly_right' };
  }
  if (index === LOCK_INDEX) {
    if (crossCount(sheet, color) < MIN_CROSSES_TO_LOCK) {
      return { ok: false, reason: 'lock_requires_five' };
    }
  }
  return { ok: true, locksRow: index === LOCK_INDEX };
}

export function applyCross(
  sheet: Sheet,
  lockedRows: LockedRows,
  color: Color,
  index: number,
  playerId: string,
): { sheet: Sheet; lockedRows: LockedRows; lockedNow: boolean } {
  const legality = canCross(sheet, lockedRows, color, index);
  if (!legality.ok) {
    throw new Error(legality.reason);
  }

  const newCrosses = { ...sheet.crosses, [color]: [...sheet.crosses[color], index] };
  const locksRow = index === LOCK_INDEX;
  const newLocks = locksRow ? { ...sheet.locks, [color]: true } : sheet.locks;
  const newSheet: Sheet = { crosses: newCrosses, locks: newLocks, penalties: sheet.penalties };

  if (locksRow) {
    const newLockedRows = { ...lockedRows, [color]: playerId };
    return { sheet: newSheet, lockedRows: newLockedRows, lockedNow: true };
  }

  return { sheet: newSheet, lockedRows, lockedNow: false };
}

export function canPenalty(sheet: Sheet): Legality {
  if (sheet.penalties >= MAX_PENALTIES) {
    return { ok: false, reason: 'max_penalties' };
  }
  return { ok: true, locksRow: false };
}

export function applyPenalty(sheet: Sheet): Sheet {
  const legality = canPenalty(sheet);
  if (!legality.ok) {
    throw new Error(legality.reason);
  }
  return { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties + 1 };
}

export function canUndoCross(sheet: Sheet, color: Color, index: number): boolean {
  const rightmost = rightmostIndex(sheet, color);
  return rightmost !== -1 && index === rightmost;
}

export function undoCross(
  sheet: Sheet,
  lockedRows: LockedRows,
  color: Color,
  index: number,
  playerId: string,
): { sheet: Sheet; lockedRows: LockedRows } {
  if (!canUndoCross(sheet, color, index)) {
    throw new Error('nothing_to_undo');
  }

  const newCrosses = { ...sheet.crosses, [color]: sheet.crosses[color].slice(0, -1) };
  const wasLock = index === LOCK_INDEX;
  const newLocks = wasLock ? { ...sheet.locks, [color]: false } : sheet.locks;
  const newSheet: Sheet = { crosses: newCrosses, locks: newLocks, penalties: sheet.penalties };

  if (wasLock && lockedRows[color] === playerId) {
    const newLockedRows = { ...lockedRows, [color]: null };
    return { sheet: newSheet, lockedRows: newLockedRows };
  }

  return { sheet: newSheet, lockedRows };
}

export function undoPenalty(sheet: Sheet): Sheet {
  if (sheet.penalties === 0) {
    throw new Error('nothing_to_undo');
  }
  return { crosses: sheet.crosses, locks: sheet.locks, penalties: sheet.penalties - 1 };
}

export function lockedColorCount(lockedRows: LockedRows): number {
  return COLORS.reduce((count, c) => count + (lockedRows[c] !== null ? 1 : 0), 0);
}

export function checkGameEnd(state: GameState): { ended: boolean; reason: EndReason | null } {
  const anyMaxPenalties = state.players.some((p) => p.sheet.penalties >= MAX_PENALTIES);
  if (anyMaxPenalties) {
    return { ended: true, reason: 'penalties' };
  }
  if (lockedColorCount(state.lockedRows) >= LOCKS_TO_END_GAME) {
    return { ended: true, reason: 'two_locks' };
  }
  return { ended: false, reason: null };
}

function bestRowCrossesFor(sheet: Sheet): number {
  return Math.max(...COLORS.map((c) => crossCount(sheet, c)));
}

export function rankPlayers(state: GameState): Standing[] {
  const built = state.players.map((p) => {
    const score = scoreSheet(p.sheet);
    return {
      playerId: p.playerId,
      seat: p.seat,
      rows: score.rows,
      total: score.total,
      penalties: p.sheet.penalties,
      bestRowCrosses: bestRowCrossesFor(p.sheet),
      rank: 0,
    } satisfies Standing;
  });

  const sorted = [...built].sort((a, b) => {
    if (a.total !== b.total) return b.total - a.total;
    if (a.penalties !== b.penalties) return a.penalties - b.penalties;
    if (a.bestRowCrosses !== b.bestRowCrosses) return b.bestRowCrosses - a.bestRowCrosses;
    return a.seat - b.seat;
  });

  const isTied = (x: Standing, y: Standing) =>
    x.total === y.total && x.penalties === y.penalties && x.bestRowCrosses === y.bestRowCrosses;

  const result: Standing[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const rank = i > 0 && isTied(sorted[i], sorted[i - 1]) ? result[i - 1].rank : i + 1;
    result.push({ ...sorted[i], rank });
  }

  return result;
}

export function resolveWinners(state: GameState): { winners: string[]; standings: Standing[] } {
  const standings = rankPlayers(state);
  const winners = standings.filter((s) => s.rank === 1).map((s) => s.playerId);
  return { winners, standings };
}
