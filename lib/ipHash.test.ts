import { describe, expect, it } from 'vitest';
import { clientIp, hashIp } from './ipHash';

// Regression tests for finding S7. Unreachable through the Cloudflare
// Tunnel (which always overwrites CF-Connecting-IP), but fully spoofable on
// the NodePort path the infra spec documents: trusting a caller-supplied
// X-Forwarded-For handed anyone on that path an unlimited number of
// rate-limit buckets.

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/games/join', { headers });
}

describe('clientIp (finding S7)', () => {
  it('trusts CF-Connecting-IP when present', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('never falls back to X-Forwarded-For, even when CF-Connecting-IP is absent', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.1' }))).toBeNull();
  });

  it('ignores an attacker-supplied X-Forwarded-For even alongside a real CF-Connecting-IP', () => {
    expect(
      clientIp(
        req({
          'cf-connecting-ip': '203.0.113.9',
          'x-forwarded-for': '198.51.100.1, 198.51.100.2',
        }),
      ),
    ).toBe('203.0.113.9');
  });

  it('returns null with no relevant headers at all', () => {
    expect(clientIp(req({}))).toBeNull();
  });
});

describe('hashIp', () => {
  it('is deterministic and does not return the raw IP', () => {
    const digest = hashIp('203.0.113.9');
    expect(digest).not.toContain('203.0.113.9');
    expect(hashIp('203.0.113.9')).toBe(digest);
  });
});
