import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Regression tests for findings S2 and S5. Runs the real script as a child
// process against a scratch directory, exactly the way `npm run build`
// invokes it, so a future edit cannot silently reintroduce either bypass
// without a test noticing.

const SCRIPT = join(process.cwd(), 'scripts', 'check-no-secrets.mjs');

function realSecret(): string {
  return randomBytes(24).toString('base64'); // 32 characters, no known prefix
}

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUPABASE_URL: 'http://supabase-kong.supabase.svc.cluster.local:8000',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_service_role_for_scan_only.sig',
    QWIXX_COOKIE_SECRET: realSecret(),
    QWIXX_IP_HASH_SECRET: realSecret(),
    ...overrides,
  };
}

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'qwixx-gate-'));
}

function run(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
}

describe('scripts/check-no-secrets.mjs: fails closed on a missing bundle (finding S2)', () => {
  it('fails when .next does not exist at all (bypass A: used to report success having checked 1 file)', () => {
    const dir = makeTempProject();
    try {
      const result = run(dir, baseEnv());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('.next/static does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the bundle exists but only a trivial number of files were scanned', () => {
    const dir = makeTempProject();
    try {
      mkdirSync(join(dir, '.next', 'static'), { recursive: true });
      writeFileSync(join(dir, '.next', 'static', 'a.js'), 'console.log(1)');
      const result = run(dir, baseEnv());
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/only \d+ files were scanned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes with a real-looking bundle that contains no credential', () => {
    const dir = makeTempProject();
    try {
      const staticDir = join(dir, '.next', 'static', 'chunks');
      mkdirSync(staticDir, { recursive: true });
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(staticDir, `chunk-${i}.js`), `console.log("chunk ${i}");`);
      }
      const result = run(dir, baseEnv());
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No Supabase credential found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still fails on a real credential leaking into an otherwise well-formed bundle', () => {
    const dir = makeTempProject();
    try {
      const staticDir = join(dir, '.next', 'static', 'chunks');
      mkdirSync(staticDir, { recursive: true });
      const secret = realSecret();
      for (let i = 0; i < 12; i++) {
        writeFileSync(
          join(staticDir, `chunk-${i}.js`),
          i === 5 ? `const leaked = "${secret}";` : `console.log(${i});`,
        );
      }
      const result = run(dir, baseEnv({ QWIXX_COOKIE_SECRET: secret }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('QWIXX_COOKIE_SECRET');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scripts/check-no-secrets.mjs: rejects weak secrets (finding S5)', () => {
  it('rejects a QWIXX_COOKIE_SECRET shorter than 32 characters', () => {
    const dir = makeTempProject();
    try {
      const result = run(dir, baseEnv({ QWIXX_COOKIE_SECRET: 'x'.repeat(20) }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('QWIXX_COOKIE_SECRET');
      expect(result.stderr).toContain('32');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the .env.example placeholder outright, even padded past 32 characters', () => {
    const dir = makeTempProject();
    try {
      const result = run(dir, baseEnv({ QWIXX_COOKIE_SECRET: 'replace-me-with-a-real-32-byte-base64-secret' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('placeholder');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a real 32+ byte secret', () => {
    const dir = makeTempProject();
    try {
      mkdirSync(join(dir, '.next', 'static', 'chunks'), { recursive: true });
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(dir, '.next', 'static', 'chunks', `c${i}.js`), `console.log(${i});`);
      }
      const result = run(dir, baseEnv());
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
