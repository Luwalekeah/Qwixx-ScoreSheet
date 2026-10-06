import 'server-only';
import { db } from './supabase/server';

// Postgres backed fixed window counter. Chosen over a sliding window because
// a single atomic upsert is enough for a handful of people in one room, and
// there is no Redis in the cluster.

export async function consume(
  bucketKey: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const { data, error } = await db.rpc('consume_rate_limit', { p_bucket_key: bucketKey });

  if (error || data === null || data === undefined) {
    // Fail closed: propagate as a 500 rather than letting an unreachable
    // limiter silently wave every caller through. This should never happen
    // once the RPC function exists, but if the limiter itself is down, an
    // unbounded caller is a bigger risk than a temporarily unavailable route.
    throw new Error(`rate limit check failed: ${error?.message ?? 'no data'}`);
  }

  const count = data as number;
  const now = new Date();
  const secondsIntoWindow = now.getUTCSeconds();
  const retryAfter = count > limit ? 60 - secondsIntoWindow : 0;

  return { allowed: count <= limit, retryAfter };
}
