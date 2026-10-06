'use client';

interface TotalBarProps {
  total: number;
  canUndo: boolean;
  onUndo: () => void;
}

export function TotalBar({ total, canUndo, onUndo }: TotalBarProps) {
  return (
    <div
      className="sticky bottom-0 z-10 flex h-16 items-center justify-between border-t border-qx-line bg-qx-surface px-3"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="text-base font-semibold text-qx-text">
        <span aria-live="polite">Total {total}</span>
      </div>
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        className="min-h-tap rounded-cell border-2 border-qx-line bg-qx-canvas px-4 text-sm font-semibold text-qx-text focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
      >
        Undo
      </button>
    </div>
  );
}
