'use client';

import { useState } from 'react';

interface CollapsibleProps {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function Collapsible({ id, title, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `${id}-panel`;
  const buttonId = `${id}-button`;

  return (
    <div className="rounded-card border border-qx-line bg-qx-surface">
      <h2>
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-tap w-full items-center justify-between px-4 text-left text-base font-semibold text-qx-text focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {title}
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open} className="px-4 pb-4">
        {children}
      </div>
    </div>
  );
}
