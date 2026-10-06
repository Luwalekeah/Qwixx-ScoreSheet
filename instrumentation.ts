// Next.js instrumentation hook (finding B2). `register()` runs once, before
// the server accepts its first request, in every runtime the app uses. This
// is the actual "startup" a fail-fast config check needs: importing
// lib/cookies.ts or lib/ipHash.ts only throws the first time a route
// handler that uses them is hit, which can be long after /api/health has
// already told Kubernetes the pod is Ready.
//
// VERIFIED BEHAVIOUR, corrected after this comment originally overclaimed.
// Throwing here does NOT crash the process. Next.js catches it, logs
// "Failed to prepare server", and still prints Ready and binds the port.
// Every request then returns 500, including GET /api/health. Measured on
// the standalone build with QWIXX_IP_HASH_SECRET removed:
//
//     ✓ Ready in 166ms
//     Failed to prepare server Error: ... QWIXX_IP_HASH_SECRET is unset ...
//     GET /api/health -> 500,  GET / -> 500,  process -> still running
//
// So this hook is a loud, early, accurate LOG, not a crash barrier. What
// actually stops a misconfigured rollout is the startupProbe on
// /api/health in .pipeline/infra-spec.md: health 500s, the probe never
// passes, and the Deployment never marks the pod Ready. Do not remove that
// probe on the assumption this hook crash-loops the pod. It does not.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertConfigValid } = await import('./lib/env');
    assertConfigValid();
  }
}
