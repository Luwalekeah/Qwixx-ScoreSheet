import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression test for finding S6: the migrations contained zero GRANT or
// REVOKE statements, and the correct privileges existed only as prose in
// .pipeline/infra-spec.md, applied by no tool. A live Postgres is not
// available to this test suite, so this cannot exercise the grants -- it
// can only pin that the SQL text remains present, so a future edit that
// silently drops a revoke is a visible diff here rather than a silent
// re-opening of the gap.

const MIGRATIONS_DIR = __dirname;

function readAllMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
}

describe('supabase/migrations GRANT/REVOKE coverage (finding S6)', () => {
  const sql = readAllMigrations();

  it('revokes schema-wide access from anon and authenticated', () => {
    expect(sql).toMatch(/revoke all on schema qwixx from anon, authenticated/);
  });

  it('grants schema usage only to service_role', () => {
    expect(sql).toMatch(/grant usage on schema qwixx to service_role/);
  });

  it('revokes and re-grants EXECUTE on every SECURITY DEFINER function to service_role only', () => {
    const definerFunctions = [...sql.matchAll(/create (?:or replace )?function qwixx\.(\w+)\(([^)]*)\)/g)].map(
      (m) => `${m[1]}(${m[2]})`,
    );
    // Every function this project defines must appear here; a new
    // SECURITY DEFINER function with no matching revoke/grant pair is
    // exactly how finding S6 happened the first time (consume_rate_limit
    // was defined in 0001 and never revoked).
    expect(definerFunctions.length).toBeGreaterThan(0);
    for (const signature of definerFunctions) {
      const nameOnly = signature.split('(')[0];
      const revokePattern = new RegExp(`revoke execute on function qwixx\\.${nameOnly}\\([^)]*\\) from public, anon, authenticated`);
      const grantPattern = new RegExp(`grant\\s+execute on function qwixx\\.${nameOnly}\\([^)]*\\) to service_role`);
      expect(sql, `${nameOnly} is missing its REVOKE EXECUTE`).toMatch(revokePattern);
      expect(sql, `${nameOnly} is missing its GRANT EXECUTE to service_role`).toMatch(grantPattern);
    }
  });
});
