import { describe, it, expect } from 'vitest';
import {
  COLORS,
  triangular,
  scoreRow,
  numberAt,
  indexOfNumber,
  emptySheet,
  emptyLockedRows,
  scoreSheet,
  canCross,
  applyCross,
  canPenalty,
  applyPenalty,
  canUndoCross,
  undoCross,
  undoPenalty,
  checkGameEnd,
  rankPlayers,
  resolveWinners,
  crossCount,
  rightmostIndex,
  lockedColorCount,
  type Sheet,
  type LockedRows,
  type GameState,
  type Color,
} from './scoring';

function sheetWith(overrides: {
  crosses?: Partial<Record<Color, number[]>>;
  locks?: Partial<Record<Color, boolean>>;
  penalties?: number;
}): Sheet {
  const base = emptySheet();
  return {
    crosses: { ...base.crosses, ...overrides.crosses },
    locks: { ...base.locks, ...overrides.locks },
    penalties: overrides.penalties ?? 0,
  };
}

function lockedRowsWith(overrides: Partial<LockedRows>): LockedRows {
  return { ...emptyLockedRows(), ...overrides };
}

describe('triangular and scoreRow', () => {
  it('triangular returns the full 0 to 12 table', () => {
    const expected = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 66, 78];
    for (let n = 0; n <= 12; n++) {
      expect(triangular(n)).toBe(expected[n]);
    }
  });

  it('triangular rejects out of range input', () => {
    expect(() => triangular(-1)).toThrow();
    expect(() => triangular(13)).toThrow();
  });

  it('scoreRow with no lock equals triangular of the cross count', () => {
    expect(scoreRow(0, false)).toBe(0);
    expect(scoreRow(3, false)).toBe(6);
    expect(scoreRow(11, false)).toBe(66);
  });

  it('REGRESSION bug 1: a locked row scores the lock as an extra mark, not a flat plus one', () => {
    expect(scoreRow(5, true)).toBe(21);
    expect(scoreRow(6, true)).toBe(28);
    expect(scoreRow(11, true)).toBe(78);
    expect(scoreRow(0, true)).toBe(1);
  });
});

describe('row geometry', () => {
  it('numberAt maps ascending rows 2 to 12', () => {
    expect(numberAt('red', 0)).toBe(2);
    expect(numberAt('red', 10)).toBe(12);
    expect(numberAt('yellow', 5)).toBe(7);
  });

  it('numberAt maps descending rows 12 to 2', () => {
    expect(numberAt('green', 0)).toBe(12);
    expect(numberAt('green', 10)).toBe(2);
    expect(numberAt('blue', 5)).toBe(7);
  });

  it('indexOfNumber inverts numberAt for all four rows', () => {
    for (const c of COLORS) {
      for (let i = 0; i <= 10; i++) {
        expect(indexOfNumber(c, numberAt(c, i))).toBe(i);
      }
    }
    expect(indexOfNumber('red', 13)).toBe(-1);
  });

  it('numberAt rejects an index outside the row', () => {
    expect(() => numberAt('red', -1)).toThrow();
    expect(() => numberAt('red', 11)).toThrow();
  });
});

describe('scoreSheet', () => {
  it('scoreSheet on an empty sheet totals zero', () => {
    const score = scoreSheet(emptySheet());
    expect(score.rowsTotal).toBe(0);
    expect(score.penaltyPoints).toBe(0);
    expect(score.total).toBe(0);
  });

  it('scoreSheet subtracts five points per penalty', () => {
    const sheet = sheetWith({ penalties: 3 });
    const score = scoreSheet(sheet);
    expect(score.penaltyPoints).toBe(-15);
    expect(score.total).toBe(-15);
  });

  it('scoreSheet sums four rows and penalties', () => {
    const sheet = sheetWith({
      crosses: {
        red: [0, 1, 2, 3, 4, 5],
        yellow: [0, 1, 2, 3],
        green: [0, 1],
        blue: [0],
      },
      penalties: 1,
    });
    const score = scoreSheet(sheet);
    expect(score.rows).toEqual({ red: 21, yellow: 10, green: 3, blue: 1 });
    expect(score.rowsTotal).toBe(35);
    expect(score.penaltyPoints).toBe(-5);
    expect(score.total).toBe(30);
  });

  it('scoreSheet on a maximum sheet totals 312', () => {
    const allIndexes = Array.from({ length: 11 }, (_, i) => i);
    const sheet = sheetWith({
      crosses: { red: allIndexes, yellow: allIndexes, green: allIndexes, blue: allIndexes },
      locks: { red: true, yellow: true, green: true, blue: true },
      penalties: 0,
    });
    const score = scoreSheet(sheet);
    expect(score.rows.red).toBe(78);
    expect(score.rows.yellow).toBe(78);
    expect(score.rows.green).toBe(78);
    expect(score.rows.blue).toBe(78);
    expect(score.total).toBe(312);
  });
});

describe('canCross legality', () => {
  it('canCross rejects an index outside the row', () => {
    const sheet = emptySheet();
    const lockedRows = emptyLockedRows();
    expect(canCross(sheet, lockedRows, 'red', -1)).toEqual({ ok: false, reason: 'out_of_range' });
    expect(canCross(sheet, lockedRows, 'red', 11)).toEqual({ ok: false, reason: 'out_of_range' });
    expect(canCross(sheet, lockedRows, 'red', 2.5)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('canCross rejects any cross in a row closed game wide', () => {
    const sheet = emptySheet();
    const lockedRows = lockedRowsWith({ red: 'p2' });
    expect(canCross(sheet, lockedRows, 'red', 0)).toEqual({ ok: false, reason: 'row_closed' });
  });

  it('canCross rejects a cross in a row this player closed themselves', () => {
    const sheet = emptySheet();
    const lockedRows = lockedRowsWith({ red: 'p1' });
    expect(canCross(sheet, lockedRows, 'red', 0)).toEqual({ ok: false, reason: 'row_closed' });
  });

  it('REGRESSION bug 2: a cross must be strictly right of the rightmost existing cross', () => {
    const sheet = sheetWith({ crosses: { red: [0, 3] } });
    const lockedRows = emptyLockedRows();
    expect(canCross(sheet, lockedRows, 'red', 3)).toEqual({ ok: false, reason: 'not_strictly_right' });
    expect(canCross(sheet, lockedRows, 'red', 2)).toEqual({ ok: false, reason: 'not_strictly_right' });
    expect(canCross(sheet, lockedRows, 'red', 0)).toEqual({ ok: false, reason: 'not_strictly_right' });
    expect(canCross(sheet, lockedRows, 'red', 4)).toEqual({ ok: true, locksRow: false });
  });

  it('canCross allows any index on an empty open row', () => {
    const sheet = emptySheet();
    const lockedRows = emptyLockedRows();
    expect(canCross(sheet, lockedRows, 'red', 0).ok).toBe(true);
    expect(canCross(sheet, lockedRows, 'red', 9).ok).toBe(true);
  });

  it('REGRESSION bug 3: a lock needs the rightmost number and five crosses already held', () => {
    const lockedRows = emptyLockedRows();
    const fourCrosses = sheetWith({ crosses: { red: [0, 1, 2, 3] } });
    expect(canCross(fourCrosses, lockedRows, 'red', 10)).toEqual({ ok: false, reason: 'lock_requires_five' });

    const fiveCrosses = sheetWith({ crosses: { red: [0, 1, 2, 3, 4] } });
    expect(canCross(fiveCrosses, lockedRows, 'red', 10)).toEqual({ ok: true, locksRow: true });

    const tenCrosses = sheetWith({ crosses: { red: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] } });
    expect(canCross(tenCrosses, lockedRows, 'red', 10)).toEqual({ ok: true, locksRow: true });
  });

  it('canCross does not treat five crosses alone as a lock', () => {
    const sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4] } });
    const lockedRows = emptyLockedRows();
    expect(canCross(sheet, lockedRows, 'red', 7)).toEqual({ ok: true, locksRow: false });
  });

  it('canCross rejects re-crossing the lock cell', () => {
    const sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4, 10] } });
    const lockedRows = emptyLockedRows();
    expect(canCross(sheet, lockedRows, 'red', 10)).toEqual({ ok: false, reason: 'not_strictly_right' });
  });
});

describe('applyCross and locking', () => {
  it('applyCross appends the index and keeps the row ascending', () => {
    const sheet = sheetWith({ crosses: { red: [0, 3] } });
    const lockedRows = emptyLockedRows();
    const result = applyCross(sheet, lockedRows, 'red', 7, 'p1');
    expect(result.sheet.crosses.red).toEqual([0, 3, 7]);
  });

  it('applyCross does not mutate its arguments', () => {
    const sheet = sheetWith({ crosses: { red: [0, 3] } });
    Object.freeze(sheet.crosses.red);
    Object.freeze(sheet.crosses);
    Object.freeze(sheet.locks);
    Object.freeze(sheet);
    const lockedRows = emptyLockedRows();
    Object.freeze(lockedRows);

    expect(() => applyCross(sheet, lockedRows, 'red', 7, 'p1')).not.toThrow();
    expect(sheet.crosses.red).toEqual([0, 3]);
  });

  it("applyCross on the lock cell sets both this player's lock mark and the game wide closure", () => {
    const sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4] } });
    const lockedRows = emptyLockedRows();
    const result = applyCross(sheet, lockedRows, 'red', 10, 'p1');
    expect(result.sheet.crosses.red).toHaveLength(6);
    expect(result.sheet.locks.red).toBe(true);
    expect(result.lockedRows.red).toBe('p1');
    expect(result.lockedNow).toBe(true);
    expect(scoreSheet(result.sheet).rows.red).toBe(28);
  });

  it('applyCross throws when the move is illegal', () => {
    const sheet = emptySheet();
    const lockedRows = lockedRowsWith({ red: 'p2' });
    expect(() => applyCross(sheet, lockedRows, 'red', 0, 'p1')).toThrow('row_closed');
  });

  it('applyCross on a normal cell leaves lockedRows untouched', () => {
    const sheet = emptySheet();
    const lockedRows = emptyLockedRows();
    const result = applyCross(sheet, lockedRows, 'red', 4, 'p1');
    expect(result.lockedRows).toEqual(lockedRows);
  });
});

describe('penalties', () => {
  it('applyPenalty increments up to four', () => {
    let sheet = emptySheet();
    for (let i = 0; i < 4; i++) {
      sheet = applyPenalty(sheet);
    }
    expect(sheet.penalties).toBe(4);
  });

  it('canPenalty is false at four penalties', () => {
    const sheet = sheetWith({ penalties: 4 });
    expect(canPenalty(sheet)).toEqual({ ok: false, reason: 'max_penalties' });
  });

  it('applyPenalty throws at four penalties', () => {
    const sheet = sheetWith({ penalties: 4 });
    expect(() => applyPenalty(sheet)).toThrow();
  });

  it('applyPenalty does not mutate its argument', () => {
    const sheet = sheetWith({ penalties: 1 });
    Object.freeze(sheet);
    expect(() => applyPenalty(sheet)).not.toThrow();
    expect(sheet.penalties).toBe(1);
  });
});

describe('undo', () => {
  it('canUndoCross allows only the rightmost cross', () => {
    const sheet = sheetWith({ crosses: { red: [0, 3, 7] } });
    expect(canUndoCross(sheet, 'red', 7)).toBe(true);
    expect(canUndoCross(sheet, 'red', 3)).toBe(false);
    expect(canUndoCross(sheet, 'red', 9)).toBe(false);
  });

  it('canUndoCross is false on an empty row', () => {
    const sheet = emptySheet();
    expect(canUndoCross(sheet, 'red', 0)).toBe(false);
  });

  it('undoCross removes the cross and restores the previous rightmost', () => {
    const sheet = sheetWith({ crosses: { red: [0, 3, 7] } });
    const lockedRows = emptyLockedRows();
    const result = undoCross(sheet, lockedRows, 'red', 7, 'p1');
    expect(result.sheet.crosses.red).toEqual([0, 3]);
    expect(rightmostIndex(result.sheet, 'red')).toBe(3);
  });

  it("undoCross of a lock clears this player's lock mark and their own game wide closure", () => {
    const sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 10] },
      locks: { red: true },
    });
    const lockedRows = lockedRowsWith({ red: 'p1' });
    const result = undoCross(sheet, lockedRows, 'red', 10, 'p1');
    expect(result.sheet.crosses.red).toEqual([0, 1, 2, 3, 4]);
    expect(result.sheet.locks.red).toBe(false);
    expect(result.lockedRows.red).toBe(null);
  });

  it('undoCross of a lock does not clear a closure owned by another player', () => {
    const sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 10] },
      locks: { red: true },
    });
    const lockedRows = lockedRowsWith({ red: 'p2' });
    const result = undoCross(sheet, lockedRows, 'red', 10, 'p1');
    expect(result.sheet.locks.red).toBe(false);
    expect(result.lockedRows.red).toBe('p2');
  });

  it('undoPenalty decrements and throws at zero', () => {
    const sheet = sheetWith({ penalties: 1 });
    const result = undoPenalty(sheet);
    expect(result.penalties).toBe(0);
    expect(() => undoPenalty(emptySheet())).toThrow();
  });

  it('undo functions do not mutate their arguments', () => {
    const sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 10] },
      locks: { red: true },
      penalties: 1,
    });
    Object.freeze(sheet.crosses.red);
    Object.freeze(sheet.crosses);
    Object.freeze(sheet.locks);
    Object.freeze(sheet);
    const lockedRows = lockedRowsWith({ red: 'p1' });
    Object.freeze(lockedRows);

    expect(() => undoCross(sheet, lockedRows, 'red', 10, 'p1')).not.toThrow();
    expect(sheet.crosses.red).toEqual([0, 1, 2, 3, 4, 10]);
    expect(sheet.locks.red).toBe(true);
    expect(lockedRows.red).toBe('p1');

    expect(() => undoPenalty(sheet)).not.toThrow();
    expect(sheet.penalties).toBe(1);
  });
});

describe('game end', () => {
  it('REGRESSION bug 4a: the game ends when any player reaches four penalties', () => {
    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: sheetWith({ penalties: 4 }) },
        { playerId: 'p2', seat: 2, sheet: sheetWith({ penalties: 0 }) },
      ],
      lockedRows: emptyLockedRows(),
    };
    expect(checkGameEnd(state)).toEqual({ ended: true, reason: 'penalties' });
  });

  it('REGRESSION bug 4b: the game ends when two colours are locked game wide', () => {
    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: emptySheet() },
        { playerId: 'p2', seat: 2, sheet: emptySheet() },
      ],
      lockedRows: lockedRowsWith({ red: 'p1', green: 'p2' }),
    };
    expect(checkGameEnd(state)).toEqual({ ended: true, reason: 'two_locks' });
  });

  it('REGRESSION bug 4c: one locked colour and three penalties does not end the game', () => {
    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: sheetWith({ penalties: 3 }) },
        { playerId: 'p2', seat: 2, sheet: sheetWith({ penalties: 2 }) },
      ],
      lockedRows: lockedRowsWith({ red: 'p1' }),
    };
    expect(checkGameEnd(state)).toEqual({ ended: false, reason: null });
  });

  it('REGRESSION bug 4d: penalties take precedence over locks in the reported reason', () => {
    const state: GameState = {
      players: [{ playerId: 'p1', seat: 1, sheet: sheetWith({ penalties: 4 }) }],
      lockedRows: lockedRowsWith({ red: 'p1', blue: 'p1' }),
    };
    expect(checkGameEnd(state).reason).toBe('penalties');
  });

  it('checkGameEnd counts locks across all players, not per player', () => {
    const state: GameState = {
      players: [{ playerId: 'p1', seat: 1, sheet: emptySheet() }],
      lockedRows: lockedRowsWith({ red: 'p1', yellow: 'p1' }),
    };
    expect(checkGameEnd(state)).toEqual({ ended: true, reason: 'two_locks' });
  });
});

describe('winner and tiebreakers', () => {
  it('resolveWinners picks the highest total', () => {
    const p1Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 5], yellow: [0, 1, 2, 3], green: [0, 1, 2], blue: [0, 1, 2, 3, 4, 5, 6] },
    });
    const p2Sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4, 5] } });
    expect(scoreSheet(p1Sheet).total).toBe(65);
    expect(scoreSheet(p2Sheet).total).toBe(21);

    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: p1Sheet },
        { playerId: 'p2', seat: 2, sheet: p2Sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const { winners } = resolveWinners(state);
    expect(winners).toEqual(['p1']);
  });

  it('resolveWinners breaks a total tie by fewer penalties', () => {
    const p1Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 5], yellow: [0, 1, 2, 3], green: [0, 1], blue: [0] },
      penalties: 1,
    });
    const p2Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 5, 6], yellow: [0, 1, 2, 3], green: [0], blue: [0] },
      penalties: 2,
    });
    expect(scoreSheet(p1Sheet).total).toBe(30);
    expect(scoreSheet(p2Sheet).total).toBe(30);

    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: p1Sheet },
        { playerId: 'p2', seat: 2, sheet: p2Sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const { winners, standings } = resolveWinners(state);
    expect(winners).toEqual(['p1']);
    const p1Standing = standings.find((s) => s.playerId === 'p1')!;
    const p2Standing = standings.find((s) => s.playerId === 'p2')!;
    expect(p2Standing.bestRowCrosses).toBe(7);
    expect(p1Standing.bestRowCrosses).toBe(6);
  });

  it('resolveWinners breaks a total and penalty tie by most numbers crossed in a single row', () => {
    const p1Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4, 5], yellow: [0, 1, 2], green: [0, 1, 2], blue: [0] },
      penalties: 1,
    });
    const p2Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4], yellow: [0, 1, 2, 3, 4], green: [0, 1], blue: [0] },
      penalties: 1,
    });
    expect(scoreSheet(p1Sheet).total).toBe(29);
    expect(scoreSheet(p2Sheet).total).toBe(29);

    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: p1Sheet },
        { playerId: 'p2', seat: 2, sheet: p2Sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const { winners } = resolveWinners(state);
    expect(winners).toEqual(['p1']);
  });

  it('bestRowCrosses does not count the lock mark', () => {
    const p1Sheet = sheetWith({
      crosses: { red: [0, 1, 2, 3, 4] },
      locks: { red: true },
    });
    const p2Sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4, 5] } });
    expect(scoreSheet(p1Sheet).rows.red).toBe(21);
    expect(scoreSheet(p2Sheet).rows.red).toBe(21);

    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: p1Sheet },
        { playerId: 'p2', seat: 2, sheet: p2Sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const { winners } = resolveWinners(state);
    expect(winners).toEqual(['p2']);
  });

  it('resolveWinners returns every player when the game is fully tied', () => {
    const sheet = sheetWith({ crosses: { red: [0, 1, 2] }, penalties: 1 });
    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet },
        { playerId: 'p2', seat: 2, sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const { winners, standings } = resolveWinners(state);
    expect(winners).toHaveLength(2);
    expect(winners).toContain('p1');
    expect(winners).toContain('p2');
    expect(standings.every((s) => s.rank === 1)).toBe(true);
  });

  it('rankPlayers assigns dense shared ranks', () => {
    const topSheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4, 5] } });
    const lowSheet = sheetWith({ crosses: { red: [0] } });
    const state: GameState = {
      players: [
        { playerId: 'p1', seat: 1, sheet: topSheet },
        { playerId: 'p2', seat: 2, sheet: topSheet },
        { playerId: 'p3', seat: 3, sheet: lowSheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const standings = rankPlayers(state);
    const ranks = standings.map((s) => s.rank);
    expect(ranks).toEqual([1, 1, 3]);
  });

  it('rankPlayers is deterministic on full ties by ascending seat', () => {
    const sheet = sheetWith({ crosses: { red: [0, 1, 2] } });
    const state: GameState = {
      players: [
        { playerId: 'p2', seat: 2, sheet },
        { playerId: 'p1', seat: 1, sheet },
      ],
      lockedRows: emptyLockedRows(),
    };
    const standings = rankPlayers(state);
    expect(standings.map((s) => s.playerId)).toEqual(['p1', 'p2']);
  });
});

describe('purity', () => {
  it('the scoring module has no side effects', () => {
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    Date.now = () => {
      throw new Error('Date.now must not be called');
    };
    Math.random = () => {
      throw new Error('Math.random must not be called');
    };

    try {
      const sheet = sheetWith({ crosses: { red: [0, 1, 2, 3, 4] }, penalties: 1 });
      const lockedRows = emptyLockedRows();

      expect(() => {
        triangular(5);
        scoreRow(5, true);
        numberAt('red', 0);
        indexOfNumber('red', 2);
        emptySheet();
        emptyLockedRows();
        crossCount(sheet, 'red');
        rightmostIndex(sheet, 'red');
        scoreSheet(sheet);
        canCross(sheet, lockedRows, 'red', 10);
        applyCross(sheet, lockedRows, 'red', 10, 'p1');
        canPenalty(sheet);
        applyPenalty(sheet);
        canUndoCross(sheet, 'red', 4);
        undoCross(sheet, lockedRowsWith({ red: 'p1' }), 'red', 4, 'p1');
        undoPenalty(sheet);
        lockedColorCount(lockedRows);
        checkGameEnd({ players: [{ playerId: 'p1', seat: 1, sheet }], lockedRows });
        rankPlayers({ players: [{ playerId: 'p1', seat: 1, sheet }], lockedRows });
        resolveWinners({ players: [{ playerId: 'p1', seat: 1, sheet }], lockedRows });
      }).not.toThrow();
    } finally {
      Date.now = originalDateNow;
      Math.random = originalRandom;
    }
  });
});
