import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression test for finding B3: 0002_cleanup_jobs.sql used to end with an
// unguarded `create extension pg_cron` and `cron.schedule(...)`, run against
// a Postgres instance shared with other cluster services where pg_cron
// availability was never verified. Migrations are hand-applied in filename
// order with `psql -v ON_ERROR_STOP=1 ... || break`
// (.pipeline/infra-spec.md, "Applying"), so if that statement aborted,
// every later migration -- including 0004_locked_rows_merge.sql, which
// every row lock depends on -- never landed. This pins that no required
// migration carries an unguarded pg_cron statement, and that the one file
// that does try pg_cron wraps every attempt so a failure cannot propagate.

const MIGRATIONS_DIR = __dirname;

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
}

// Strips `-- ...` line comments so the "no bare pg_cron statement" check
// below matches real SQL, not this migration's own explanatory prose about
// why pg_cron does not live here.
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

// Every .sql file except the explicitly-optional scheduling one.
const REQUIRED_MIGRATIONS = ['0001_qwixx_schema.sql', '0002_cleanup_jobs.sql', '0003_grants.sql', '0004_locked_rows_merge.sql', '0005_orphan_players.sql'];

describe('supabase/migrations pg_cron isolation (finding B3)', () => {
  it('keeps every required migration free of a bare pg_cron statement', () => {
    for (const file of REQUIRED_MIGRATIONS) {
      const sql = withoutComments(read(file));
      expect(sql, `${file} must not call create extension pg_cron directly`).not.toMatch(/create extension.*pg_cron/i);
      expect(sql, `${file} must not call cron.schedule directly`).not.toMatch(/cron\.schedule/i);
    }
  });

  it('0006_schedules.sql exists, is the only file that touches pg_cron, and wraps every attempt', () => {
    const sql = read('0006_schedules.sql');
    expect(sql).toMatch(/create extension.*pg_cron/i);
    expect(sql).toMatch(/cron\.schedule\('qwixx-cleanup'/);
    expect(sql).toMatch(/cron\.schedule\('qwixx-cleanup-orphans'/);

    // Every attempt sits inside a DO block with an EXCEPTION handler, so a
    // missing/unpreloaded extension raises a NOTICE instead of aborting.
    const doBlocks = sql.match(/do \$\$[\s\S]*?\$\$;/g) ?? [];
    expect(doBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of doBlocks) {
      expect(block, 'every DO block in 0006 must catch its own failure').toMatch(/exception\s+when others then/);
    }
  });

  it('states the file is optional', () => {
    const sql = read('0006_schedules.sql');
    expect(sql.toLowerCase()).toContain('optional');
  });
});
