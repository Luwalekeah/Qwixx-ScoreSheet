'use client';

import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { COLORS, type Standing } from '@/lib/scoring';
import { ROW_LABEL } from './RowGlyph';

interface GameOverProps {
  standings: Standing[];
  winnerPlayerId: string | null;
  displayNameById: Map<string, string>;
}

export function GameOver({ standings, winnerPlayerId, displayNameById }: GameOverProps) {
  const reduceMotion = useReducedMotion();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const winners = standings.filter((s) => s.rank === 1);
  const isTie = winnerPlayerId === null && winners.length > 1;
  const resultText = isTie
    ? `It's a tie between ${winners.map((w) => displayNameById.get(w.playerId) ?? 'a player').join(' and ')}`
    : `${displayNameById.get(winnerPlayerId ?? '') ?? 'A player'} wins`;

  return (
    <motion.div
      className="flex flex-col gap-4 px-3 py-6"
      initial={reduceMotion ? undefined : { opacity: 0 }}
      animate={reduceMotion ? undefined : { opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <p role="status" className="sr-only">
        Game over. {resultText}.
      </p>
      <h1 ref={headingRef} tabIndex={-1} className="text-center text-2xl font-bold text-qx-text focus:outline-none">
        {resultText}
      </h1>

      <div className="flex flex-col gap-2">
        {standings.map((s) => (
          <div key={s.playerId} className="rounded-card border border-qx-line bg-qx-surface p-3">
            <div className="mb-1 flex items-center justify-between text-sm font-semibold text-qx-text">
              <span>
                #{s.rank} {displayNameById.get(s.playerId) ?? 'Player'}
              </span>
              <span>{s.total} pts</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs text-qx-muted">
              {COLORS.map((color) => (
                <div key={color} className="flex flex-col">
                  <span>{ROW_LABEL[color]}</span>
                  <span className="font-semibold text-qx-text">{s.rows[color]}</span>
                </div>
              ))}
            </div>
            <p className="mt-1 text-xs text-qx-muted">{s.penalties} penalties</p>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
