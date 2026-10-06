import { describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from './test/fakeSupabase';

const fakeDb = new FakeSupabase();

vi.mock('./supabase/server', () => ({ db: fakeDb }));

const { consume } = await import('./ratelimit');

// Regression test for finding C6. The comment used to say "fail open on
// infrastructure trouble rather than locking everyone out" directly above a
// `throw`, which propagates to the caller's route handler catch block and
// returns a 500 -- fail CLOSED. An unreachable limiter is a bigger risk than
// a temporarily unavailable route, so closed is the correct behaviour; this
// test pins that behaviour so a future edit that "fixes" the comment by
// changing the code back to fail-open is a visible regression.

describe('consume (finding C6: fails closed on infrastructure trouble)', () => {
  it('rejects (does not resolve `allowed: true`) when the rate-limit RPC errors', async () => {
    fakeDb.rpcHandlers.consume_rate_limit = () => {
      throw new Error('connection refused');
    };

    await expect(consume('ip:test', 10)).rejects.toThrow(/rate limit check failed/);
  });

  it('rejects when the RPC returns no data', async () => {
    fakeDb.rpcHandlers.consume_rate_limit = () => null;

    await expect(consume('ip:test', 10)).rejects.toThrow(/rate limit check failed/);
  });

  it('resolves normally when the RPC succeeds', async () => {
    fakeDb.rpcHandlers.consume_rate_limit = () => 3;

    await expect(consume('ip:test', 10)).resolves.toMatchObject({ allowed: true });
  });
});
