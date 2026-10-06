'use client';

import { useState } from 'react';
import type { GamePlayerView } from '@/lib/api';

interface LobbyProps {
  code: string;
  players: GamePlayerView[];
  hostPlayerId: string;
  you: { playerId: string; seat: number };
  onStart: () => void;
  starting: boolean;
}

export function Lobby({ code, players, hostPlayerId, you, onStart, starting }: LobbyProps) {
  const [origin] = useState(() => (typeof window !== 'undefined' ? window.location.origin : ''));
  const shareLink = `${origin}/g/${code}`;
  const isHost = you.playerId === hostPlayerId;
  const canStart = isHost && players.length >= 2 && players.length <= 5;

  return (
    <div className="flex flex-col gap-4 px-3 py-6">
      <div className="text-center">
        <p className="text-sm text-qx-muted">Game code</p>
        <h1 className="text-4xl font-bold tracking-widest text-qx-text">{code}</h1>
      </div>

      <div className="rounded-card border border-qx-line bg-qx-surface p-3">
        <p className="mb-1 text-xs font-medium text-qx-muted">Share link</p>
        <p className="break-all text-sm text-qx-text">{shareLink}</p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-qx-text">Players</h2>
        <ul className="flex flex-col gap-1.5">
          {players.map((p) => (
            <li
              key={p.playerId}
              className="flex min-h-11 items-center justify-between rounded-cell border border-qx-line bg-qx-surface px-3 text-sm"
            >
              <span className="text-qx-text">{p.displayName}</span>
              {p.playerId === hostPlayerId && (
                <span className="text-xs font-medium text-qx-muted">Host</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {isHost ? (
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart || starting}
          className="min-h-tap rounded-cell bg-qx-text px-4 text-sm font-semibold text-qx-surface focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
        >
          {players.length < 2 ? 'Waiting for a second player' : starting ? 'Starting…' : 'Start game'}
        </button>
      ) : (
        <p className="text-center text-sm text-qx-muted">Waiting for the host to start the game.</p>
      )}
    </div>
  );
}
