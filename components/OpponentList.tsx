'use client';

import { COLORS } from '@/lib/scoring';
import type { GamePlayerView } from '@/lib/api';
import { ROW_LABEL } from './RowGlyph';

interface OpponentListProps {
  players: GamePlayerView[];
}

export function OpponentList({ players }: OpponentListProps) {
  if (players.length === 0) return null;

  return (
    <section aria-label="Other players" className="flex flex-col gap-1.5 px-3 py-3">
      <h2 className="text-sm font-semibold text-qx-text">Other players</h2>
      {players.map((player) => (
        <details
          key={player.playerId}
          className="group rounded-card border border-qx-line bg-qx-surface px-3 py-2"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-qx-muted group-open:hidden">
                +
              </span>
              <span aria-hidden="true" className="hidden text-qx-muted group-open:inline">
                −
              </span>
              <span className="font-medium text-qx-text">{player.displayName}</span>
            </span>
            <span className="flex items-center gap-3 text-qx-muted">
              <span>{player.total} pts</span>
              <span>{player.penalties} penalties</span>
            </span>
          </summary>
          <dl className="mt-2 grid grid-cols-4 gap-2 text-xs text-qx-muted">
            {COLORS.map((color) => (
              <div key={color} className="flex flex-col">
                <dt>{ROW_LABEL[color]}</dt>
                <dd className="font-semibold text-qx-text">{player.crosses[color].length}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </section>
  );
}
