'use client';

import { MAX_PENALTIES } from '@/lib/scoring';

interface PenaltyTrackProps {
  penalties: number;
  onAddPenalty: () => void;
}

export function PenaltyTrack({ penalties, onAddPenalty }: PenaltyTrackProps) {
  const boxes = Array.from({ length: MAX_PENALTIES }, (_, i) => i < penalties);
  const atMax = penalties >= MAX_PENALTIES;

  return (
    <section className="rounded-card border-2 border-qx-line bg-qx-surface p-3">
      <div className="mb-2 flex items-center justify-between text-sm font-semibold text-qx-text">
        <span>Penalties</span>
        <span className="text-qx-muted">-5 each</span>
      </div>
      <div className="flex gap-2">
        {boxes.map((filled, i) => (
          <button
            key={i}
            type="button"
            disabled={filled || atMax}
            onClick={onAddPenalty}
            aria-pressed={filled}
            aria-label={filled ? `Penalty ${i + 1}, marked` : `Add a penalty`}
            className={`flex h-16 w-16 items-center justify-center rounded-cell border-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 ${
              filled ? 'border-qx-danger bg-qx-red-tint text-qx-danger' : 'border-qx-line bg-qx-canvas text-qx-muted'
            }`}
          >
            {filled ? '-5' : ''}
          </button>
        ))}
      </div>
    </section>
  );
}
