import { describe, expect, it } from 'vitest';
import { FakeSupabase, reorderJsonbKeys } from './fakeSupabase';

// Regression test for finding C3 residual: seedGame/seedSheet in
// mutations/route.test.ts used to push straight into `tables`, bypassing
// the jsonb key-order normalisation `insert()`/`update()` apply, so a
// pre-existing (seeded) row read back in JS insertion order -- which a real
// Postgres jsonb column never does. `seed()` is the fix: it must apply the
// exact same normalisation `insert()` does.

describe('reorderJsonbKeys', () => {
  it('sorts keys by length then bytewise, matching Postgres jsonb storage', () => {
    const input = { yellow: 1, red: 2, green: 3, blue: 4 };
    expect(Object.keys(reorderJsonbKeys(input))).toEqual(['red', 'blue', 'green', 'yellow']);
  });
});

describe('FakeSupabase.seed', () => {
  it('normalises a seeded row the same way insert() does', async () => {
    const db = new FakeSupabase();
    db.seed('games', { id: 'g1', join_code: 'ABCDEF', locked_rows: { yellow: null, red: 'p1', green: null, blue: null } });

    const { data: seeded } = await db.from('games').select('*').eq('id', 'g1').single();
    const { data: inserted } = await db
      .from('games')
      .insert({ id: 'g2', join_code: 'GHIJKL', locked_rows: { yellow: null, red: 'p1', green: null, blue: null } })
      .select('*')
      .single();

    expect(Object.keys((seeded as { locked_rows: object }).locked_rows)).toEqual(
      Object.keys((inserted as { locked_rows: object }).locked_rows),
    );
    expect(Object.keys((seeded as { locked_rows: object }).locked_rows)).toEqual(['red', 'blue', 'green', 'yellow']);
  });
});
