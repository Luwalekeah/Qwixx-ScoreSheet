'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  getGame,
  startGame,
  joinGame,
  ApiError,
  type GameStateResponse,
} from '@/lib/api';
import { GameSync, POLL_INTERVAL_MS, type GameSyncSnapshot } from '@/lib/sync';
import { scoreSheet, type Color } from '@/lib/scoring';
import { Lobby } from './Lobby';
import { ScoreSheet } from './ScoreSheet';
import { TotalBar } from './TotalBar';
import { OpponentList } from './OpponentList';
import { SyncStatus } from './SyncStatus';
import { Toast } from './Toast';
import { GameOver } from './GameOver';

interface GameClientProps {
  code: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'need-join' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; state: GameStateResponse };

export function GameClient({ code }: GameClientProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [joinName, setJoinName] = useState('');
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapshot, setSnapshot] = useState<GameSyncSnapshot | null>(null);
  const [online, setOnline] = useState(true);

  const syncRef = useRef<GameSync | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await getGame(code);
      if (res === undefined) return; // 304, no change

      setPhase({ kind: 'ready', state: res });

      if (!syncRef.current) {
        const sync = new GameSync(code, res.you.playerId);
        syncRef.current = sync;
        sync.subscribe(setSnapshot);
        await sync.init();
      }
      await syncRef.current.applyPollResult(res);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setPhase({ kind: 'need-join' });
          return;
        }
        if (err.status === 404) {
          setPhase({ kind: 'not-found' });
          return;
        }
      }
      // Leave the current phase untouched on transient failure; the poll
      // loop will retry.
    }
  }, [code]);

  // phaseRef always holds the latest phase. schedulePoll's own setTimeout closure is
  // created once and recurses through its own name, so a value captured by dependency
  // (like `phase` used to be) stays pinned at whatever it was on the render that first
  // scheduled it. Reading through a ref sidesteps that stale-closure trap.
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const schedulePoll = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      const currentPhase = phaseRef.current;
      const status = currentPhase.kind === 'ready' ? currentPhase.state.game.status : null;
      if (status !== 'ended' && document.visibilityState === 'visible') {
        await poll();
      }
      schedulePoll();
    }, POLL_INTERVAL_MS);
  }, [poll]);

  useEffect(() => {
    void poll();
    schedulePoll();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    const onOnline = () => {
      setOnline(true);
      syncRef.current?.kickFlush();
    };
    const onOffline = () => setOnline(false);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    setOnline(navigator.onLine);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      syncRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinName.trim()) return;
    setJoining(true);
    try {
      await joinGame(code, joinName.trim());
      await poll();
    } catch (err) {
      if (err instanceof ApiError) {
        setPhase({ kind: 'error', message: err.body.message });
      }
    } finally {
      setJoining(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    try {
      await startGame(code);
      await poll();
    } catch (err) {
      if (err instanceof ApiError) {
        setPhase({ kind: 'error', message: err.body.message });
      }
    } finally {
      setStarting(false);
    }
  };

  const handleCross = (color: Color, index: number) => {
    void syncRef.current?.mark(color, index);
  };

  const handlePenalty = () => {
    void syncRef.current?.penalty();
  };

  const handleUndo = () => {
    void syncRef.current?.undo();
  };

  if (phase.kind === 'loading') {
    return (
      <main id="main" tabIndex={-1} className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-qx-muted">Loading…</p>
      </main>
    );
  }

  if (phase.kind === 'not-found') {
    return (
      <main id="main" tabIndex={-1} className="flex min-h-screen flex-col items-center justify-center gap-2 px-3 text-center">
        <p className="text-base font-semibold text-qx-text">That game code was not found.</p>
        <Link href="/" className="text-sm font-medium text-qx-text underline">
          Back home
        </Link>
      </main>
    );
  }

  if (phase.kind === 'need-join') {
    return (
      <main id="main" tabIndex={-1} className="flex min-h-screen flex-col items-center justify-center gap-4 px-3">
        <p className="text-base font-semibold text-qx-text">Join game {code}</p>
        <form onSubmit={handleJoin} className="flex w-full max-w-sm flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-qx-text">
            Display name
            <input
              type="text"
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              maxLength={24}
              required
              autoComplete="nickname"
              className="min-h-tap rounded-cell border-2 border-qx-line bg-qx-surface px-3 text-qx-text"
            />
          </label>
          <button
            type="submit"
            disabled={joining}
            className="min-h-tap rounded-cell bg-qx-text px-4 text-sm font-semibold text-qx-surface disabled:opacity-40"
          >
            {joining ? 'Joining…' : 'Join'}
          </button>
        </form>
      </main>
    );
  }

  if (phase.kind === 'error') {
    return (
      <main id="main" tabIndex={-1} className="flex min-h-screen items-center justify-center px-3 text-center">
        <p className="text-sm text-qx-text">{phase.message}</p>
      </main>
    );
  }

  const { state } = phase;
  const displayNameById = new Map(state.players.map((p) => [p.playerId, p.displayName]));

  if (state.game.status === 'lobby') {
    return (
      <main id="main" tabIndex={-1} className="min-h-screen">
        <Lobby
          code={state.game.code}
          players={state.players}
          hostPlayerId={state.game.hostPlayerId}
          you={state.you}
          onStart={handleStart}
          starting={starting}
        />
      </main>
    );
  }

  if (state.game.status === 'ended' && state.standings) {
    return (
      <main id="main" tabIndex={-1} className="min-h-screen">
        <GameOver
          standings={state.standings}
          winnerPlayerId={state.game.winnerPlayerId}
          displayNameById={displayNameById}
        />
      </main>
    );
  }

  // active
  const localSheet = snapshot?.localSheet;
  const localLockedRows = snapshot?.localLockedRows ?? state.game.lockedRows;
  const you = state.players.find((p) => p.playerId === state.you.playerId);
  const sheetForDisplay = localSheet ?? {
    crosses: you?.crosses ?? { red: [], yellow: [], green: [], blue: [] },
    locks: you?.locks ?? { red: false, yellow: false, green: false, blue: false },
    penalties: you?.penalties ?? 0,
  };
  const total = scoreSheet(sheetForDisplay).total;

  const otherPlayers = state.players.filter((p) => p.playerId !== state.you.playerId);

  return (
    <main id="main" tabIndex={-1} className="flex min-h-screen flex-col">
      <h1 className="sr-only">Game {state.game.code}</h1>
      <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-qx-line bg-qx-surface px-3">
        <span className="text-sm font-semibold text-qx-text">{state.game.code}</span>
        <SyncStatus online={online} pendingCount={snapshot?.pendingCount ?? 0} />
        <Link href="/rules" className="text-sm font-medium text-qx-text underline">
          Rules
        </Link>
      </header>

      <Toast message={snapshot?.toast ?? null} onDismiss={() => syncRef.current?.kickFlush()} />

      <div className="flex-1 pb-4 pt-3">
        <ScoreSheet
          sheet={sheetForDisplay}
          lockedRows={localLockedRows}
          myPlayerId={state.you.playerId}
          displayNameById={displayNameById}
          onCross={handleCross}
          onPenalty={handlePenalty}
        />
        <OpponentList players={otherPlayers} />
      </div>

      <TotalBar total={total} canUndo={snapshot?.canUndo ?? false} onUndo={handleUndo} />
    </main>
  );
}
