'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getHistory, type HistoryResponse } from '@/lib/api';
import { ROW_LABEL } from '@/components/RowGlyph';
import { COLORS } from '@/lib/scoring';

export default function HistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHistory()
      .then(setData)
      .catch(() => setError('Could not load history.'));
  }, []);

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-md flex-col gap-3 px-3 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-qx-text">History</h1>
        <Link href="/" className="text-sm font-medium text-qx-text underline">
          Home
        </Link>
      </div>

      {error && <p className="text-sm text-qx-danger">{error}</p>}
      {!error && !data && <p className="text-sm text-qx-muted">Loading…</p>}
      {data && data.games.length === 0 && (
        <p className="text-sm text-qx-muted">No finished games yet.</p>
      )}

      <div className="flex flex-col gap-2">
        {data?.games.map((game) => (
          <div key={game.gameId} className="rounded-card border border-qx-line bg-qx-surface p-3">
            <div className="mb-1 flex items-center justify-between text-sm font-semibold text-qx-text">
              <span>{game.code}</span>
              <span>{new Date(game.endedAt).toLocaleDateString()}</span>
            </div>
            {game.abandoned ? (
              <p className="text-xs text-qx-muted">Abandoned</p>
            ) : (
              <p className="text-xs text-qx-muted">{game.youWon ? 'You won' : 'You did not win'}</p>
            )}
            <ul className="mt-2 flex flex-col gap-1">
              {game.players.map((p) => (
                <li key={p.playerId} className="flex items-center justify-between text-xs text-qx-text">
                  <span>{p.displayName}</span>
                  <span className="flex gap-2 text-qx-muted">
                    {COLORS.map((c) => (
                      <span key={c}>
                        {ROW_LABEL[c][0]}
                        {p.rows[c]}
                      </span>
                    ))}
                    <span className="font-semibold text-qx-text">{p.finalScore ?? 0}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </main>
  );
}
