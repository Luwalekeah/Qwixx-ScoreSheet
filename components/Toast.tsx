'use client';

import { useEffect } from 'react';

interface ToastProps {
  message: string | null;
  onDismiss: () => void;
}

export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-14 z-20 flex justify-center px-3">
      {message && (
        <div className="pointer-events-auto rounded-cell bg-qx-text px-4 py-2 text-sm text-qx-surface shadow-lg">
          {message}
        </div>
      )}
    </div>
  );
}
