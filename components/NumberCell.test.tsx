import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NumberCell } from './NumberCell';

describe('NumberCell', () => {
  it('blocked (skipped by this player) names the cell "no longer available"', () => {
    const html = renderToStaticMarkup(
      <NumberCell color="red" number={7} state="blocked" onPress={() => {}} />,
    );
    expect(html).toContain('aria-label="Red 7, no longer available"');
    expect(html).not.toContain('row closed');
  });

  it('open cell in a colour closed game-wide names the closer, not "no longer available"', () => {
    const html = renderToStaticMarkup(
      <NumberCell color="red" number={7} state="open" onPress={() => {}} closedByName="Alex" />,
    );
    expect(html).toContain('aria-label="Red 7, row closed by Alex"');
    expect(html).not.toContain('no longer available');
  });

  it('blocked and closed produce distinct accessible names for the same number', () => {
    const blocked = renderToStaticMarkup(
      <NumberCell color="green" number={11} state="blocked" onPress={() => {}} />,
    );
    const closed = renderToStaticMarkup(
      <NumberCell color="green" number={11} state="open" onPress={() => {}} closedByName="Sam" />,
    );
    const blockedLabel = blocked.match(/aria-label="([^"]+)"/)?.[1];
    const closedLabel = closed.match(/aria-label="([^"]+)"/)?.[1];
    expect(blockedLabel).not.toEqual(closedLabel);
  });

  it('a genuinely open cell (no closure) is enabled and named for crossing off', () => {
    const html = renderToStaticMarkup(
      <NumberCell color="blue" number={3} state="open" onPress={() => {}} />,
    );
    expect(html).toContain('aria-label="Cross off blue 3"');
    expect(html).not.toContain('disabled');
  });

  it('crossed cells are named distinctly from open and blocked', () => {
    const html = renderToStaticMarkup(
      <NumberCell color="blue" number={3} state="crossed" onPress={() => {}} />,
    );
    expect(html).toContain('aria-label="Blue 3, crossed off"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('is track-sized, not fixed-width, in every state (regression guard for the grid-overlap bug)', () => {
    const states = [
      renderToStaticMarkup(<NumberCell color="red" number={2} state="open" onPress={() => {}} />),
      renderToStaticMarkup(<NumberCell color="red" number={2} state="crossed" onPress={() => {}} />),
      renderToStaticMarkup(<NumberCell color="red" number={2} state="blocked" onPress={() => {}} />),
      renderToStaticMarkup(
        <NumberCell color="red" number={2} state="open" onPress={() => {}} closedByName="Alex" />,
      ),
    ];
    for (const html of states) {
      expect(html).toContain('w-full');
      expect(html).toContain('min-w-6');
      // A fixed w-<n> cell (the original bug) or a widened min-w-11 floor (which
      // recreates it at 320px, per the a11y review's own math) must never return.
      expect(html).not.toMatch(/\bw-cell\b/);
      expect(html).not.toMatch(/\bmin-w-11\b/);
    }
  });
});
