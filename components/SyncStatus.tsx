'use client';

import { useEffect, useRef, useState } from 'react';

interface SyncStatusProps {
  online: boolean;
  pendingCount: number;
}

export function SyncStatus({ online, pendingCount }: SyncStatusProps) {
  let label: string;
  if (!online) {
    label = 'Offline';
  } else if (pendingCount > 0) {
    label = `Saving ${pendingCount}`;
  } else {
    label = 'Synced';
  }

  // The visible label changes on nearly every tap (Saving -> Synced), which is too
  // chatty to announce. Only the transition into Offline is worth interrupting a
  // screen reader user for, so that is the only thing the live region carries.
  const [offlineAnnouncement, setOfflineAnnouncement] = useState('');
  const wasOnlineRef = useRef(online);
  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = online;
    if (wasOnline && !online) {
      setOfflineAnnouncement('You are offline. Your taps are saved and will sync when you reconnect.');
    } else if (!wasOnline && online) {
      setOfflineAnnouncement('');
    }
  }, [online]);

  return (
    <>
      <span className="text-xs font-medium text-qx-muted" aria-live="off">
        {label}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {offlineAnnouncement}
      </span>
    </>
  );
}
