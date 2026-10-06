import { describe, expect, it } from 'vitest';
import nextConfig from './next.config';

// Regression tests for findings S8 (no security headers) and S9 (missing
// output: 'standalone'), plus the fix pass 2 correction for finding B1: a
// script-src with no 'unsafe-inline' and no nonce blocks every inline RSC
// bootstrap script Next.js ships, so the app builds, deploys, and never
// hydrates. See next.config.ts for the full explanation and
// .pipeline/changes.md, fix pass 2, for the empirical proof (built the
// standalone server, requested a real route, confirmed the inline scripts
// are permitted and the page hydrates).

describe('next.config.ts', () => {
  it('sets output: "standalone" (finding S9)', () => {
    // .pipeline/infra-spec.md:70 calls this non-negotiable: without it the
    // Docker image has no server.js and the container will not start.
    expect(nextConfig.output).toBe('standalone');
  });

  it('ships a security headers block covering every path (finding S8)', async () => {
    expect(nextConfig.headers).toBeTypeOf('function');
    const entries = await nextConfig.headers!();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('/:path*');

    const byKey = Object.fromEntries(entries[0].headers.map((h) => [h.key, h.value]));

    expect(byKey['Content-Security-Policy']).toContain("default-src 'self'");
    expect(byKey['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    // script-src must allow Next.js's own inline RSC bootstrap scripts
    // (finding B1). A bare "script-src 'self'" with no 'unsafe-inline' and
    // no nonce blocks hydration entirely — this exact assertion used to pin
    // that broken state.
    expect(byKey['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(byKey['X-Content-Type-Options']).toBe('nosniff');
    expect(byKey['X-Frame-Options']).toBe('DENY');
    expect(byKey['Referrer-Policy']).toBeDefined();
    expect(byKey['Permissions-Policy']).toBeDefined();
    expect(byKey['Strict-Transport-Security']).toContain('max-age=');
  });

  it('does not expose the X-Powered-By header', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
