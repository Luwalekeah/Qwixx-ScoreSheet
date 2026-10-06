'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createGame, joinGame, ApiError } from '@/lib/api';
import { ALPHABET } from '@/lib/joincode';

type Mode = 'create' | 'join';

export function CreateOrJoin() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('create');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createGame(displayName.trim());
      router.push(`/g/${res.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await joinGame(code.trim(), displayName.trim());
      router.push(`/g/${res.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCodeChange = (value: string) => {
    const upper = value.toUpperCase();
    const filtered = Array.from(upper)
      .filter((ch) => ALPHABET.includes(ch) || ch === '-' || ch === ' ')
      .join('');
    setCode(filtered);
  };

  return (
    <div className="flex flex-col gap-6 px-3 py-8">
      <div className="flex rounded-cell border-2 border-qx-line p-1">
        <button
          type="button"
          onClick={() => setMode('create')}
          aria-pressed={mode === 'create'}
          className={`min-h-11 flex-1 rounded-cell text-sm font-semibold ${
            mode === 'create' ? 'bg-qx-text text-qx-surface' : 'text-qx-text'
          }`}
        >
          New game
        </button>
        <button
          type="button"
          onClick={() => setMode('join')}
          aria-pressed={mode === 'join'}
          className={`min-h-11 flex-1 rounded-cell text-sm font-semibold ${
            mode === 'join' ? 'bg-qx-text text-qx-surface' : 'text-qx-text'
          }`}
        >
          Join game
        </button>
      </div>

      {mode === 'create' ? (
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-qx-text">
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={24}
              required
              autoComplete="nickname"
              aria-describedby={error ? 'form-error' : undefined}
              className="min-h-tap rounded-cell border-2 border-qx-line bg-qx-surface px-3 text-qx-text"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-tap rounded-cell bg-qx-text px-4 text-sm font-semibold text-qx-surface disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create game'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleJoin} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-qx-text">
            Game code
            <input
              type="text"
              value={code}
              onChange={(e) => handleCodeChange(e.target.value)}
              maxLength={7}
              required
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              aria-describedby={`code-hint${error ? ' form-error' : ''}`}
              className="min-h-tap rounded-cell border-2 border-qx-line bg-qx-surface px-3 font-mono uppercase tracking-widest text-qx-text"
            />
          </label>
          <span id="code-hint" className="text-xs text-qx-muted">
            Codes use only these characters: {ALPHABET}
          </span>
          <label className="flex flex-col gap-1 text-sm text-qx-text">
            Display name
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={24}
              required
              autoComplete="nickname"
              aria-describedby={error ? 'form-error' : undefined}
              className="min-h-tap rounded-cell border-2 border-qx-line bg-qx-surface px-3 text-qx-text"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-tap rounded-cell bg-qx-text px-4 text-sm font-semibold text-qx-surface disabled:opacity-40"
          >
            {submitting ? 'Joining…' : 'Join game'}
          </button>
        </form>
      )}

      <p role="status" aria-live="polite" id="form-error" className="text-sm text-qx-danger">
        {error}
      </p>
    </div>
  );
}
