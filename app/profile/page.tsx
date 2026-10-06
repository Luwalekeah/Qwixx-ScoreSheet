'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getProfile, type ProfileResponse } from '@/lib/api';
import { ROW_LABEL } from '@/components/RowGlyph';

export default function ProfilePage() {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProfile()
      .then(setData)
      .catch(() => setError('Could not load your profile.'));
  }, []);

  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-3 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-qx-text">Profile</h1>
        <Link href="/" className="text-sm font-medium text-qx-text underline">
          Home
        </Link>
      </div>

      {error && <p className="text-sm text-qx-danger">{error}</p>}
      {!error && !data && <p className="text-sm text-qx-muted">Loading…</p>}

      {data && (
        <>
          <p className="text-base font-semibold text-qx-text">{data.displayName}</p>

          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Games played</dt>
              <dd className="text-lg font-semibold text-qx-text">{data.gamesPlayed}</dd>
            </div>
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Games won</dt>
              <dd className="text-lg font-semibold text-qx-text">{data.gamesWon}</dd>
            </div>
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Win rate</dt>
              <dd className="text-lg font-semibold text-qx-text">{Math.round(data.winRate * 100)}%</dd>
            </div>
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Average score</dt>
              <dd className="text-lg font-semibold text-qx-text">{data.averageScore}</dd>
            </div>
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Best score</dt>
              <dd className="text-lg font-semibold text-qx-text">{data.bestScore}</dd>
            </div>
            <div className="rounded-card border border-qx-line bg-qx-surface p-3">
              <dt className="text-xs text-qx-muted">Best row</dt>
              <dd className="text-lg font-semibold text-qx-text">
                {data.bestRow ? `${ROW_LABEL[data.bestRow.color]} ${data.bestRow.points}` : '—'}
              </dd>
            </div>
          </dl>

          {data.abandonedGames > 0 && (
            <p className="text-xs text-qx-muted">
              {data.abandonedGames} abandoned game{data.abandonedGames === 1 ? '' : 's'} excluded from these
              stats.
            </p>
          )}
        </>
      )}
    </main>
  );
}
