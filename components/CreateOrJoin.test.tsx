import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateOrJoin } from './CreateOrJoin';
import { withAppRouter } from './test/withAppRouter';

describe('CreateOrJoin (entry screen, finding B4)', () => {
  it('the mode toggle reports its selected state with aria-pressed, not colour alone', () => {
    const html = renderToStaticMarkup(withAppRouter(<CreateOrJoin />));
    // Default mode is 'create': the New game button is pressed, Join game is not.
    expect(html).toMatch(/New game<\/button>/);
    const newGameButton = html.match(/<button[^>]*>New game<\/button>/)?.[0];
    const joinGameButton = html.match(/<button[^>]*>Join game<\/button>/)?.[0];
    expect(newGameButton).toContain('aria-pressed="true"');
    expect(joinGameButton).toContain('aria-pressed="false"');
  });

  it('the error region is always present in the DOM, not mounted only when populated', () => {
    const html = renderToStaticMarkup(withAppRouter(<CreateOrJoin />));
    // On first render there is no error yet, so the region exists but is empty --
    // if it were conditionally mounted (the original bug), this element would not
    // exist in the markup at all until an error occurred.
    expect(html).toContain('id="form-error"');
    expect(html).toMatch(/<p role="status" aria-live="polite" id="form-error" class="[^"]*"><\/p>/);
  });

  it("the join-code input's accessible name does not contain the 32-character alphabet", async () => {
    // The join form (with the code input and its character-set hint) only exists
    // in the tree when mode === 'join', which is internal state with no prop to
    // force it and no interactivity available under static rendering (see
    // .pipeline/changes.md, "Fix pass 2, presentation" for why). Assert on the
    // source directly instead: the hint span must be a sibling of the <label>,
    // referenced by aria-describedby, never nested inside it -- nesting inside
    // the label is exactly what made the input announce all 32 characters.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./CreateOrJoin.tsx', import.meta.url), 'utf8');
    const labelMatch = source.match(/Game code[\s\S]*?<\/label>/);
    expect(labelMatch).toBeTruthy();
    expect(labelMatch![0]).not.toContain('Codes use only these characters');
    // The hint must exist elsewhere, wired by id + aria-describedby instead.
    expect(source).toContain('id="code-hint"');
    expect(source).toContain('aria-describedby={`code-hint');
  });

  it('display name inputs carry autocomplete="nickname"', () => {
    const html = renderToStaticMarkup(withAppRouter(<CreateOrJoin />));
    expect(html).toContain('autoComplete="nickname"');
  });
});
