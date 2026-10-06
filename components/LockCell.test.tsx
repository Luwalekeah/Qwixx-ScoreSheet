import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LockCell } from './LockCell';

describe('LockCell', () => {
  it('locked state: stays in the accessibility tree with a truthful pressed name', () => {
    const html = renderToStaticMarkup(
      <LockCell color="red" state="locked" onPress={() => {}} />,
    );
    expect(html).not.toContain('aria-hidden="true"><div');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Lock red, locked"');
  });

  it('closed by another player: distinct name from "five crosses needed"', () => {
    const html = renderToStaticMarkup(
      <LockCell color="blue" state="available" onPress={() => {}} closedByName="Alex" />,
    );
    expect(html).toContain('aria-label="Lock blue, closed by Alex"');
    expect(html).not.toContain('five crosses needed');
  });

  it('unavailable (fewer than five crosses): "five crosses needed", not a closure reason', () => {
    const html = renderToStaticMarkup(
      <LockCell color="green" state="unavailable" onPress={() => {}} />,
    );
    expect(html).toContain('aria-label="Lock green, five crosses needed"');
    expect(html).not.toContain('closed by');
  });

  it('the three states produce three distinct accessible names', () => {
    const locked = renderToStaticMarkup(<LockCell color="yellow" state="locked" onPress={() => {}} />);
    const closed = renderToStaticMarkup(
      <LockCell color="yellow" state="available" onPress={() => {}} closedByName="Sam" />,
    );
    const unavailable = renderToStaticMarkup(<LockCell color="yellow" state="unavailable" onPress={() => {}} />);
    const names = [locked, closed, unavailable].map((html) => html.match(/aria-label="([^"]+)"/)?.[1]);
    expect(new Set(names).size).toBe(3);
  });

  it('is track-sized, not fixed-width, in every state (regression guard for the grid-overlap bug)', () => {
    const states = [
      renderToStaticMarkup(<LockCell color="red" state="available" onPress={() => {}} />),
      renderToStaticMarkup(<LockCell color="red" state="locked" onPress={() => {}} />),
      renderToStaticMarkup(<LockCell color="red" state="unavailable" onPress={() => {}} />),
      renderToStaticMarkup(<LockCell color="red" state="available" onPress={() => {}} closedByName="Alex" />),
    ];
    for (const html of states) {
      expect(html).toContain('w-full');
      expect(html).toContain('min-w-6');
      expect(html).not.toMatch(/\bw-cell\b/);
      expect(html).not.toMatch(/\bmin-w-11\b/);
    }
  });
});
