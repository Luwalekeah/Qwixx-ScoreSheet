import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameOver } from './GameOver';
import type { Standing } from '@/lib/scoring';

const standings: Standing[] = [
  {
    playerId: 'p1',
    seat: 1,
    rank: 1,
    total: 120,
    penalties: 0,
    bestRowCrosses: 12,
    rows: { red: 30, yellow: 30, green: 30, blue: 30 },
  },
];

describe('GameOver (finding #17: announced twice)', () => {
  it('role="status" is scoped to a short sentence, not the whole panel', () => {
    const html = renderToStaticMarkup(
      <GameOver standings={standings} winnerPlayerId="p1" displayNameById={new Map([['p1', 'Alex']])} />,
    );
    // The status region exists and is off-screen only, distinct from the visible h1.
    const statusMatch = html.match(/<p role="status" class="sr-only">([\s\S]*?)<\/p>/);
    expect(statusMatch).toBeTruthy();
    // The per-player standings table (rank, score, per-row breakdown) must not be
    // inside the live region, or every standing gets read aloud on mount too.
    expect(statusMatch![1]).not.toContain('pts');
    expect(statusMatch![1]).not.toContain('penalties');
    // The outermost container is no longer itself a status region.
    expect(html).not.toMatch(/<div[^>]*role="status"/);
  });

  it('the visible heading is still the programmatic focus target on mount', () => {
    const html = renderToStaticMarkup(
      <GameOver standings={standings} winnerPlayerId="p1" displayNameById={new Map([['p1', 'Alex']])} />,
    );
    expect(html).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Alex wins<\/h1>/);
  });
});
