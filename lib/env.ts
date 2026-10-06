import 'server-only';

// Fail-fast config validation (finding B2). QWIXX_COOKIE_SECRET and
// QWIXX_IP_HASH_SECRET used to throw lazily, the first time a request
// handler called getSecret()/hashIp() -- long after /api/health had already
// reported the pod healthy. A mis-sealed Secret (or a manifest that sealed
// the wrong variable name) shipped a pod that passes every k8s probe and
// 500s on every create, join, and cookie sign/verify. That is worse than no
// check: a healthy pod that is silently dead.
//
// These floors mirror scripts/check-no-secrets.mjs, which enforces them at
// build time. They are checked again here, at server startup and on every
// health probe, because a build-time check cannot see the Secret that gets
// mounted into the pod at deploy time -- a wrong SealedSecret only shows up
// once the container actually starts with the real environment.

const MIN_LENGTHS: Record<string, number> = {
  SUPABASE_URL: 8,
  SUPABASE_SERVICE_ROLE_KEY: 32,
  QWIXX_COOKIE_SECRET: 32,
  QWIXX_IP_HASH_SECRET: 32,
};

const PLACEHOLDER_PREFIXES = ['replace-me'];

/**
 * Returns a list of human-readable problems with the current environment.
 * Empty means configuration is valid. Never touches the database or the
 * network -- every check is a synchronous read of process.env.
 */
export function configErrors(): string[] {
  const errors: string[] = [];
  for (const [name, min] of Object.entries(MIN_LENGTHS)) {
    const value = process.env[name];
    if (!value || value.length < min) {
      errors.push(`${name} is unset or shorter than ${min} characters.`);
      continue;
    }
    if (PLACEHOLDER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      errors.push(`${name} still holds the .env.example placeholder.`);
    }
  }
  return errors;
}

/** Throws with every problem listed, rather than failing on the first one. */
export function assertConfigValid(): void {
  const errors = configErrors();
  if (errors.length > 0) {
    throw new Error(`Invalid runtime configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}
