import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreSheet } from './ScoreSheet';
import type { Sheet, LockedRows } from '@/lib/scoring';

const emptySheet: Sheet = {
  crosses: { red: [], yellow: [], green: [], blue: [] },
  locks: { red: false, yellow: false, green: false, blue: false },
  penalties: 0,
};

const noLocks: LockedRows = { red: null, yellow: null, green: null, blue: null };

describe('ScoreSheet: self lock vs remote closure (finding B5)', () => {
  it('this player locking their own row does NOT mark the row closed', () => {
    const sheet: Sheet = { ...emptySheet, locks: { ...emptySheet.locks, red: true } };
    const lockedRows: LockedRows = { ...noLocks, red: 'me' };
    const html = renderToStaticMarkup(
      <ScoreSheet
        sheet={sheet}
        lockedRows={lockedRows}
        myPlayerId="me"
        displayNameById={new Map([['me', 'You']])}
        onCross={() => {}}
        onPenalty={() => {}}
      />,
    );
    // The lock is still visible via LockCell's own "locked" state...
    expect(html).toContain('Lock red, locked');
    // ...but nothing describes the row as closed, and no "Closed by" text renders,
    // because closedByName must be null for a colour this player closed themselves.
    expect(html).not.toContain('Closed by');
    expect(html).not.toContain('row closed by');
  });

  it('a remote player locking the row DOES mark it closed, with their name', () => {
    const sheet: Sheet = emptySheet; // this player never locked it
    const lockedRows: LockedRows = { ...noLocks, red: 'them' };
    const html = renderToStaticMarkup(
      <ScoreSheet
        sheet={sheet}
        lockedRows={lockedRows}
        myPlayerId="me"
        displayNameById={new Map([['them', 'Alex']])}
        onCross={() => {}}
        onPenalty={() => {}}
      />,
    );
    expect(html).toContain('Closed by Alex');
    expect(html).toContain('row closed by Alex');
    expect(html).toContain('Lock red, closed by Alex');
  });

  it('open cells in a self-locked row stay interactive, not disabled as "closed"', () => {
    // Locking a row only fills the lock cell itself; the number cells to its right
    // never existed at 5+ crosses, but any earlier open cell layout must not be
    // disabled for a "closed by yourself" reason.
    const sheet: Sheet = {
      ...emptySheet,
      crosses: { ...emptySheet.crosses, red: [0, 1, 2, 3, 4] },
      locks: { ...emptySheet.locks, red: true },
    };
    const lockedRows: LockedRows = { ...noLocks, red: 'me' };
    const html = renderToStaticMarkup(
      <ScoreSheet
        sheet={sheet}
        lockedRows={lockedRows}
        myPlayerId="me"
        displayNameById={new Map([['me', 'You']])}
        onCross={() => {}}
        onPenalty={() => {}}
      />,
    );
    expect(html).not.toContain('row closed by You');
  });
});
