'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { Color } from '@/lib/scoring';
import { ROW_CLASSES } from './RowGlyph';

export type CellState = 'open' | 'crossed' | 'blocked';

interface NumberCellProps {
  color: Color;
  number: number;
  state: CellState;
  onPress: () => void;
  /** Display name of the player who closed this colour game-wide, or null when the row is open. */
  closedByName?: string | null;
}

export function NumberCell({ color, number, state, onPress, closedByName = null }: NumberCellProps) {
  const reduceMotion = useReducedMotion();
  const ink = ROW_CLASSES[color].ink;
  const colorName = color.charAt(0).toUpperCase() + color.slice(1);
  const closed = closedByName !== null;

  // A cell left of the rightmost cross. Skipped permanently by the game's own rules,
  // independent of whether the row later closed.
  if (state === 'blocked') {
    return (
      <button
        type="button"
        disabled
        className="relative flex h-cell w-full min-w-6 items-center justify-center rounded-cell border border-qx-line text-base font-medium opacity-60"
        aria-label={`${colorName} ${number}, no longer available`}
      >
        <span aria-hidden="true">{number}</span>
        <span aria-hidden="true" className="absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-current" />
      </button>
    );
  }

  // An otherwise-open cell whose colour closed game-wide before this player crossed it.
  // Distinct reason, distinct name, from a cell that was skipped by this player's own play.
  if (state === 'open' && closed) {
    return (
      <button
        type="button"
        disabled
        className="relative flex h-cell w-full min-w-6 items-center justify-center rounded-cell border border-qx-line text-base font-medium opacity-60"
        aria-label={`${colorName} ${number}, row closed by ${closedByName}`}
      >
        <span aria-hidden="true">{number}</span>
      </button>
    );
  }

  const pressed = state === 'crossed';

  return (
    <motion.button
      type="button"
      onClick={onPress}
      disabled={closed}
      aria-pressed={pressed}
      aria-label={pressed ? `${colorName} ${number}, crossed off` : `Cross off ${color} ${number}`}
      whileTap={reduceMotion ? undefined : { scale: 0.92 }}
      animate={pressed && !reduceMotion ? { scale: [1, 1.08, 1] } : undefined}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={`relative flex h-cell w-full min-w-6 items-center justify-center rounded-cell border-2 text-base font-semibold ${ink} focus-visible:outline-2 focus-visible:outline-offset-2 ${
        pressed ? 'border-current bg-qx-surface' : 'border-qx-line bg-qx-surface'
      } ${closed ? 'opacity-70' : ''}`}
    >
      <span aria-hidden="true">{number}</span>
      {pressed && (
        <svg aria-hidden="true" className="absolute inset-0" viewBox="0 0 24 24">
          <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <line x1="20" y1="4" x2="4" y2="20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      )}
    </motion.button>
  );
}
