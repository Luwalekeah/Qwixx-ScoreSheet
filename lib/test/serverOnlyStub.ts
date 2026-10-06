// Stub for the `server-only` package under Vitest's plain Node environment.
// The real package throws on import outside a "react-server" condition,
// which Vitest never sets. Aliased in vitest.config.ts so server-only
// modules can still be unit tested without pulling in Next's build-time
// machinery.
export {};
