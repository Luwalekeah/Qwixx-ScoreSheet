import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Next.js compiles JSX with SWC's automatic runtime, so no source file imports
  // `React`. Vitest's own esbuild transform defaults to the classic runtime unless
  // told otherwise, which breaks every .tsx file at "React is not defined" the
  // moment a component test tries to render one. This makes esbuild match SWC's
  // behaviour instead of requiring every component to add an unused React import.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'node',
    include: [
      'lib/**/*.test.ts',
      'app/**/*.test.ts',
      'scripts/**/*.test.ts',
      'supabase/**/*.test.ts',
      'components/**/*.test.tsx',
      '*.test.ts',
    ],
    env: {
      // Deterministic, test-only secrets. Route handler tests sign/verify
      // real cookies with these; never used outside the test process.
      QWIXX_COOKIE_SECRET: 'test-cookie-secret-not-for-production',
      QWIXX_IP_HASH_SECRET: 'test-iphash-secret-not-for-production',
    },
  },
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./lib/test/serverOnlyStub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
