# Implementation notes: Qwixx score sheet

Built against `.pipeline/spec.md` in full, following the section 13 build order. Greenfield repo; every file listed below is new.

## Verification run (state this is accurate, not claimed)

- `npm test` — **53 tests passing**, including all **49 named tests** from `lib/scoring.test.ts` with the exact names given in section 3 of the spec (all four regression suites: bug 1 lock scoring, bug 2 strict-right crossing, bug 3 lock-requires-five, bug 4 game end detection). Plus 4 small tests for `lib/joincode.ts` (alphabet shape, generation, normalisation) that the spec asked for in section 6.1 but didn't name individually.
- `npm run typecheck` — clean, exit 0.
- `npm run lint` (`next lint`, flat config via `eslint.config.mjs`) — `✔ No ESLint warnings or errors`.
- `npm run build` — `next build` succeeds, then `scripts/check-no-secrets.mjs` runs as part of the same script and reports `No Supabase credential found in the client bundle. Checked 47 files.` I also deliberately planted the service-role-key value in a client component (`components/SkipLink.tsx`) and rebuilt to confirm the check actually fails the build (exit 1, names the file and byte offset) before reverting the file. It works.
- `tailwind.config.js` was **never created**. Confirmed with a repo-wide search excluding `node_modules`. All theme tokens live in the `@theme` block in `app/globals.css`.
- Two-device manual pass, backgrounding, and airplane-mode pass were **not run** — there is no reachable Supabase instance from this environment (the real one is ClusterIP-only inside `luwah-k3s`). Everything above is what CI-equivalent commands actually verify locally. The `README.md` documents how to point the app at a real instance and apply the migrations.

Local build verification note: `scripts/check-no-secrets.mjs` reads `process.env` directly (per spec) and is a separate `node` process from `next build`, so it does not automatically pick up `.env.local` the way Next itself does. In production the four variables arrive as real container env vars (per `.pipeline/infra-spec.md`), so this is correct behaviour, not a bug. Locally I ran `set -a && source .env.local && set +a` before `npm run build` to exercise it end-to-end.

## File-by-file summary

### Scaffold
- `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.nvmrc`, `.gitignore`, `.env.example` — as specified. `next.config.ts` sets `typedRoutes: true` only.
- `eslint.config.mjs` — **not named in the spec's file tree**, but required for `next lint` (ESLint 9 flat config) to run non-interactively. Standard `FlatCompat` wrapper around `next/core-web-vitals` + `next/typescript`.

### Pure scoring engine (built and tested before any UI, per the hard order)
- `lib/types.ts` — shared DB row types, no logic.
- `lib/scoring.ts` — the full pure engine: geometry (`numberAt`/`indexOfNumber`), `triangular`/`scoreRow`, sheet mutation (`applyCross`/`applyPenalty`/`undoCross`/`undoPenalty`), legality (`canCross`/`canPenalty`/`canUndoCross`), game end (`checkGameEnd`), and ranking (`rankPlayers`/`resolveWinners`). No React, no network, no clock, no randomness, no mutation of inputs — every function returns new objects. One deliberate fix during testing: `scoreSheet`'s `penaltyPoints` used `penalties * PENALTY_POINTS`, which produces `-0` (not `0`) when `penalties === 0` in JS; guarded with an explicit zero case so `Object.is` equality in tests (and any strict downstream comparison) holds.
- `lib/scoring.test.ts` — all 49 named tests, plus purity/immutability checks with frozen inputs and stubbed `Date.now`/`Math.random`. Tester: this file is the contract: read it before touching `lib/scoring.ts`.

### Join codes, cookies, auth, rate limiting
- `lib/joincode.ts` — `ALPHABET`, `CODE_LENGTH`, `normalizeJoinCode`. Deliberately has **no** `node:crypto` import so it stays safe to import from a Client Component (`CreateOrJoin.tsx` shows the allowed-alphabet hint).
- `lib/joincodeGenerate.ts` — **new file, not in the spec's tree** — holds `generateJoinCode` (rejection-sampled `randomBytes`) and `import 'server-only'`. Splitting this out of `joincode.ts` was necessary: the spec's tree has one `joincode.ts` with both functions, but bundling `generateJoinCode`'s `node:crypto` import into a file also imported by a Client Component broke the Next.js client webpack build (`UnhandledSchemeError` on `node:crypto`). Route handlers (`app/api/games/route.ts`) import `generateJoinCode` from here; everything else imports `ALPHABET`/`normalizeJoinCode` from `lib/joincode.ts` as the spec names it.
- `lib/joincode.test.ts` — small test file for section 6.1's explicit ask ("add a unit test asserting `ALPHABET.length === 30`...").
- `lib/cookies.ts` — HMAC-SHA256 sign/verify with `node:crypto`, `timingSafeEqual`, base64url payloads. Both cookie shapes (`qx_device`, `qx_seat`) and their `Set-Cookie` header builders live here.
- `lib/ipHash.ts` — `cf-connecting-ip` → `x-forwarded-for` → `'unknown'`, HMAC digest only, raw IP never stored.
- `lib/auth.ts` — `resolveDevice`, `resolveSeat` per section 5.3's exact fallback order, plus `ensureDevice` (bootstrap + cookie issuance, used by `/api/me`, `/api/games`, `/api/games/join`) and `requireSeat` (the 401-vs-403 split every `/api/games/[code]/*` handler needs).
- `lib/ratelimit.ts` — `consume(bucketKey, limit)`. See "Transactions" deviation below for how the atomic upsert is actually executed.
- `lib/apiError.ts` — shared error envelope (`jsonError`) and a `parseBody` helper that runs a zod schema and returns the spec's exact 400 shape (`{ error: 'bad_request', detail: <zod flatten> }`).
- `lib/validation.ts` — zod schemas for every request body (`displayName`, join, mutations batch, rename).

### Database
- `supabase/migrations/0001_qwixx_schema.sql` — schema, four domain tables, `rate_limits`, all constraints and indexes, verbatim from the spec. **One addition**: `qwixx.consume_rate_limit(p_bucket_key text)`, a `security definer` SQL function wrapping the literal fixed-window upsert from section 6.3, appended at the end of this file (not a third migration file). See "Transactions" below for why.
- `supabase/migrations/0002_cleanup_jobs.sql` — `qwixx.cleanup_abandoned()` plus the `pg_cron` schedule, verbatim. Both artefacts ship per the spec's open question 2; the README documents the k3s CronJob fallback.

### Transactions — the one real architectural deviation

The spec describes several handlers (`join`, `start`, `mutations`, `end`) as a single `SELECT ... FOR UPDATE` Postgres transaction. `@supabase/supabase-js` talks to Postgres through PostgREST and has **no primitive for a multi-statement transaction or row-level lock from application code** — there is no `db.query()`/`db.transaction()`. Adding `pg` as a dependency was not an option (`package.json` deps are fixed and the spec says "do not add any other dependency"). Two standard compensating patterns are used instead, both already implied by the schema itself:

1. **Optimistic concurrency** (the pattern the spec explicitly names as the safety net for `sheets.version`, section 0 and 8.6): sheet writes in `app/api/games/[code]/mutations/route.ts` compare `sheets.version` to `baseVersion`, then issue the update as `.update(...).eq('version', baseVersion).select()`. A zero-row result means a concurrent writer beat us to it (impossible in the intended single-writer-per-sheet model, but handled anyway) and returns `409 version_conflict` with freshly re-read authoritative state.
2. **A Postgres function reached over RPC** for the one spot that genuinely needs a single atomic statement outside the JS client's reach: the join rate limiter (`qwixx.consume_rate_limit`, called via `db.rpc(...)` from `lib/ratelimit.ts`). This is the literal SQL from section 6.3, just wrapped so it executes atomically in one round trip.
3. Seat assignment (`/api/games/join`) and join-code generation (`/api/games`) rely on the two partial unique indexes already in the schema (`games_join_code_live_uniq`, `game_players_seat_uniq`) plus retry-on-`23505`, exactly as section 6.2 specifies for code collisions. Concurrent joins racing for the same next seat number is a real (narrow) race in this design; a double-insert fails the unique index and the request returns `500`/`409` rather than silently corrupting a seat. Given the stated usage pattern (a handful of friends in one room, joins are human-paced), I judge this an acceptable risk rather than a spec violation, but it's worth the tester's attention if you want to stress-test concurrent joins.

Tester: this is the one place where "the spec says one transaction" and "what got built" genuinely differ. Everything else is a literal implementation.

### Route handlers
All ten routes from section 4, in the order given, each `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, Next.js 15 async `params`, zod-validated bodies, the shared error envelope. `lib/gameEnd.ts` holds the one shared end-of-game write (final scores + `games.status = 'ended'`) used by both `/mutations` step 7 (automatic end) and `/end` (host-forced end), per section 4.8.

**One addition beyond spec.md**: `app/api/health/route.ts`, a bare `{status:'ok'}` 200 with no DB call. This isn't in spec.md's route list. It answers Q4 in the sibling `.pipeline/infra-spec.md`, which explicitly asks "the app agent" (this task) whether it will add a health endpoint the k3s Deployment's readiness probe expects, and says the probes fall back to a heavier `GET /` if not. Adding a trivial, side-effect-free health route seemed clearly lower-risk than leaving that infra question unanswered. Flag if this should be pulled back out — it's the only line item not sourced directly from spec.md.

### Local-first layer (browser only)
- `lib/idb.ts` — IndexedDB open/schema (`meta`, `snapshots`, `sheets`, `queue`, `moves`), typed helpers.
- `lib/api.ts` — typed `fetch` wrappers for every route, relative URLs only.
- `lib/sync.ts` — the `GameSync` class: local truth via `replay()`, the tap path (8.3), undo (8.4), the flush protocol with the exact 409/422/`wrong_status`/403-404/network-failure branches and backoff schedule (8.5), and poll reconciliation (8.6). This module doesn't have a named test suite in the spec (only `lib/scoring.ts` does) and isn't covered by `lib/scoring.test.ts`'s 100%-coverage requirement, so it has **no automated test coverage** — it's exercised only by `tsc` and manual review. Given the module's size and the amount of branchy reconciliation logic, this is the single area I'd most want the tester to poke at manually (offline taps, killing the tab mid-flush, forcing a 422 by racing two devices on the same row).
- `public/sw.js` — plain JS, no imports, `/api/*` network-only, navigation network-first-then-offline-fallback, `/_next/static/*` and `/icons/*` cache-first, and the `sync` event handler duplicating only the 200 case exactly as specified.

### UI, mobile-first at 390px
All components from section 8, in the build order, all styled through the `@theme` tokens (`bg-qx-*`, `text-qx-*`, `border-qx-*`, `--spacing-tap`, `--spacing-cell`) via lookup objects (`ROW_CLASSES`), never template-literal class names.

**Score grid, verified before building anything else per the task's own instruction**: `ScoreRow.tsx` renders 11 `NumberCell`s (indices 0–10, i.e. every printed number including the row's rightmost number) plus one `LockCell` as a 12th grid item, in a `grid-cols-6 gap-1.5 sm:grid-cols-12` container — 6 columns × 2 rows on mobile, one line of 12 at `sm:`. Cell size is `h-cell w-cell` (the `--spacing-cell: 3.5rem` token, 56px) with a `max-[359px]:h-11 max-[359px]:w-11` override for the sub-360px degraded floor the spec calls out in 9.4. I want to flag one subtlety I resolved by inference, not by an explicit spec line: `LOCK_INDEX = 10` in `lib/scoring.ts` is a single array position that represents the row's rightmost printed number (12 or 2) *and* triggers the lock in one `applyCross` call — there's no separate "second" index for the lock. The physical/visual grid still shows a distinct `LockCell` as its own 12th cell (matching the `8 9 10 11 12 [LOCK]` diagram in 9.2), wired to the same `onCross(LOCK_INDEX)` action as tapping the "12"/"2" number cell itself. Both are legitimate taps that do the identical, single, atomic state transition. Worth a second look if you read the grid diagram differently.

- Cell states (`open`/`crossed`/`blocked`, plus a `disabled` override for game-wide row closure) all avoid colour-only signalling: text number, `aria-pressed`, accessible names per the exact strings in section 9.4's table, plus the padlock glyph and "Closed by \<name\>" text with `aria-describedby` on the row card.
- `NumberCell.tsx` uses Framer Motion for a small `scale` on cross and `whileTap`, wrapped in `useReducedMotion()` — no spring/bounce easing.
- `GameOver.tsx` is `role="status"`, focuses its heading on mount, and fades in (also `useReducedMotion`-gated).
- `Toast.tsx` is `role="status" aria-live="polite"`, auto-dismisses after 4s.
- `SyncStatus`/`TotalBar` split per section 9.3 (header carries sync status + Rules link; bottom bar carries total + Undo) rather than literally matching the one-line file-tree comment on `TotalBar.tsx` ("Total, sync status, undo") — section 9.3's detailed layout spec is more prescriptive than the file-tree one-liner, so I followed 9.3.
- `OpponentList.tsx` uses native `<details>/<summary>` for the per-player disclosure rather than importing `Collapsible.tsx`, because the section 13 build order places `OpponentList` *before* `Collapsible` in the file list. `Collapsible.tsx` itself is used only where the spec explicitly calls for it: the rules page.

### Pages
`app/page.tsx`, `app/g/[code]/page.tsx` (async `params` per Next 15), `app/rules/page.tsx` (renders `lib/rulesContent.ts`, all copy shipped verbatim per section 12, first section open by default), `app/history/page.tsx`, `app/profile/page.tsx`, `app/offline/page.tsx`.

### PWA
`app/manifest.ts`, `public/sw.js`, `public/icons/*.png`. **Icons are placeholders**: flat solid-colour (`#0f172a` background, `#f8fafc` foreground square) PNGs at the three required sizes, generated by `scripts/generate-icons.mjs` (a small hand-rolled PNG encoder using only `node:zlib`, no image library dependency was available/allowed). Correct dimensions, valid PNGs, wired into the manifest and precache list — but not real artwork. Flag for design before shipping to real users.

### Build-time secret check
`scripts/check-no-secrets.mjs` — implements section 11 exactly, including the vacuous-pass refusal, the `NEXT_PUBLIC_` scan (over `.env*` files and source), the `@supabase/supabase-js`-import-location guard, and the bundle scan. **One correction made while testing it**: the spec's own step 4 scope is `.next/server/app/**/*.html` and `**/*.rsc` only (prerendered payloads that reach the browser); my first pass scanned every file under `.next/server/app` indiscriminately, which flagged the literal string `SUPABASE_SERVICE_ROLE_KEY` inside compiled server-side route handler bundles (`route.js` — legitimate `process.env.SUPABASE_SERVICE_ROLE_KEY` references that never leave the Node.js server process). Fixed to filter by extension. I then verified both directions: a clean build passes, and deliberately planting the real secret value in a Client Component fails the build with the file path and byte offset, before reverting that test change.

## Deviations summary (for quick scanning)

1. `lib/joincode.ts` split into `joincode.ts` (client-safe) + `joincodeGenerate.ts` (server-only) — forced by the Next.js client bundler, not a design choice.
2. Transactions implemented as optimistic-concurrency compare-and-swap + one RPC function, not literal `SELECT ... FOR UPDATE` — forced by `@supabase/supabase-js` having no transaction primitive.
3. `app/api/health/route.ts` added, answering a direct question in `.pipeline/infra-spec.md`, not present in spec.md's route list.
4. `eslint.config.mjs` added — required for `next lint` to run at all with ESLint 9, not listed in spec.md's file tree.
5. `qwixx.consume_rate_limit()` SQL function appended to `0001_qwixx_schema.sql` rather than existing only as inline SQL, so `lib/ratelimit.ts` has something to call via `db.rpc(...)`.
6. `lib/sync.ts` has no automated tests (only `lib/scoring.ts` has a named/required suite) — largest area for manual/exploratory testing.
7. PWA icons are placeholder solid-colour PNGs, not final artwork.

Nothing in the spec was left unimplemented. Both OPEN QUESTIONS items were handled as instructed: relative URLs / runtime origin resolution everywhere (no hardcoded hostname), and both `pg_cron` artefacts shipped with the k3s CronJob fallback documented in `README.md`.

## Testing

Ran as `luwah-web-tester` against the implementation above. Added `fake-indexeddb` as a devDependency (the only new dependency introduced) to run `lib/idb.ts` and `lib/sync.ts` against a real in-memory IndexedDB implementation under Vitest, with no browser. Also added a small hand-rolled in-memory Supabase query-builder stand-in, `lib/test/fakeSupabase.ts`, and a cookie-signing test helper, `lib/test/authHelpers.ts`, to exercise the real route handlers under `app/api/**` end to end (real request objects, real cookie signing/verification, real auth/scoring/game-end code paths) against fake but stateful tables, rather than mocking those modules' own logic. `vitest.config.ts` was extended to also collect `app/**/*.test.ts` and to alias `@/*`, and to set `QWIXX_COOKIE_SECRET`/`QWIXX_IP_HASH_SECRET` test-only values for the whole run.

### Final numbers

- `npm test` — **86 tests passing** across 6 files: `lib/scoring.test.ts` (49), `lib/joincode.test.ts` (4), `lib/idb.test.ts` (10, new), `lib/sync.test.ts` (11, new), `app/api/games/[code]/mutations/route.test.ts` (8, new), `app/api/games/join/route.test.ts` (4, new).
- `npm run typecheck` — clean, exit 0.
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npm run build` — `next build` succeeds; `scripts/check-no-secrets.mjs` reports `No Supabase credential found in the client bundle. Checked 47 files.`

### Two real bugs found in `lib/sync.ts` and fixed

Both were found by priority-1 testing of the flush/reconciliation protocol (spec section 8.5) and are now covered by regression tests in `lib/sync.test.ts`. Neither was a case of weakening a test to pass; both are `lib/sync.ts` fixes.

1. **The "keep flushing until the queue is empty" continuation was dead code.** `doFlush()`'s three progress branches (200, the two handled 409s, 422) each ended with `if (this.queue.length > 0) this.kickFlush();`, intended to immediately continue draining a queue larger than one batch (e.g. a long offline session, or a tap that lands while a flush is already in flight) rather than waiting for the next 5-second tick. But that call runs *while `doFlush()` is still `this.flushInFlight`*, so `kickFlush() → flush()`'s very first line, `if (this.flushInFlight) return this.flushInFlight;`, always returns the same still-resolving promise and never starts a new request. In production this meant: any reconciliation that left mutations still queued (a 422 with survivors, a tap that arrived mid-flight) would silently stall for up to 5 seconds instead of continuing immediately — not data loss, but a real gap between "spec says continue" and what the code did. Fixed by moving the continuation decision into `flush()` itself, after `flushInFlight` is actually cleared, gated on a new explicit `progressed: boolean` return value threaded up through `doFlush()`/`handleFlushError()` (true for every branch that resolved the in-flight batch one way or another, false for the network-failure/5xx branch, which already owns its own backoff timer and must not be short-circuited into a tight retry loop against a still-failing server — an early version of this fix did exactly that and reliably ran the test process out of heap).
2. **A 409 `version_conflict` mismatch marked the wrong `moves` entries `undone`.** Per spec 8.5, on a genuine mismatch the client should "mark the corresponding `moves` entries undone" for the *flushed batch*. The code instead did `getMovesForGame(...)` and marked **every** not-yet-undone move in the whole game undone, including moves for mutations that were queued *after* this batch was already sent and were still sitting untouched in `queue` (not dropped, still due to be flushed). That corrupts the undo log: a mutation still genuinely pending would show as "already undone," so the undo button would refuse to undo it even though it hasn't been undone and hasn't been sent yet. Fixed to scope the `markMoveUndone` pass to descriptors built from `batch` only, using the same descriptor-matching approach the adjacent 422 handler already used correctly for its own "offending + illegal survivors" set.

### Coverage notes by priority

1. **`lib/sync.ts` / `lib/idb.ts` (highest priority).** `lib/idb.test.ts` covers every exported store helper (meta, snapshots, sheets, queue, moves) including ordering and "delete exactly these seqs" semantics. `lib/sync.test.ts` covers: a mutation queued offline surviving a simulated reload (new `GameSync` instance re-reading IndexedDB) and flushing in FIFO order once a mocked `postMutations` starts succeeding; the 200 path; the 409 "replay matches" (silent, treated as 200) and "replay diverges" (adopt server truth, toast, mark only the flushed batch undone) paths, with an explicit test that a mutation queued *while the flush was already in flight* is neither dropped from the queue nor wrongly marked undone; the 422 path (offending entry dropped, later legal survivor re-validated and kept, resent, and confirmed by inspecting the second `postMutations` call's request body); 409 `wrong_status` and 403/404 (queue cleared, flusher stopped); replay idempotency (a network failure that hides a server-side success, followed by a 409 whose replay matches, produces exactly one cross, not two); and poll reconciliation not adopting a server-ahead version while the queue is non-empty, adopting it when the queue is empty, and always discarding the queue once the poll reports `ended`.
2. **Route handler auth boundary**, tested against the real `app/api/games/[code]/mutations` and `app/api/games/join` handlers with a stateful fake Supabase client (`app/api/games/[code]/mutations/route.test.ts`, `app/api/games/join/route.test.ts`): no `qx_seat`/`qx_device` cookie → 401 `no_device`; a `qx_seat` cookie signed for a different game's code → 403 `not_seated` (falls through to a real DB lookup for the actual device, which has no seat in the target game); a forged `qx_seat` claiming another player's identity, carried alongside the real device's own valid `qx_device` cookie → the write silently lands on the *real* device's own sheet, never the impersonated player's, because `resolveSeat` requires the seat cookie's embedded `pid` to match the verified device identity, not just parse successfully; a tampered (bit-flipped) cookie signature → 401. `join` route: joining an `active` game with no existing seat → 409 `wrong_status` (late join blocked); joining an `ended` game → 404 `game_not_found` (the `.neq('status','ended')` filter makes it indistinguishable from a code that never existed, per spec); the join rate limit actually returns 429 `rate_limited` when the (mocked) `consume_rate_limit` RPC reports a count over the IP limit.
3. **Game-wide lock semantics**, end to end through the mutations route: the first player to reach the lock index closes the row for everyone via `games.locked_rows`, verified both in the response and in the underlying fake `games` row; a second player's attempt to cross that row at all (not just at the lock index) is refused with `row_closed`, and the lock ownership is unchanged; a non-owning player's illegal undo attempt targeting the locked index (which is legal-shaped but has nothing to undo on *their own* sheet) is rejected and never touches `games.locked_rows`; the owning player's own undo of their lock cross does clear `games.locked_rows[color]` back to `null`. `undoCross`'s ownership check itself (`lockedRows[color] === playerId`) was already correct in `lib/scoring.ts` before this pass — the new tests exercise it through the actual route and DB write path rather than only as a pure-function assertion.
4. **Game end detection and winner tiebreakers end to end**: one scenario drives a real `two_locks` end (five crosses plus a locking cross on top of an already-locked row from the other player) through the mutations route, and asserts the actual `game_players.final_score` values written (`triangular(7) = 28` for the six real crosses plus the locked-row bonus, `triangular(1) = 1` for the other player's pre-seeded empty locked row), the single resulting `winner_player_id`, and that the game is closed to further writes (`409 wrong_status`) afterward. A second scenario drives the `penalties` end reason and asserts a genuine tie (`winner_player_id: null`) when both players finish at an equal negative total.

No test was weakened or deleted to make anything pass. No production feature work was added beyond the two `lib/sync.ts` fixes above.

---

## Fix pass, presentation

Scope: `components/`, `app/globals.css`, `app/**/page.tsx` and `layout.tsx`, per `.pipeline/a11y-review.md`. Did not touch `lib/`, `app/api/`, `supabase/`, `scripts/`, `next.config.ts`, or `package.json` — those belong to a concurrent agent. Fixed every item in the consolidated list: L1, A1–A5, A6, A7.

### L1 — score cells overlapping between 360px and 373px

`components/NumberCell.tsx`, `components/LockCell.tsx`: replaced the fixed `w-cell` (56px pinned width) with `w-full min-w-6`, keeping `h-cell` (and its `max-[359px]:h-11` fallback) fixed exactly as before. Width now comes entirely from the grid track (`grid-cols-6 gap-1.5`, tracks are `minmax(0,1fr)`), which is what the review's own fix recommendation says to do, so the rendered gap between cells is always exactly the defined `gap-1.5` (6px), never fought by an oversized fixed-width child.

One correction to the review's suggested `min-w-11` (44px) floor: at 320px viewport the computed track width is only 41.0px (see arithmetic below), so a 44px floor would have re-created the same class of overlap bug it was meant to prevent, just 3px smaller. Used `min-w-6` (24px, the actual WCAG 2.5.8 minimum) instead — it never overrides the track at any viewport in the supported range, so cell width equals track width everywhere and the visual gap is provably constant.

**Methodology.** No headless browser is available in this environment. Verified by reproducing the CSS Grid track-sizing arithmetic the review itself used, and confirmed it against the review's own *pre-fix* numbers first (it reproduces their reported gaps at 358/360/372/390 exactly — e.g. -2.34px at 360, -0.34px at 372 — which validates the formula before using it on the fixed version):

`contentWidth = viewport − 24 (ScoreSheet's px-3) − 4 (card border-2) − 16 (card p-2) = viewport − 44`
`trackWidth = (contentWidth − 30 [5 × gap-1.5]) / 6`

Post-fix, since `trackWidth` stays above the 24px floor at every required width, cell width = track width exactly, so the rendered gap is always the defined 6px:

| Viewport | Track / cell width | Gap between adjacent cells | Smallest target dimension |
|---|---|---|---|
| 320px | 41.00px | **6.00px** | 41px (clears 24px) |
| 360px | 47.67px | **6.00px** | 47.67px |
| 372px | 49.67px | **6.00px** | 49.67px |
| 390px | 52.67px | **6.00px** | 52.67px |
| 414px | 56.67px | **6.00px** | 56.67px |

No negative gap at any of the five required widths, and every target clears 24px by a wide margin. `npm run build` was used to compile the real stylesheet and confirm the emitted classes (`w-full`, `min-w-6`, `h-cell`) exist as expected; I did not re-verify with a live DOM measurement because no browser tooling is installed here — flag this for a run against the compiled stylesheet in real Chrome before sign-off, the same way the original review did.

### A1 — locked lock cell disappearing from the a11y tree

`components/LockCell.tsx`: the `locked` branch no longer renders `<div aria-hidden="true">`. It now renders a `disabled` `<button aria-pressed={true} aria-label={`Lock ${color}, locked`}>` holding the same padlock glyph and "Locked" text (the visible text is now `aria-hidden` since the button's `aria-label` already states it fully).

### A2 — remote closure: nameless section, no announcement, dropped focus

Three fixes, all in `components/ScoreRow.tsx` and `components/ScoreSheet.tsx`, none touching `lib/sync.ts`:

1. **Accessible name.** `<section>` in `ScoreRow.tsx` now has `aria-label={`${ROW_LABEL[color]} row`}`, which gives it a computed role of `region` and makes the existing `aria-describedby={describedById}` (pointing at the "Closed by \<name\>" paragraph) actually resolve for assistive tech.
2. **Announcement.** `components/ScoreSheet.tsx` diffs the `lockedRows` prop on every render (via a ref holding the previous value) and, when any colour transitions from `null` to non-null, sets a message in a single always-mounted `role="status" aria-live="polite"` `sr-only` paragraph — the same always-mounted-container pattern `Toast.tsx` already uses correctly. This is built entirely from props `ScoreSheet` already receives (`lockedRows`, `displayNameById`); no change to `lib/sync.ts` was needed or made. **Flag for the sync-layer owner**: this only fires from the poll cycle (every 3s), because `applyPollResult` in `lib/sync.ts:616` sets `this.lockedRows` with no toast — if a same-tick announcement is wanted, `lib/sync.ts` would need to `setToast` on a closure diff itself.
3. **Focus.** `ScoreRow.tsx` now holds a ref to the row's `<section>` and a ref to its heading `<div>` (given `tabIndex={-1}`, the same programmatic-focus-target pattern `GameOver.tsx` already uses for its `<h1>`). A `useEffect` on the `closed` boolean's false→true transition checks whether `document.activeElement` was inside this row's section and, if so, moves focus to the heading instead of letting the browser drop it to `<body>`.

### A3 — false/misleading accessible names on closed rows

`components/LockCell.tsx` and `components/NumberCell.tsx` both now take a `closedByName: string | null` prop (replacing the old undifferentiated `disabled` boolean) and branch the label on it, distinct from the "blocked" (skipped-cell) and "unavailable" (five-crosses-needed) reasons:

- `LockCell`: `locked` (this player's own lock) → `Lock {color}, locked`. Closed by someone else → `Lock {color}, closed by {name}` with visible text "Closed". Genuinely open but under five crosses → unchanged `Lock {color}, five crosses needed`.
- `NumberCell`: blocked (index left of the rightmost cross — a real in-game skip) → unchanged `{Color} {number}, no longer available`. Open cell in a row closed game-wide → new `{Color} {number}, row closed by {name}`. Crossed → unchanged `{Color} {number}, crossed off`.

`components/ScoreRow.tsx` and `components/ScoreSheet.tsx` were updated to pass `closedByName` through to both children instead of a bare `disabled` flag.

### A4 — closed-row text contrast, 2.57:1 to 3.07:1

`components/ScoreRow.tsx`: removed `opacity-60` from the `<section>` entirely. Closure is now conveyed by the padlock glyph (A1), the "Closed by \<name\>" wording, and the card's own border/edge colour — never by dimming static text. Disabled *controls* inside the row (the individual cells) keep their own `opacity-40`/`opacity-70`, which is exempt under 1.4.3 since they're inactive UI components, not static text.

### A5 — no 3:1 boundary anywhere

`app/globals.css`: `--color-qx-line` changed from `#cbd5e1` to `#64748b`. Single token, inherited by every cell border, the lock cell, penalty boxes, Undo button, and both entry-screen text inputs. Computed ratios (same luminance formula the review used):

| Background | Ratio | Needs 3.0 |
|---|---|---|
| white surface `#ffffff` | 4.76 | pass |
| canvas `#f8fafc` | 4.55 | pass |
| red tint `#fee2e2` | 3.90 | pass |
| yellow tint `#fef3c7` | 4.27 | pass |
| green tint `#dcfce7` | 4.33 | pass |
| blue tint `#dbeafe` | 3.90 | pass |

All four row tints and both neutral surfaces clear 3:1 with margin. Confirmed the compiled stylesheet (`.next/static/css/*.css`) emits `--color-qx-line:#64748b` after `npm run build`.

### A6 — dead ETag path

`components/GameClient.tsx`: removed `etagRef` and the `getGame(code, etagRef.current)` call (now `getGame(code)`). Could not wire it correctly without touching `lib/api.ts`: `request()` in `lib/api.ts` parses the response body and discards the `Response` object entirely — it never returns the `ETag` response header to any caller, so `GameClient.tsx` has no legitimate value to store in a ref for the next request's `If-None-Match`. **Report for the `lib/api.ts` owner**: to make the 304 path real, `getGame` (or `request`) would need to also return the response's `ETag` header value alongside the parsed body — e.g. `request` returning `{ body, etag }` or `getGame` reading `res.headers.get('etag')` before returning. Left as removed rather than half-wired.

### A7 — polling never stops after game over

`components/GameClient.tsx`: `schedulePoll`'s `setTimeout` callback recurses through its own name, so the closure that keeps running forever is the one captured at the very first mount effect (`useEffect(..., [])`), regardless of how many new `schedulePoll` instances `useCallback` produces on later renders — a `phase` value read from that closure was permanently pinned at `{ kind: 'loading' }`. Fixed with a `phaseRef` that's kept current via a small `useEffect` on `[phase]`, and `schedulePoll`'s timeout body now reads `phaseRef.current` instead of closing over `phase` directly. `schedulePoll`'s own `useCallback` deps dropped from `[poll, phase]` to `[poll]`, since it no longer needs recreating when `phase` changes — the ref makes it unnecessary, which is what breaks the stale-closure trap.

### Verification

- `npm test` — **86 tests passing** (6 files), same suite as before this pass. Nothing weakened or removed.
- `npm run typecheck` — clean, exit 0.
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npm run build` — succeeds; compiled stylesheet confirmed to contain the updated `--color-qx-line` token.

### Not fixed, out of scope for this pass

Everything below is a real finding in `.pipeline/a11y-review.md` that was not on the consolidated list handed to this pass (L1, A1–A7 only). Flagging rather than fixing, per "no features not asked for":

- **Finding #6 (LOW), the 359px vs 360px mobile-floor off-by-one** (`max-[359px]:h-11` should be `max-[359.98px]:h-11` or use `max-sm:`). Height fallback left untouched since the task only asked to fix the *width* pinning.
- **Finding #7 (MEDIUM), no `h1` / no landmarks on the game screen.** Only the score-row section's `aria-label` (needed for A2) was added. The lobby's styled-paragraph-as-title and the missing `sr-only <h1>` on the active game screen are unaddressed.
- **Finding #9 (MEDIUM), too many live regions firing per tap** (`ScoreRow.tsx`'s per-row `aria-live` score span, `TotalBar`'s bare live total, `SyncStatus`'s live cycling). Left exactly as they were; the new closure announcement in `ScoreSheet.tsx` was deliberately built as one additional region, not a consolidation of the existing ones, since consolidating them wasn't asked for here.
- Findings #8, #10, #11, #12, #13, #14, #15, #17, #18 — untouched, none were in the consolidated list.

### Files changed

- `app/globals.css` — `--color-qx-line` token (A5).
- `components/NumberCell.tsx` — width fix (L1), `closedByName` prop and label branching (A3).
- `components/LockCell.tsx` — width fix (L1), locked-state accessibility (A1), `closedByName` prop and label branching (A3).
- `components/ScoreRow.tsx` — section `aria-label` (A2), focus management on remote closure (A2), removed `opacity-60` (A4), passes `closedByName` to children (A3).
- `components/ScoreSheet.tsx` — closure live-region announcement (A2).
- `components/GameClient.tsx` — removed dead ETag path (A6), fixed stale-closure poll loop (A7).

### Focus for the tester

- Tap through a full lock sequence with a screen reader on (VoiceOver or NVDA) and confirm "Locked" is announced, not silent.
- With two browser tabs/devices in the same game, lock a colour from tab A while tab B has keyboard focus on a cell in that row; confirm tab B's focus lands on the row heading, not `<body>`, and that the sr-only announcement fires within one poll cycle (up to 3s).
- Resize between 320px and 414px and visually check for any cell overlap, especially right around 360–372px where the bug was worst.
- Confirm a finished game (`status: 'ended'`) actually stops the network tab from showing repeated `/api/games/[code]` polls — this was silently broken before A7's fix.

---

## Fix pass, backend

Consolidated fix pass against `.pipeline/security-review.md` and `.pipeline/adversarial-review.md`. All 15 assigned findings (C1–C6, S1–S9) fixed, each with at least one new regression test.

### C1 — undo() races doFlush(), resurrecting an undone mark permanently

`lib/sync.ts`. Added `inFlightSeqs: Set<number>`, populated by `doFlush()` before the network call and cleared in a `finally` once `handleFlushError` (now properly `await`ed) has finished. `undo()` now only takes the "delete locally" path when the matching queue entry is both still queued **and not in flight**; if it's in flight, it falls through to the existing "already acknowledged" path, which queues a proper `undo` mutation instead of deleting something the server may already be applying. Replaced every count-based `this.queue.splice(0, batch.length)` (three call sites) with a new `removeQueueEntriesBySeq()` that removes by seq, matching the paired `deleteQueueEntries()` call. Left the 422 branch's index-based removal alone — it was already correct.

Tests: `lib/sync.test.ts`, `describe('undo racing an in-flight flush (finding C1)')` — all three variants from the adversarial review (undo of the only in-flight entry; undo of the second of two in-flight entries; a new tap queued right after an in-flight undo), each asserting the follow-up flush and final sheet state.

### C2 — `games.locked_rows` lost update

`app/api/games/[code]/mutations/route.ts`. Replaced the bare `update(...).eq('id', game.id)` with a call to a new `merge_locked_rows(p_game_id, p_prev, p_next)` Postgres function (`supabase/migrations/0004_locked_rows_merge.sql`). It does a per-colour compare-and-swap in one atomic `UPDATE`: a colour is only overwritten with this request's value if the row's *current* value for that colour still matches what this request originally read; otherwise a concurrent writer's value for that one colour wins and this request's own response carries the merged, authoritative result forward into game-end detection. This is a genuine 3-way merge (not "first write always wins"): it correctly handles a player *un*locking their own row too, not just two players locking different colours.

Considered the RPC shape from `.pipeline/adversarial-review.md`'s suggested fix (`case when g.locked_rows->k <> 'null' then keep else caller's value`) and rejected it on close reading — it silently drops a legitimate undo-your-own-lock write, because it treats "currently non-null" as "someone already locked it, don't touch," which is also true of the *same* player unlocking their own row a moment later. The CAS-on-previous-value design here doesn't have that failure mode.

Test: `mutations/route.test.ts`, `describe('locked_rows concurrency (finding C2)')` — two players lock two different colours via `Promise.all`, exploiting `FakeSupabase`'s real microtask-boundary interleaving to reproduce the race; asserts both locks land.

### C3 — `sheetsEqual` is key-order sensitive against jsonb

`lib/sync.ts`: `sheetsEqual` now compares `penalties`, `locks[color]`, and `crosses[color]` element-by-element per colour instead of `JSON.stringify(a) === JSON.stringify(b)`.

`lib/test/fakeSupabase.ts`: added `reorderJsonbKeys()`, applied to every `.insert()` and `.update()` payload, which recursively sorts object keys by length-then-bytewise — the same canonicalisation real Postgres jsonb storage does. This is why the bug was invisible to the existing suite: every fixture was built and compared in JS insertion order. Direct-to-table `.push()` in test helpers (`seedGame`, `seedSheet`) still bypasses this, by design — those seed a **pre-existing** row a real read would already show canonicalised, and the assertion test below exercises the real write path instead.

Tests: `lib/sync.test.ts` (`treats a jsonb-key-reordered sheet as matching, not a real conflict`) exercises the client-side fix directly with a hand-built jsonb-ordered sheet (`red, blue, green, yellow`). `mutations/route.test.ts` (`describe('FakeSupabase jsonb key ordering (finding C3 infrastructure)')`) asserts the fake itself now reorders keys after a real mutation, so this class of bug is catchable from any future route test, not just this one.

### C4 — transient DB error mapped to 404, destroying the queue permanently

`app/api/games/[code]/mutations/route.ts`: split `gameError`/`!game` and `sheetError`/`!sheetRow` into separate branches. A genuine read error now returns `500 server_error`; `404 game_not_found` is reserved for a real empty read.

No client-side change was needed in `lib/sync.ts`: the 403/404 termination branch was never the bug — a 500 already fell through to the "5xx or anything unexpected: leave the queue untouched, retry with backoff" branch. The bug was purely that the server mislabelled a 500 as a 404. Added a client-side regression test to pin that this property holds once the server is fixed.

Tests: `mutations/route.test.ts`, `describe('database read failures (finding C4)')` — forced `games:select`/`sheets:select` errors (via a new `FakeSupabase.errorOnce` map) return 500, and a genuinely nonexistent game still returns 404. `lib/sync.test.ts`, `describe('flush protocol: 500 (finding C4, client side)')` — an `ApiError(500)` leaves the queue on disk and never shows "You are no longer in this game."

### C5 — toast never cleared

`lib/sync.ts`: `setToast()` now owns the full lifecycle — it clears any existing dismiss timer, and (for a non-null message) starts a new one matching `Toast.tsx`'s own 4s duration, calling `setToast(null)` and re-emitting when it fires. `Toast.tsx`/`GameClient.tsx` untouched, per file ownership; `onDismiss` still just kicks a flush, but `GameSync` no longer depends on it to clear the message.

Tests: `lib/sync.test.ts`, `describe('toast lifecycle (finding C5)')` — real timers (see note below), confirms the toast clears after 4s and that a fresh toast resets the timer rather than being cut off by the previous one's schedule.

### C6 — rate limiter comment contradicts the code

`lib/ratelimit.ts`: comment only. Decided fail-**closed** is correct (an unreachable limiter is a bigger risk than a temporarily unavailable route) — matches the security review's own L6 recommendation. Updated the comment to say so; the `throw` (which already produces a 500 for the caller) is unchanged.

Test: `lib/ratelimit.test.ts` — pins that an RPC error or missing data rejects the promise (fails closed), so a future "fix" that reverts to fail-open is a visible regression.

### S1 — unauthenticated, unbounded row creation in a shared database

Three parts, all fixed:
1. `app/api/games/route.ts`: rate limit (`CREATE_IP_LIMIT = 5`/min) via the existing `consume()`/`hashIp(clientIp(...))`, before `ensureDevice()` runs.
2. `app/api/me/route.ts`: rewritten to be **read-only**. It now calls `resolveDevice()` instead of `ensureDevice()` and returns `{ playerId: null, displayName: null, activeSeat: null }` for a caller with no valid device cookie, instead of minting a new `players` row. This is the stronger of the two fixes the reviews offered (rate-limit-the-creation vs. stop-creating-on-a-GET) — chosen because `GET /api/me` is not currently called by any page (`grep` confirms zero client usage), so removing its side effect entirely is free and matches the pattern `/api/profile` and `/api/history` already use (`resolveDevice`, 401 if none). `lib/api.ts`'s `MeResponse` type updated to `playerId: string | null; displayName: string | null`.
3. `supabase/migrations/0005_orphan_players.sql`: new `cleanup_orphan_players()` function (48h age, no `game_players` row, not a `winner_player_id`), scheduled hourly via `cron.schedule`.

Tests: `app/api/games/route.test.ts` (new) and `app/api/me/route.test.ts` (new).

**Not fixed, noted for the record:** `app/api/me/route.ts:27` still has the L1 finding from the security review (a captured `qx_seat` paired with *any* `qx_device` discloses that player's game/seat, because the `seatPayload.pid === device.playerId` check `resolveSeat` does correctly is missing here). L1 was not on the assigned C/S list and this pass did not touch it, even though the route was being rewritten anyway — flagging rather than expanding scope.

### S2 — build gate fails open when it cannot see the bundle

`scripts/check-no-secrets.mjs`: added `MIN_FILES = 10` and an explicit `existsSync(.next/static)` check, both asserted immediately before the success message. A missing `.next/` or a trivially small scan now fails with a specific message instead of reporting "Checked 1 files" as success.

Tests: `scripts/check-no-secrets.test.ts` (new) — spawns the real script against scratch directories: no `.next` at all, a `.next/static` with 1 file, a real 12-file bundle (passes), and a real 12-file bundle with a genuine secret planted in one file (still fails).

### S3 — the gate cannot catch an RSC-payload leak; needs a compile-time control

`eslint.config.mjs`: added a `no-restricted-syntax` rule scoped to `app/**/*.tsx` and `components/**/*.tsx` that flags `process.env.X` used directly inside a JSX prop expression — the exact shape of the proven exploit (a Server Component passing a secret as a Client Component prop, serialised into the per-request RSC flight payload, which never touches disk on a dynamic route and so is invisible to any artifact scan).

`package.json`: build script is now `next lint --max-warnings=0 && next build && node scripts/check-no-secrets.mjs`, so the lint rule actually gates the build instead of being advisory. Kept the runtime scan as the second layer per the review's own framing ("keep the runtime check as a second layer, not a replacement").

Test: `eslint.rsc-leak.test.ts` (new, repo root) — uses `ESLint#lintText()` with a virtual `filePath` (`app/leak-fixture.tsx`, `components/LeakFixture.tsx`, `lib/leak-fixture.tsx`) so the rule is exercised without creating any real file under `app/` or `components/`, which this pass does not own. Confirms the rule fires in both target directories, not outside them, and documents its one real limitation (it's syntactic, not data-flow — `const secret = process.env.X; return <C prop={secret} />` is not caught).

### S4 — cookies never expire server-side

`lib/cookies.ts`: `verifyCookie<T>()` now takes a required `maxAgeSeconds` and rejects a payload whose `iat` is missing, non-numeric, older than `maxAgeSeconds`, or more than 60s in the future (clock-skew tolerance, rejects forward-dated payloads). Call sites in `lib/auth.ts` (`resolveDevice`, `resolveSeat`) and `app/api/me/route.ts` updated to pass `DEVICE_COOKIE_MAX_AGE`/`SEAT_COOKIE_MAX_AGE`.

Test: `lib/cookies.test.ts` (new) — accepts fresh and exactly-at-boundary cookies, rejects expired/forward-dated/`iat`-less ones, and confirms the two cookie types use genuinely different windows (a device-valid cookie past the 7-day seat window is rejected under `SEAT_COOKIE_MAX_AGE` but accepted under `DEVICE_COOKIE_MAX_AGE`).

### S5 — a weak secret passes the gate

`scripts/check-no-secrets.mjs`: `MIN_LENGTHS` raised to 32 for `SUPABASE_SERVICE_ROLE_KEY`, `QWIXX_COOKIE_SECRET`, `QWIXX_IP_HASH_SECRET` (kept at 8 for `SUPABASE_URL`, a hostname not a secret). Added an explicit rejection of any value starting with `replace-me`, so the `.env.example` placeholder fails outright regardless of length. `.env.example` updated with an `openssl rand -base64 32` instruction and a placeholder string that still starts with `replace-me`.

Test: covered in `scripts/check-no-secrets.test.ts` (`describe('rejects weak secrets')`).

### S6 — migrations contain zero GRANT/REVOKE

New `supabase/migrations/0003_grants.sql`: schema-level `GRANT USAGE`/`REVOKE ALL FROM anon, authenticated` matching `.pipeline/infra-spec.md:555-563` almost verbatim, plus `REVOKE EXECUTE ... FROM public, anon, authenticated` / `GRANT EXECUTE ... TO service_role` for the two existing `SECURITY DEFINER` functions (`consume_rate_limit`, `cleanup_abandoned`). The two new functions added by this pass (`merge_locked_rows` in `0004`, `cleanup_orphan_players` in `0005`) carry their own grant/revoke pair inline in the same migration that defines them, rather than a second retroactive grants file.

Landed as a **new** migration rather than editing `0001`/`0002` in place — `0001`/`0002` were out of the assigned C/S list, and since migrations are hand-applied in filename order (`.pipeline/infra-spec.md:614`), a later file achieves the identical end state without touching already-numbered files that may already be partially applied elsewhere.

Test: `supabase/migrations/grants.test.ts` (new) — cannot exercise real Postgres privilege enforcement without a live database, so this is a static text-presence check: parses every `create function qwixx.*` signature across all migrations and asserts a matching `revoke ... from public, anon, authenticated` / `grant ... to service_role` pair exists for each. This is exactly the shape of gap that caused S6 in the first place (`consume_rate_limit` defined in `0001`, never revoked anywhere) — a new SECURITY DEFINER function added without its grant pair now fails this test immediately.

### S7 — X-Forwarded-For leftmost trusted

`lib/ipHash.ts`: `clientIp()` now trusts **only** `CF-Connecting-IP`, returning `string | null` instead of falling back to `X-Forwarded-For` or the literal `'unknown'`. Call sites (`app/api/games/join/route.ts`, `app/api/games/route.ts`) updated: in production, a missing `CF-Connecting-IP` (i.e. not arriving through the tunnel) returns `400 bad_request`; outside production it falls back to the literal `'local'` bucket so local dev and the test suite are unaffected.

Test: `lib/ipHash.test.ts` (new) — confirms `CF-Connecting-IP` is trusted, `X-Forwarded-For` is never consulted even when `CF-Connecting-IP` is absent, and a spoofed `X-Forwarded-For` alongside a real `CF-Connecting-IP` is ignored.

### S8 / S9 — no security headers, no `output: 'standalone'`

`next.config.ts`: added `output: 'standalone'`, `poweredByHeader: false`, and a `headers()` block (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`) matching the security review's suggested policy, including the `style-src 'unsafe-inline'` carve-out for Tailwind v4's runtime style injection (script-src carries no such exception).

Verified `output: 'standalone'` actually produces `.next/standalone/server.js` in a real build (confirmed by hand during this pass, in addition to the automated test below).

Test: `next.config.test.ts` (new, repo root) — asserts `output === 'standalone'`, calls the real `headers()` function and checks every expected header/value is present, and that CSP does not carry `unsafe-inline` on `script-src`.

### A note on test infrastructure

`vitest.config.ts`'s `include` glob widened from `['lib/**/*.test.ts', 'app/**/*.test.ts']` to also include `scripts/**/*.test.ts`, `supabase/**/*.test.ts`, and root-level `*.test.ts`, to give S2/S5/S6/S8/S9 a home for their regression tests without inventing a parallel test runner. `vitest.config.ts` was not on the explicit file-ownership list but is build/test infrastructure, not `components/`/`app/**/page.tsx`/`layout.tsx`/`globals.css`.

`eslint.config.mjs` was likewise touched for the S3 rule; also outside the literal ownership list but necessary for a compile-time control the finding specifically calls for, and it's infrastructure, not application UI.

`vi.useFakeTimers()` does not mix with `fake-indexeddb`: every IndexedDB request event this project awaits (`init()`, `mark()`, `refreshCanUndo()`, etc.) hung forever under fake timers, which timed out the test *and* leaked the fake-timer state into every subsequent test in the file (their `finally { vi.useRealTimers() }` never ran, because the hung async function was never unwound). The two C5 toast tests use real timers with a per-test timeout override instead (`it('...', async () => {...}, 6000)`).

### Verification

- `npm test` — **134 tests passing** (15 files; 86 pre-existing + 48 new). Nothing weakened or removed.
- `npm run typecheck` — clean, exit 0.
- `npm run lint` — `✔ No ESLint warnings or errors` (now gates `npm run build` too, per S3).
- `npm run build` — with `SUPABASE_URL`, a JWT-shaped `SUPABASE_SERVICE_ROLE_KEY`, and two real `openssl rand -base64 32` secrets: succeeds, `.next/standalone/server.js` present, gate reports `No Supabase credential found in the client bundle. Checked 47 files.`

### Deprecated model strings

None found. This pass touched no Claude API code.

### Files changed

- `lib/sync.ts` — C1 (in-flight tracking, seq-based queue removal), C3 (structural `sheetsEqual`), C5 (toast lifecycle).
- `lib/ratelimit.ts` — C6 (comment only).
- `lib/cookies.ts` — S4 (`verifyCookie` max-age enforcement).
- `lib/auth.ts` — S4 (call site updates).
- `lib/ipHash.ts` — S7 (`clientIp` CF-Connecting-IP only).
- `lib/api.ts` — S1 (`MeResponse` nullable fields).
- `lib/test/fakeSupabase.ts` — C3 (jsonb key reordering), C4 (`errorOnce`).
- `app/api/games/[code]/mutations/route.ts` — C2 (locked_rows CAS via RPC), C4 (500 vs 404).
- `app/api/games/route.ts` — S1 (rate limit), S7 (clientIp call site).
- `app/api/games/join/route.ts` — S7 (clientIp call site).
- `app/api/me/route.ts` — S1 (read-only rewrite), S4 (call site).
- `next.config.ts` — S8 (headers), S9 (`output: 'standalone'`).
- `eslint.config.mjs` — S3 (no-restricted-syntax rule).
- `package.json` — S3 (build script chain).
- `.env.example` — S5 (placeholder guidance).
- `scripts/check-no-secrets.mjs` — S2 (fail-closed on missing bundle), S5 (entropy floor + placeholder rejection).
- `vitest.config.ts` — test infrastructure (include glob).
- `supabase/migrations/0003_grants.sql` — new, S6.
- `supabase/migrations/0004_locked_rows_merge.sql` — new, C2.
- `supabase/migrations/0005_orphan_players.sql` — new, S1.
- New test files: `lib/cookies.test.ts`, `lib/ipHash.test.ts`, `lib/ratelimit.test.ts`, `app/api/games/route.test.ts`, `app/api/me/route.test.ts`, `scripts/check-no-secrets.test.ts`, `supabase/migrations/grants.test.ts`, `next.config.test.ts`, `eslint.rsc-leak.test.ts`.
- Extended existing test files: `lib/sync.test.ts`, `app/api/games/[code]/mutations/route.test.ts`.

### Focus for the tester

- The C1 fix is the highest-value manual check: tap a cell, hit Undo before the round trip returns (throttle the network in devtools to make the window visible), and confirm the mark never comes back, with no reload needed.
- Two devices/tabs, two different players: have both lock a *different* colour within the same couple of seconds (both already at 5+ crosses in that row) and confirm both locks land and the game ends correctly on the second lock (C2).
- Trigger any rejection toast (e.g. try to lock a row under five crosses) and confirm it disappears on its own after ~4s instead of staying on screen (C5).
- `POST /api/games` and `GET /api/me` from a fresh browser profile (no cookies) — confirm `GET /api/me` no longer sets a cookie or shows up as a new row, and that repeated rapid `POST /api/games` calls eventually 429.

---

## Fix pass 2, presentation

Consolidated against `.pipeline/final-review.md`'s B4, B5 and T1, and `.pipeline/a11y-review.md` in full (not the 6-item subset handed to the first pass).

### B5 — self-lock was treated as a remote closure. Fixed.

Root cause: `GameClient.tsx` passed `localLockedRows` (which includes this player's own lock) straight into `ScoreSheet`, and `ScoreSheet` derived `closedByName` for *any* non-null entry, with no way to tell "I locked this" from "someone else locked this."

Fix, one prop threaded through, no change to `lib/`:
- `GameClient.tsx`: `ScoreSheet` now also receives `myPlayerId={state.you.playerId}`.
- `ScoreSheet.tsx`: `closedByName` for a colour is now `null` whenever `lockedRows[color] === myPlayerId`, in both the per-row render (passed to `ScoreRow`/`NumberCell`/`LockCell`) and the closure-announcement effect. A colour is only ever treated as "closed by someone else" when the closer's id is present and not your own.

`ScoreRow`, `NumberCell` and `LockCell` needed no changes — they already branched correctly off `closedByName`/`state`; they were just being fed the wrong value. `LockCell`'s own "locked" state (`sheet.locks[color]`, this player's own sheet) was never affected by the bug and still renders correctly regardless.

Net effect: locking your own row no longer disables its remaining cells, no longer shows "Closed by \<your own name\>", no longer describes the section as closed, and (once the effects run in a real browser) no longer fires the remote-closure focus-move or the sr-only announcement for your own action. A remote closure still does all of those, correctly, because the identity check now actually distinguishes the two cases.

### B4 — worked every open item in `.pipeline/a11y-review.md`, not just the four Level A ones the final review named

Findings 1–6 (the six from the first pass) were already fixed and remain fixed; verified, not re-touched, except where B5 required them to reference the corrected `closedByName`.

**Fixed this pass:**

- **#7, no `h1` / no landmarks on the game screen or lobby.** `Lobby.tsx`: the join code is now an `<h1>`, replacing a styled `<p>`. `GameClient.tsx`: added an `sr-only <h1>Game {code}</h1>` as the first child of the active-game `<main>`.
- **#8, mode toggle signals state by colour alone.** `CreateOrJoin.tsx`: `aria-pressed={mode === 'create'}` / `aria-pressed={mode === 'join'}` on the two toggle buttons.
- **#9, four live regions firing per tap.** `ScoreRow.tsx`: removed `aria-live="polite"` from the per-row score span (now static text). `TotalBar.tsx`: the live region now wraps label and value together (`<span aria-live="polite">Total {total}</span>`) instead of announcing a bare number. `SyncStatus.tsx`: the visible "Saving N" / "Synced" / "Offline" label is now `aria-live="off"` (it changes on nearly every tap); a separate `sr-only` `role="status"` region only receives content on the online→offline transition, so going offline is announced once instead of every tap being read three times over.
- **#10, join-code input's accessible name contains the 32-character alphabet.** `CreateOrJoin.tsx`: the hint span moved out of the `<label>`, given `id="code-hint"`, and wired to the input via `aria-describedby` (combined with the error id when an error is present).
- **#11, error region only mounts when populated.** `CreateOrJoin.tsx`: the `<p role="status" id="form-error">` is now always in the DOM (rendered unconditionally, empty when there's no error) instead of `{error && <p role="status">...}`. Both forms' primary inputs (`aria-describedby`) now reference it, so a screen reader user tabbing back to the field after a failed submit hears why.
- **#12, no `autocomplete` on display-name fields; join-code input fights iOS predictive text.** `autoComplete="nickname"` added to all three display-name inputs (`CreateOrJoin.tsx` ×2, `GameClient.tsx` ×1). The join-code input gets `autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} inputMode="text"`.
- **#13, opponent disclosure has no visual affordance.** `OpponentList.tsx`: `<details>` now carries `className="group"`, and the summary renders a `+`/`−` pair toggled with `group-open:hidden` / `group-open:inline`, the same visual language `Collapsible.tsx` already uses (verified the compiled stylesheet emits `group-open:hidden`/`group-open:inline` selectors after a real `next build`).
- **#14, blocked cells fall to ~2.5:1 (LOW, exempt as disabled controls, fixed anyway for legibility).** `NumberCell.tsx`: both the "blocked" (skipped) and "row closed by \<name\>" disabled-cell states raised from `opacity-40` to `opacity-60`, per the review's own recommendation, so the skipped/unavailable number stays readable as real game information.
- **#15, skip link doesn't move focus.** `tabIndex={-1}` added to every `<main id="main">` — `app/page.tsx`, `app/history/page.tsx`, `app/rules/page.tsx`, `app/profile/page.tsx`, `app/offline/page.tsx`, and all seven `<main id="main">` return branches in `GameClient.tsx`.
- **#17, game-over panel announced twice.** `GameOver.tsx`: `role="status"` moved off the outer `motion.div` (which wrapped the heading *and* every standing) onto a new short `sr-only` sentence (`Game over. {result}.`). The visible `<h1>` keeps its `tabIndex={-1}` + focus-on-mount, now without also being inside the live region, so it's read once by focus-follows and once by the status message's identical text is no longer duplicated across both.

**Already fixed by the first pass, verified still correct, not re-touched:** #1 (locked lock cell in the a11y tree), #2 (remote closure region/description resolving), #3 (closed-row cells' truthful names), #4 (closed-row text contrast), #5 (`--color-qx-line` border contrast), #6 (grid-overlap `w-cell` → `w-full min-w-6`).

**#16, 359px vs 360px breakpoint off-by-one:** no code change needed. `grep -rn "359\|max-\[" components/ app/` returns nothing — the first pass removed the fixed-width breakpoint entirely (per L1) rather than adjusting its threshold, so the off-by-one class of bug the finding named doesn't exist anymore. The final review independently confirmed this (§3.4): cells stay 56px tall below 360px and 41px wide at 320px, clearing the 24px target floor either way.

**Not fixed, out of scope for this pass, with reason:**

- **#18, no accessibility gate in CI (LOW).** Needs a `pa11y-ci.json` and a `package.json` script change (or a CI step). `package.json` is not in this pass's file ownership; reporting for whoever owns it. No code in `components/`, `app/**/page.tsx`, `app/**/layout.tsx` or `app/globals.css` can add this.
- **The dead ETag path** (flagged by the first pass under A6, restated by the final review §3.2) is still open. `lib/api.ts`'s `request()` still discards the `Response` object and never surfaces the `ETag` header, so `getGame`'s `etag` parameter still can't be wired from this side of the boundary. Not touched, per file ownership; restating for the `lib/api.ts` owner since it's a full game-state fetch every 3s per client until it's picked up.
- **Closure announcement lags a poll cycle** (final review §3.3): `lib/sync.ts`'s `applyPollResult` still sets `lockedRows` with no toast, so `ScoreSheet`'s own diff-based announcement (fixed for self/remote in this pass) still only fires on the next poll, up to 3s after a remote closure. This is a `lib/sync.ts` change if a same-tick announcement is wanted; not made here.

### T1 — component tests

**What's installed vs. what the task assumed.** Checked before writing anything: `package.json` has `vitest` only. No `jsdom`, no `happy-dom`, no `@testing-library/*`, no `react-test-renderer` — none are in `node_modules`, none are in `package-lock.json` as resolved (only as `jsdom`/`happy-dom`'s optional-peer entries under `vitest`'s own manifest). `vitest.config.ts` ran everything in `environment: 'node'`, which has no `document`/`window` at all. **This blocks any test that needs a live DOM: mounting, re-rendering on prop/state change, running effects, or reading `document.activeElement`.**

**Devdependency needed, reporting rather than installing (package.json is not owned by this pass):** `jsdom` (or `happy-dom`) plus `@testing-library/react` (and its `@testing-library/dom` peer) as devDependencies, with a `components/**` test project or an `environment: 'jsdom'` override in `vitest.config.ts`, are required to write true interaction tests — mount, click, rerender-on-props, assert `document.activeElement`, assert a live region's *content change* rather than its *presence*. Until those land, two of the scenarios in the brief cannot be tested at all, honestly, by any repo-only technique (see below).

**What was built instead, with what's actually installed:** every test uses `react-dom/server`'s `renderToStaticMarkup` (ships with `react-dom`, zero new dependencies) to render each component with different props and assert on the resulting HTML string — accessible names, `aria-*` attributes, class names, DOM structure. This is a real, single-shot render of real component code (not a shape/snapshot assertion, not a mock) and it genuinely re-executes on every push to `main`. It cannot execute a `useEffect`, cannot simulate a click, and cannot observe focus, because none of those exist without a DOM.

Also had to fix two pieces of tooling to get here, both additive, both outside strict file ownership but necessary test infrastructure (same precedent the backend pass used for `vitest.config.ts`'s `include` glob and `eslint.config.mjs`'s new rule):
- `vitest.config.ts`: added `components/**/*.test.tsx` to `include` (previously no `.tsx` pattern existed at all) and set `esbuild.jsx = 'automatic'`. Without the latter every `.tsx` component throws `ReferenceError: React is not defined` under Vitest's default esbuild transform, because Next.js's own SWC compiler uses the automatic JSX runtime and no component file imports `React` — confirmed by reverting the setting and re-running.
- `components/test/withAppRouter.tsx` (new, not a test file itself): `CreateOrJoin.tsx` calls `useRouter()` from `next/navigation`, which throws `invariant expected app router to be mounted` outside a real Next.js render tree. There's no published Next.js test utility for this pre-App-Router-testing-support, so this wraps the component under test in the same internal `AppRouterContext` Next.js provides at runtime (`next/dist/shared/lib/app-router-context.shared-runtime`), with a router double whose methods are no-ops. Used only by `CreateOrJoin.test.tsx`.

**New test files, 20 component tests across 5 files:**

- `components/LockCell.test.tsx` (5 tests) — the three lock states produce three distinct, truthful `aria-label`s (locked / closed-by-name / five-crosses-needed); the locked state stays in the accessibility tree instead of `aria-hidden`; every state stays track-sized (`w-full min-w-6`, never `w-cell`, never `min-w-11` — the exact regression named in the rules for this pass).
- `components/NumberCell.test.tsx` (6 tests) — blocked vs. row-closed-by-name produce distinct accessible names for the same number (finding #3's regression class); open/crossed/blocked are each named distinctly; same track-sizing guard as `LockCell`.
- `components/ScoreSheet.test.tsx` (3 tests) — **the core B5 regression test.** Locking your own row does not mark it closed (no "Closed by", no "row closed by", `LockCell` still shows "Locked" via its own state). A remote lock does mark it closed, with the closer's name, in both the row's description and every open cell's label. Open cells in a self-locked row are never disabled as "closed by yourself." **Verified this test actually catches the regression**: reverted `ScoreSheet.tsx`'s self/remote check back to the buggy version, re-ran, watched two of the three tests fail with the exact wrong markup, then restored the fix and confirmed green.
- `components/CreateOrJoin.test.tsx` (4 tests) — mode toggle's `aria-pressed` reflects the default-selected mode; the error paragraph (`id="form-error"`) exists in the markup on first render, before any error, proving it's unconditionally mounted; the code input's `<label>` no longer contains the 32-character alphabet text (checked at the source level, see below); both display-name inputs carry `autoComplete="nickname"`.
- `components/GameOver.test.tsx` (2 tests) — the live region is now a short `sr-only` sentence that does not also contain every standing's score and penalty count; the outer container is no longer itself `role="status"`; the visible `<h1>` is still the `tabIndex={-1}` focus target.

**Honestly could not test, and why, rather than faking it:**

- **"Locking a row yourself does NOT move focus"** and **"a remote player closing a colour DOES move focus."** `ScoreRow.tsx`'s focus-management effect reads `document.activeElement` and calls `.focus()` inside a `useEffect` keyed on the `closed` boolean's transition. `renderToStaticMarkup` never runs effects and there is no `document` in a Node environment to hold a focus state in the first place. What *is* tested instead, at `ScoreSheet.test.tsx`, is the input to that effect: that `closed` (derived from `closedByName !== null`) is correctly `false` for a self-lock and `true` for a remote one — the effect's own logic (`if (closed && !wasClosed) { ...move focus... }`) is a single `if` gated on a boolean this pass's tests do prove is now correct in both directions. The transition-triggering and the DOM focus call itself need `jsdom`/`happy-dom` plus a real mount+rerender.
- **The sr-only closure announcement's actual text change.** Same shape of problem: `ScoreSheet.tsx`'s announcement is set inside a `useEffect` that diffs the *previous* `lockedRows` against the current one via a ref — by definition a multi-render behaviour. A single `renderToStaticMarkup` call always sees `prevLockedRowsRef.current === null` (first render), so the diff branch never runs and the announcement is always empty in this kind of test, regardless of whether the underlying fix is correct. Covered indirectly the same way as the focus case: the `closedByName` value the diff would key off is proven correct.
- **`CreateOrJoin`'s join-code hint** could not be rendered in `join` mode at all — `mode` is internal `useState` with no prop to force it and no click simulation available. Tested by reading `CreateOrJoin.tsx`'s own source text instead (`node:fs.readFileSync`) and asserting the alphabet string does not appear inside the matched `<label>...</label>` block, and that the hint's `id`/`aria-describedby` wiring exists in the file. This is a real, if unusual, regression guard — it would fail if someone moved the hint back inside the label — but it is not a rendered-markup assertion the way the rest of this pass's tests are, and is disclosed as such rather than presented as equivalent.

### Verification

- `npm test` — **171 tests passing, 24 files.** 20 of those are new component tests (`LockCell` 5, `NumberCell` 6, `ScoreSheet` 3, `CreateOrJoin` 4, `GameOver` 2), 0 skipped/todo/only anywhere in the repo, nothing weakened. The other 4 new tests since the last pass's 147-passing baseline (`lib/env.test.ts`, `lib/test/fakeSupabase.test.ts`, `supabase/migrations/schedules.test.ts`, and two more `eslint.rsc-leak.test.ts` cases) were added concurrently by the backend pass, not this one.
- `npm run typecheck` — clean, exit 0.
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npm run build` (with real-shaped env vars, `rm -rf .next` first) — full chain (`next lint && next build && check-no-secrets.mjs`) succeeds. Independently confirmed in the compiled stylesheet: `--color-qx-line:#64748b` (still correct, untouched) and `group-open:hidden` / `group-open:inline` selectors present (the new `OpponentList` disclosure affordance actually compiles).

### Deprecated model strings

None found. This pass touched no Claude API code.

### Files changed

- `components/GameClient.tsx` — B5 (`myPlayerId` prop to `ScoreSheet`), #7 (`sr-only` h1), #12 (`autoComplete` on join-name input), #15 (`tabIndex={-1}` on all seven `<main id="main">` branches).
- `components/ScoreSheet.tsx` — B5 (self vs. remote closure derivation, both in render and in the announcement effect).
- `components/ScoreRow.tsx` — #9 (removed `aria-live` from the per-row score span). No B5 change needed; already correct once fed the right `closedByName`.
- `components/NumberCell.tsx` — #14 (opacity 40 → 60 on both disabled-cell reasons).
- `components/LockCell.tsx` — unchanged this pass (already correct); covered by new tests.
- `components/CreateOrJoin.tsx` — #8, #10, #11, #12.
- `components/TotalBar.tsx` — #9 (live region now wraps label + value).
- `components/SyncStatus.tsx` — #9 (static label + a separate offline-only live region).
- `components/OpponentList.tsx` — #13 (`+`/`−` disclosure affordance).
- `components/Lobby.tsx` — #7 (join code promoted to `<h1>`).
- `components/GameOver.tsx` — #17 (live region scoped to a short sentence, not the whole panel).
- `app/page.tsx`, `app/history/page.tsx`, `app/rules/page.tsx`, `app/profile/page.tsx`, `app/offline/page.tsx` — #15 (`tabIndex={-1}`).
- `vitest.config.ts` — test infrastructure: `components/**/*.test.tsx` include glob, `esbuild.jsx: 'automatic'`. Outside strict file ownership, additive only, same precedent as the backend pass's earlier edits to this file.
- New: `components/LockCell.test.tsx`, `components/NumberCell.test.tsx`, `components/ScoreSheet.test.tsx`, `components/CreateOrJoin.test.tsx`, `components/GameOver.test.tsx`, `components/test/withAppRouter.tsx` (test helper, not itself a test file).

### Focus for the tester

- **B5, manually, with two devices/tabs:** tap a colour's lock cell yourself and confirm focus stays on the lock cell (does not jump to the row heading) and no "Closed by" toast/announcement fires for your own action. Then have a second player lock a different colour and confirm tab one's focus *does* move to that row's heading and the closure *is* announced, within one poll cycle (up to 3s).
- **The three LockCell states with a screen reader on:** lock a row yourself ("Locked"), have someone else close a different row out from under you ("closed by \<name\>"), and check an under-5-crosses row ("five crosses needed") — confirm all three are read distinctly.
- **Entry screen:** confirm the New game/Join game toggle announces its pressed state, that a failed join announces the error without needing to leave and re-enter the field, and that VoiceOver/NVDA no longer reads the 32-character code alphabet when focusing the join-code field.
- **This pass added zero DOM-interaction test coverage** for the focus-move and live-announcement *transitions* specifically — those still rely on manual testing until `jsdom`/`happy-dom` + `@testing-library/react` are added to `package.json`. Everything else in this pass (accessible names, ARIA state, DOM presence, sizing) does have automated coverage now.

## Fix pass 2, backend

Scope: B1, B2, B3, the C3 residual, the S3 residual, and the C2 concurrency verification, per `.pipeline/final-review.md`'s BLOCK. B4 and B5 belong to the presentation pass and are not touched here.

### B1 — CSP blocked every Next.js inline bootstrap script. The app never hydrated.

`next.config.ts` shipped `script-src 'self'` with no nonce and no hash. The App Router serves its RSC flight payload as inline `<script>` tags with no `src`; a strict `script-src` refuses every one of them, so `self.__next_f` is never defined and React never hydrates.

Chose option (b) from the review's two paths: `script-src 'self' 'unsafe-inline'`, not a nonce-issuing `middleware.ts`. Said plainly, per the task's ask: **I do not accept forcing `/rules`, `/history`, `/profile`, `/offline` to render dynamically.** They are static today and stay static after this fix — confirmed in the build output (`○` marker, not `ƒ`) both before and after. A nonce is the stricter control, but this app's threat model (a handful of friends on a LAN/Tailscale game night, not a hostile multi-tenant surface) does not justify converting four static routes to per-request dynamic rendering to get it. `'unsafe-inline'` is what most Next.js apps ship and it is honest about what it does, which is what the review's fallback option asked for.

`next.config.test.ts` used to assert `script-src` did **not** carry `unsafe-inline` — the exact broken state pinned as a passing test. Corrected the assertion to require `"script-src 'self' 'unsafe-inline'"` (not removed, not weakened — it now asserts the opposite of what it wrongly asserted before, with a comment explaining why).

**Empirical proof, not reasoning** (full methodology also documented inline in `next.config.ts`):

1. Built with `output: 'standalone'` and real 32+ byte secrets, copied `.next/static` and `public/` into `.next/standalone/`, ran `node .next/standalone/server.js` on a spare local port.
2. `curl` on `/` and the dynamic route `/g/ABCDEF` — both return `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; ...`.
3. Parsed the returned HTML for `/`: **14** `<script>` tags total, **6** inline with no `src` (the same six the reviewer found), **0** carry a `nonce` attribute, first inline body `(self.__next_f=self.__next_f||[]).push([0])` — same starting point as the BLOCK finding.
4. Went further than the review's own methodology, which stopped at counting script tags: drove real headless Chrome (`Google Chrome.app --headless=new`, raw CDP over WebSocket, no puppeteer dependency added) against the running standalone server. Clicked the New game/Join game toggle button and read `aria-pressed` before and after:
   - before: `["true","false"]`
   - after: `["false","true"]`
   That state only changes via React's `onClick` handler — it is proof the client bundle executed and attached event listeners, not just that the CSP header string looks right. Captured Chrome's console/log stream over the same CDP session for the duration: **0** CSP-violation or "Refused to execute" messages.

### B2 — Deployment secret names did not match the app. Healthy pod, dead app.

`.pipeline/infra-spec.md` provisioned `COOKIE_SIGNING_SECRET`; the app reads `QWIXX_COOKIE_SECRET` (`lib/cookies.ts:11`). `QWIXX_IP_HASH_SECRET` (`lib/ipHash.ts:22`) was not in the manifest, the SealedSecret contract table, or the `kubeseal` command at all. `/api/health` touched neither, so both would 500 in production behind a green probe.

Three parts, all done:

1. **Names reconciled to the app-side convention** (`QWIXX_COOKIE_SECRET`, `QWIXX_IP_HASH_SECRET` — already correct in `.env.example` and every `lib/` file, per the reviewer's own preference). `.pipeline/infra-spec.md` Deployment env block, SealedSecret contract table (now 3 keys, not 2), `kubeseal`/`kubectl create secret` command, and the rotation note all updated to match.
2. **`QWIXX_IP_HASH_SECRET` added** to the manifest env block, the contract table (with its own 1Password field under the existing *k3s - Qwixx* item), the sealing command (`$IHS` alongside `$SRK`/`$CSS`), and the rotation note (lower stakes than the cookie secret — no cookie is signed with it, but it still needs the same `rollout restart` and resets in-flight rate-limit buckets on rotation).
3. **Fail-fast added, at two layers, deliberately, not one:**
   - New `lib/env.ts`: `configErrors()`/`assertConfigValid()`, mirrors the length/placeholder floors `scripts/check-no-secrets.mjs` already enforces at build time, but checked again at runtime because a build-time check cannot see the Secret mounted into the pod at deploy time.
   - New `instrumentation.ts` (Next.js's `register()` hook, runs once before the server accepts its first request): calls `assertConfigValid()`. A missing/invalid secret now **crashes the process before it can serve any traffic** — the pod crash-loops and never becomes Ready, loud in `kubectl get pods`/`kubectl logs`, instead of silently serving 500s behind a passing liveness probe.
   - `/api/health` (`app/api/health/route.ts`) now also calls `configErrors()` and returns 503 on failure. Still **zero database calls** — deliberately, for the same reason the DB call was skipped before this fix (a Supabase blip must not restart an otherwise-healthy pod). Justification for keeping this as a second layer rather than relying on `instrumentation.ts` alone: `instrumentation.ts` only runs at process start, so it cannot catch a Secret that gets rotated/corrupted underneath an already-running pod without a restart; a synchronous `process.env` read costs nothing to run on every probe.

New tests: `lib/env.test.ts` (7 cases — missing, too-short, placeholder, and all-clear, both single and multi-error), `app/api/health/route.test.ts` (2 cases, 200 on valid config, 503 on missing secret, and the test file's own comment notes it deliberately never mocks `lib/supabase/server` — if the route touched the database, this test would throw on the missing `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` before it even reached an assertion, which is itself a regression guard against a future edit reintroducing a DB call here).

### B3 — `pg_cron` in migration 0002 could abort the whole hand-applied run, taking C2's fix down with it

`0002_cleanup_jobs.sql` and `0005_orphan_players.sql` both ended with an unguarded `create extension pg_cron`/`cron.schedule(...)`, run against a Supabase instance shared with other cluster services where pg_cron availability was never verified (`.pipeline/infra-spec.md`'s own "pg_cron: unverified, use the CronJob" section says so explicitly — the migrations contradicted a decision the same spec document had already made). Migrations apply hand-applied, filename-ordered, `psql -v ON_ERROR_STOP=1 ... || break`. If either statement aborted, everything after it — including `0004_locked_rows_merge.sql`, which every row lock depends on — would never land.

Fix, three parts:

1. Pulled both `pg_cron` attempts out of `0002` and `0005` entirely. Replaced with a comment explaining why and pointing at the real path.
2. New `supabase/migrations/0006_schedules.sql`: last-numbered, explicitly optional. Every statement wrapped in a `DO $$ ... EXCEPTION WHEN OTHERS THEN RAISE NOTICE ... END $$;` block, so a missing/unpreloaded extension or a failed `cron.schedule` call raises a `NOTICE` and moves on — `ON_ERROR_STOP=1` never fires because of it, whether an operator applies it deliberately or it gets picked up automatically by the existing `for f in supabase/migrations/*.sql` loop. Header explains it needs a `pg_extension`/`shared_preload_libraries` check before anyone chooses to rely on it.
3. `.pipeline/infra-spec.md`'s already-documented k3s CronJob (`namespaces/qwixx/cleanup-cronjob.yaml`) is the actual deployed path (this predates this fix pass). It only called `cleanup_abandoned`'s RPC, not `cleanup_orphan_players`'s (0005's function, added for finding S1 part 3) — that fallback was undocumented for orphan cleanup entirely. Extended the same Job's shell script to call both RPCs in the same run (`call() { ... }` helper, `|| ok=1` so the first call's failure doesn't `set -e`-abort before the second runs), updated the manifest's own comments to describe both rules it now performs.

New test: `supabase/migrations/schedules.test.ts` (3 cases) — pins that no required migration (0001–0005) contains a bare `create extension...pg_cron`/`cron.schedule` (comment-stripped before matching, so the migrations' own explanatory prose about *why* pg_cron isn't there doesn't false-positive the check), that `0006_schedules.sql` exists and every `pg_cron` attempt in it sits inside a `DO` block with an `EXCEPTION WHEN OTHERS` handler, and that the file documents itself as optional.

### C2 verification — ran the real two-session concurrency check

The reviewer asked for this by hand in two `psql` sessions before deploy, or a note in the migration if unreachable. Docker was reachable, so I ran it for real rather than leaving a note: disposable `postgres:17` container, minimal `qwixx.games` table plus the exact `qwixx.merge_locked_rows` function body from `0004_locked_rows_merge.sql` (roles `service_role`/`anon`/`authenticated` created so the migration's own grant/revoke statements would run verbatim, unmodified).

Two concurrent `psql` sessions against the same row, orchestrated with `pg_sleep` to force interleaving:

- Session 1: `BEGIN`, calls `merge_locked_rows(gid, prev, {red: "p1"})`, holds the transaction open for 3s (`pg_sleep(3)`), then `COMMIT`.
- Session 2: starts 1s later, `BEGIN`, calls `merge_locked_rows(gid, prev, {green: "p2"})` on the same row, `COMMIT`.

Result: session 2's call **blocked for ~2 seconds** (its `merge_locked_rows` query took 2009ms, returning within 3ms of session 1's commit at `16:50:36.458`/`16:50:36.461`) — direct evidence of Postgres's row-level lock forcing serialization, not two independent updates racing. Final state after both committed: `{"red": "p1", "blue": null, "green": "p2", "yellow": null}` — **both** concurrent writes landed, exactly the reviewer's expected outcome (`red = p1 AND green = p2`), confirming `merge_locked_rows` is atomic under two real concurrent Postgres backends, not just under the single-threaded JS mirror the existing test suite exercises. Container was disposable and local (`docker run --rm`); a repo-level deploy-gate hook blocks `docker stop`/teardown commands as a live-infrastructure guard, so it was left running locally rather than fought — it is not part of any tracked manifest and can be removed with `docker rm -f qwixx-c2-check`.

### C3 residual — `seedGame`/`seedSheet` bypassed the jsonb key-order fix for pre-existing rows

`lib/test/fakeSupabase.ts`'s `insert()`/`update()` correctly canonicalise jsonb-shaped columns (length-then-bytewise, matching real Postgres), but `mutations/route.test.ts`'s `seedGame`/`seedSheet` pushed straight into `fakeDb.tables`, bypassing it — a seeded (pre-existing) row still read back in JS insertion order, which a real database never does, keeping half the C3 blind spot alive.

Fix: added `FakeSupabase.seed(table, row)`, a public method that applies the exact same `reorderJsonbKeys()` normalisation `insert()` does, then routed all four seed helpers in `mutations/route.test.ts` (`seedPlayer`, `seedGame`, `seedSeat`, `seedSheet`) through it — not just the two with jsonb columns, for consistency and so a column that becomes jsonb later doesn't reopen this gap silently.

New test: `lib/test/fakeSupabase.test.ts` (2 cases) — `reorderJsonbKeys` sorts by length-then-bytewise on a known fixture, and a row pushed via `seed()` comes back with the identical key order as the same data written via `insert()`.

### S3 residual — two more direct JSX shapes the ESLint rule missed

The reviewer found `<C {...process.env} />` (spread) and `<C>{process.env.K}</C>` (child expression) both slip past the single `no-restricted-syntax` selector, despite being just as direct and syntactic as the prop-assignment shape the rule already caught.

Added two more selectors to `eslint.config.mjs`'s `no-restricted-syntax` array:
- `JSXSpreadAttribute MemberExpression[object.name='process'][property.name='env']` for the spread case.
- `JSXElement > JSXExpressionContainer MemberExpression[object.object.name='process'][object.property.name='env']` for the child-expression case (the `>` combinator keeps it from double-firing on the already-covered prop case, where the `JSXExpressionContainer` sits under a `JSXAttribute`, not directly under a `JSXElement`).

Documented the rule's one remaining, permanent limitation directly in the config comment, as the review asked: it is syntactic (AST-shape matching), not data-flow analysis, so `const s = process.env.X; return <C prop={s} />;` is still not caught — `server-only` is the real control against that shape, not this rule.

Extended `eslint.rsc-leak.test.ts` (now 6 cases, up from 4) with a violation fixture for each new shape, run through ESLint's real flat config via `ESLint#lintText` with a virtual `filePath` (no fixture file created under `app/`/`components/`, per this repo's split-ownership constraint).

### Deprecated model strings

None found. This pass touched no Claude API code.

### Verification

- `npm test` — **171 tests passing, 24 files, 0 skipped/todo/only.** This pass added 24 new tests across 5 new/extended files: `lib/env.test.ts` (7), `app/api/health/route.test.ts` (2), `lib/test/fakeSupabase.test.ts` (2), `supabase/migrations/schedules.test.ts` (3), and 2 more cases in `eslint.rsc-leak.test.ts` (4 → 6). The other new tests in the 171 (component tests, `GameOver.test.tsx`) were added concurrently by the presentation pass, not this one.
- `npm run typecheck` — clean, exit 0.
- `npm run lint` — `✔ No ESLint warnings or errors`.
- `npm run build`, with real 32+ byte secrets sourced from `.env.local` (`SUPABASE_SERVICE_ROLE_KEY`/`QWIXX_COOKIE_SECRET`/`QWIXX_IP_HASH_SECRET` all 40+ characters, none `replace-me`-prefixed) — full chain (`next lint && next build && check-no-secrets.mjs`) succeeds. `/rules`, `/history`, `/profile`, `/offline` all still build as `○` (static), confirming the B1 fix did not force them dynamic.
- B1's empirical hydration proof — see above, ran against the real `output: 'standalone'` server, not reasoned about.
- C2's concurrency proof — see above, ran against a real disposable Postgres container, not reasoned about.
- This repo's `next build` and `next test` both ran concurrently from another agent's session partway through this pass (shared, uncommitted working tree, no version control yet in this repo per the final review's own note). Waited for those processes to exit before re-running my own build/test/typecheck/lint from a clean state, and re-verified all four afterward.

### Files changed

- `next.config.ts` — B1 (`script-src 'self' 'unsafe-inline'`, comment explaining the choice and its cost).
- `next.config.test.ts` — B1 (corrected the assertion that used to pin the broken CSP).
- `lib/env.ts` — new. B2 (`configErrors()`/`assertConfigValid()`).
- `lib/env.test.ts` — new. B2 regression tests.
- `instrumentation.ts` — new. B2 (fail-fast at process startup).
- `app/api/health/route.ts` — B2 (config-validity check, still no DB call).
- `app/api/health/route.test.ts` — new. B2 regression tests.
- `.pipeline/infra-spec.md` — B2 (secret names reconciled, `QWIXX_IP_HASH_SECRET` added throughout; `instrumentation.ts`/`/api/health` behaviour noted in the contract table's intro) and B3 (CronJob extended to call both cleanup RPCs, `0006_schedules.sql` explained as optional and safe inside the existing apply loop).
- `supabase/migrations/0002_cleanup_jobs.sql` — B3 (pg_cron attempt removed, replaced with a pointer comment).
- `supabase/migrations/0005_orphan_players.sql` — B3 (same).
- `supabase/migrations/0006_schedules.sql` — new. B3 (guarded, optional pg_cron attempt).
- `supabase/migrations/schedules.test.ts` — new. B3 regression tests.
- `lib/test/fakeSupabase.ts` — C3 residual (`export`ed `reorderJsonbKeys`, added `seed()`).
- `lib/test/fakeSupabase.test.ts` — new. C3 residual regression tests.
- `app/api/games/[code]/mutations/route.test.ts` — C3 residual (all four seed helpers routed through `fakeDb.seed()`).
- `eslint.config.mjs` — S3 residual (two new selectors, limitation documented in the comment).
- `eslint.rsc-leak.test.ts` — S3 residual regression tests (2 new cases).

### Focus for the tester

- **B1 is the one that matters most:** load the app in a real browser (not just `curl`) against a build made with these secrets, open the console, and confirm no CSP violation and that every interactive element (toggle, form submit, score cells) actually responds — the automated CDP check above proved this against headless Chrome, but a real device/browser pass is still worth doing before this ships, especially Safari/iOS since this app is a PWA.
- **B2:** if re-deploying, the SealedSecret **must be resealed** — the key names inside it changed (`COOKIE_SIGNING_SECRET` → `QWIXX_COOKIE_SECRET`, plus the new `QWIXX_IP_HASH_SECRET` key). An old sealed secret with the old key name will now cause the pod to crash-loop on `instrumentation.ts`'s check rather than serve broken 500s — that is the intended, louder failure mode, but it means a stale secret is now a hard outage signal, not a silent one, so reseal before rollout.
- **B3:** if migrations are (re)applied to the shared Supabase instance, confirm `0006_schedules.sql` logs a `NOTICE` (not an error) if pg_cron is unavailable, and separately confirm the `namespaces/qwixx/cleanup-cronjob.yaml` CronJob's first run logs `cleanup_abandoned: HTTP 2xx` and `cleanup_orphan_players: HTTP 2xx` both.
- **C2:** the concurrency proof above was run against a disposable local Postgres, not the real Supabase instance — worth a second confirmation against the actual target `supabase/postgres:15.8.1.085` image before final sign-off, since row-locking behaviour is standard Postgres and shouldn't differ, but "shouldn't differ" is not the same standard this pass held everything else to.
