'use client';

import type { Color } from '@/lib/scoring';
import { ROW_CLASSES } from './RowGlyph';

export type LockCellState = 'unavailable' | 'available' | 'locked';

interface LockCellProps {
  color: Color;
  state: LockCellState;
  onPress: () => void;
  /** Display name of the player who closed this colour game-wide, or null when the row is open. */
  closedByName?: string | null;
}

function PadlockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16">
      <rect x="5" y="11" width="14" height="9" rx="1.5" fill="currentColor" />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LockCell({ color, state, onPress, closedByName = null }: LockCellProps) {
  const ink = ROW_CLASSES[color].ink;
  const base = 'flex h-cell w-full min-w-6 flex-col items-center justify-center gap-0.5 rounded-cell text-[10px]';

  // This player's own lock mark. The single most consequential move in the game,
  // so it must stay in the accessibility tree, not be hidden.
  if (state === 'locked') {
    return (
      <button
        type="button"
        disabled
        aria-pressed={true}
        aria-label={`Lock ${color}, locked`}
        className={`${base} border-2 border-current bg-qx-surface font-semibold ${ink}`}
      >
        <PadlockIcon />
        <span aria-hidden="true">Locked</span>
      </button>
    );
  }

  // Closed game-wide by someone else. Distinct from "five crosses needed": the lock
  // is gone entirely, not merely out of reach.
  if (closedByName !== null) {
    return (
      <button
        type="button"
        disabled
        aria-label={`Lock ${color}, closed by ${closedByName}`}
        className={`${base} border border-qx-line font-medium opacity-40 ${ink}`}
      >
        <PadlockIcon />
        <span aria-hidden="true">Closed</span>
      </button>
    );
  }

  if (state === 'unavailable') {
    return (
      <button
        type="button"
        disabled
        aria-label={`Lock ${color}, five crosses needed`}
        className={`${base} border border-qx-line font-medium opacity-40 ${ink}`}
      >
        <PadlockIcon />
        <span>5 needed</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={false}
      aria-label={`Lock ${color}`}
      className={`${base} border-2 border-qx-line bg-qx-surface font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 ${ink}`}
    >
      <PadlockIcon />
      <span>Lock</span>
    </button>
  );
}
