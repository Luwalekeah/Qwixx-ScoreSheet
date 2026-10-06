// Minimal in-memory stand-in for the Supabase JS client's query builder,
// covering exactly the chains the route handlers under app/api use:
// .from(table).select(cols, opts?).eq().neq().in().order().single()/.maybeSingle()
// .from(table).insert(payload).select(cols).single()/.maybeSingle()
// .from(table).update(payload).eq()...select(cols).maybeSingle()
// .rpc(name, args)
//
// Not a general Supabase mock. Extend it only when a route handler under
// test needs a chain shape this doesn't yet support.

export type Row = Record<string, unknown>;

// Postgres jsonb does not preserve the key order a client wrote; it stores
// object keys sorted by length then bytewise. This fake used to store rows
// verbatim in JS insertion order, which is exactly why the mutations-route
// test suite could not catch the sync.ts bug where a JSON.stringify-based
// equality check broke on real jsonb-ordered data (finding C3). Canonicalise
// every nested plain object on write, the same way Postgres would, so any
// test reading a jsonb-shaped column back out of this fake sees the same key
// order a real database would return.
function jsonbKeyCompare(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function reorderJsonbKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => reorderJsonbKeys(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, reorderJsonbKeys(v)] as const)
      .sort(([a], [b]) => jsonbKeyCompare(a, b));
    return Object.fromEntries(entries) as T;
  }
  return value;
}

type Filter =
  | { type: 'eq'; col: string; val: unknown }
  | { type: 'neq'; col: string; val: unknown }
  | { type: 'in'; col: string; val: unknown[] };

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  // Keyed `${table}:${op}` (e.g. 'games:select'). Set a message to make the
  // next matching query resolve as a database error instead of touching
  // `tables`, for regression tests that need to distinguish a transient read
  // failure from a genuinely empty result (finding C4). Consumed once.
  errorOnce: Record<string, string> = {};
  private idCounters: Record<string, number> = {};

  from(table: string): FakeQueryBuilder {
    this.tables[table] ??= [];
    return new FakeQueryBuilder(this, table);
  }

  rpc(name: string, args: Record<string, unknown> = {}): Promise<{ data: unknown; error: unknown }> {
    const handler = this.rpcHandlers[name];
    if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc handler for ${name}` } });
    try {
      return Promise.resolve({ data: handler(args), error: null });
    } catch (e) {
      return Promise.resolve({ data: null, error: { message: (e as Error).message } });
    }
  }

  nextId(table: string): string {
    const n = (this.idCounters[table] ?? 0) + 1;
    this.idCounters[table] = n;
    return `${table}-${n}`;
  }

  /**
   * Test-fixture helper for pushing a pre-existing row directly into
   * `tables`, bypassing the query-builder chain (e.g. to seed a game or
   * sheet that a route handler under test is expected to read, rather than
   * to have written itself). Applies the same `reorderJsonbKeys`
   * normalisation `insert()`/`update()` apply below, so a row seeded this
   * way and a row genuinely written through `.insert()` come back in the
   * same key order a real Postgres jsonb column would produce (finding C3
   * residual: `seedGame`/`seedSheet` used to push straight into `tables`
   * and skip this, so a pre-existing row still read back in JS insertion
   * order, which a real database never does -- exactly the blind spot C3
   * was fixing everywhere else).
   */
  seed(table: string, row: Row): Row {
    this.tables[table] ??= [];
    const normalized = reorderJsonbKeys(row);
    this.tables[table].push(normalized);
    return normalized;
  }
}

interface FakeResult {
  data: unknown;
  error: unknown;
  count?: number;
}

export class FakeQueryBuilder implements PromiseLike<FakeResult> {
  private op: 'select' | 'insert' | 'update' = 'select';
  private filters: Filter[] = [];
  private selectCols?: string;
  private countOpt?: 'exact';
  private headOnly = false;
  private insertPayload?: Row | Row[];
  private updatePayload?: Row;
  private orderCol?: string;
  private orderAsc = true;
  private wantSingle = false;
  private wantMaybeSingle = false;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  select(cols?: string, opts?: { count?: 'exact'; head?: boolean }): this {
    this.selectCols = cols;
    if (opts?.count) this.countOpt = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ type: 'eq', col, val });
    return this;
  }

  neq(col: string, val: unknown): this {
    this.filters.push({ type: 'neq', col, val });
    return this;
  }

  in(col: string, val: unknown[]): this {
    this.filters.push({ type: 'in', col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.insertPayload = payload;
    return this;
  }

  update(payload: Row): this {
    this.op = 'update';
    this.updatePayload = payload;
    return this;
  }

  single(): this {
    this.wantSingle = true;
    return this;
  }

  maybeSingle(): this {
    this.wantMaybeSingle = true;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.type === 'eq') return row[f.col] === f.val;
      if (f.type === 'neq') return row[f.col] !== f.val;
      return (f.val as unknown[]).includes(row[f.col]);
    });
  }

  private project(row: Row): Row {
    if (!this.selectCols || this.selectCols.trim() === '*') return { ...row };
    const cols = this.selectCols.split(',').map((c) => c.trim());
    const out: Row = {};
    for (const c of cols) out[c] = row[c];
    return out;
  }

  private finish(list: Row[]): FakeResult {
    if (this.wantSingle) {
      if (list.length !== 1) return { data: null, error: { message: 'no rows / more than one row' } };
      return { data: this.project(list[0]), error: null };
    }
    if (this.wantMaybeSingle) {
      if (list.length === 0) return { data: null, error: null };
      return { data: this.project(list[0]), error: null };
    }
    return { data: list.map((r) => this.project(r)), error: null };
  }

  private async execute(): Promise<FakeResult> {
    const errorKey = `${this.table}:${this.op}`;
    if (this.db.errorOnce[errorKey]) {
      const message = this.db.errorOnce[errorKey];
      delete this.db.errorOnce[errorKey];
      return { data: null, error: { message } };
    }

    const rows = (this.db.tables[this.table] ??= []);

    if (this.op === 'insert') {
      const payloads = Array.isArray(this.insertPayload) ? this.insertPayload : [this.insertPayload!];
      const inserted: Row[] = [];
      for (const p of payloads) {
        const row: Row = {
          id: p.id ?? this.db.nextId(this.table),
          created_at: new Date().toISOString(),
          ...reorderJsonbKeys(p),
        };
        rows.push(row);
        inserted.push(row);
      }
      return this.finish(inserted);
    }

    if (this.op === 'update') {
      const targets = rows.filter((r) => this.matches(r));
      for (const t of targets) Object.assign(t, reorderJsonbKeys(this.updatePayload));
      return this.finish(targets);
    }

    let selected = rows.filter((r) => this.matches(r));
    if (this.orderCol) {
      const col = this.orderCol;
      selected = [...selected].sort((a, b) => {
        const av = a[col] as number;
        const bv = b[col] as number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.countOpt === 'exact') {
      return { data: this.headOnly ? null : selected.map((r) => this.project(r)), error: null, count: selected.length };
    }
    return this.finish(selected);
  }
}
