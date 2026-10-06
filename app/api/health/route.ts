import { configErrors } from '@/lib/env';

// Liveness/readiness probe target. Answers Q4 in .pipeline/infra-spec.md:
// the k3s Deployment probes GET /api/health and expects 200 with no
// database call, so a Supabase outage does not restart otherwise-healthy
// pods. This route is intentionally outside the spec.md route list because
// it exists for the infra layer, not the application's own feature set.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Config validity only (finding B2), never a database call. This branch is
  // the PRIMARY gate, not a secondary one -- an earlier comment here had that
  // backwards. instrumentation.ts does not crash the process on bad config
  // (see the measured evidence in that file), so a misconfigured pod does
  // bind its port and does serve traffic. This 503, read by the startupProbe
  // in .pipeline/infra-spec.md, is what actually keeps such a pod from ever
  // being marked Ready. Deliberately still skips the
  // database, for the same reason the DB call was skipped before this fix:
  // a Supabase outage must not flip liveness/readiness and restart an
  // otherwise-healthy pod. A config check is a synchronous process.env
  // read, not a query, so running it on every probe costs nothing.
  const errors = configErrors();
  if (errors.length > 0) {
    console.error('Health check failed: invalid runtime configuration.', errors);
    return Response.json({ status: 'error', reason: 'invalid_configuration' }, { status: 503 });
  }
  return Response.json({ status: 'ok' });
}
