'use client';

import { useEffect, useRef, useState } from 'react';
import { COLORS, type Color, type LockedRows, type Sheet } from '@/lib/scoring';
import { ScoreRow } from './ScoreRow';
import { PenaltyTrack } from './PenaltyTrack';
import { ROW_LABEL } from './RowGlyph';

interface ScoreSheetProps {
  sheet: Sheet;
  lockedRows: LockedRows;
  /** This player's own id. A colour closed by this id is your own lock, not a remote closure. */
  myPlayerId: string;
  displayNameById: Map<string, string>;
  onCross: (color: Color, index: number) => void;
  onPenalty: () => void;
}

export function ScoreSheet({ sheet, lockedRows, myPlayerId, displayNameById, onCross, onPenalty }: ScoreSheetProps) {
  const [closureAnnouncement, setClosureAnnouncement] = useState('');
  const prevLockedRowsRef = useRef<LockedRows | null>(null);

  // Announce a remote closure only. lockedRows[color] === myPlayerId means this
  // player closed the colour themselves, which is not a remote event and must stay
  // silent here — it is already conveyed by LockCell's own "locked" state.
  useEffect(() => {
    const prev = prevLockedRowsRef.current;
    prevLockedRowsRef.current = lockedRows;
    if (!prev) return;
    for (const color of COLORS) {
      const closerId = lockedRows[color];
      if (prev[color] === null && closerId !== null && closerId !== myPlayerId) {
        const name = displayNameById.get(closerId) ?? 'another player';
        setClosureAnnouncement(`${ROW_LABEL[color]} row closed by ${name}.`);
        return;
      }
    }
  }, [lockedRows, myPlayerId, displayNameById]);

  return (
    <div className="flex flex-col gap-2 px-3">
      <p role="status" aria-live="polite" className="sr-only">
        {closureAnnouncement}
      </p>
      {COLORS.map((color) => {
        const closerId = lockedRows[color];
        // Only a colour closed by someone else counts as "closed" for this row's
        // consumers. This player's own lock is conveyed separately, by LockCell's
        // "locked" state, which is derived from sheet.locks[color] instead.
        const closedByName =
          closerId && closerId !== myPlayerId ? (displayNameById.get(closerId) ?? 'another player') : null;
        return (
          <ScoreRow
            key={color}
            color={color}
            sheet={sheet}
            closedByName={closedByName}
            onCross={(index) => onCross(color, index)}
          />
        );
      })}
      <PenaltyTrack penalties={sheet.penalties} onAddPenalty={onPenalty} />
    </div>
  );
}
