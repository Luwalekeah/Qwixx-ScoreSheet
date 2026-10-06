# Final review gate: qwixx-scoresheet

Stage 4. Read intent.md, .pipeline/spec.md, .pipeline/changes.md, the three BLOCK reviews, and the code.
Independently verified the built artifact and the running standalone server.

## VERDICT: BLOCK

Three of the sixteen fixes are genuinely good work. One of them broke the application.

The backend fix pass is strong. C1, C4, C5, C6, S1, S2, S4, S5, S6, S7 close their root causes, not their symptoms, and the regression tests behind C1 and C4 are real tests, not shape assertions. C2's deviation from the security review's suggested SQL was the correct call. The operator's own L1 fix is correct.

What blocks is not in that list. The S8 security-headers fix ships a Content-Security-Policy that stops the app from running at all, the deployment secrets do not match the manifest that will consume them, and the accessibility BLOCK was never cleared — only six of eighteen findings were assigned to the fix pass, and the six that were fixed introduced a new regression that no test covers.

---

## 1. Must fix before sign-off

### B1. CRITICAL. The CSP blocks every Next.js bootstrap script. The app never hydrates.

`next.config.ts:22` sets `script-src 'self'` with no nonce and no hash. Next.js App Router serves its RSC flight payload as inline `<script>` tags. There is no `middleware.ts` in this repo, so nothing mints a nonce.

Verified at runtime, not inferred. I built the standalone server, started it on port 3987 with the real env, and requested `/`:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ...
inline script tags (no src): 6
any nonce attr: False
first inline body: (self.__next_f=self.__next_f||[]).push([0])
```

Every one of those six is refused by any browser under that policy. `self.__next_f` is never defined, the client chunks load and find no flight data, React never hydrates. Result: the score sheet renders as static HTML and no tap does anything. Local-first sync, undo, polling, the entire product, all dead. This is worse than the vulnerability S8 was closing.

`next.config.test.ts` actively pins the broken state: it asserts CSP does **not** carry `unsafe-inline` on `script-src`. The test is green and the requirement behind it is wrong. This is the clearest case in this review of green tests being aimed away from the risk — three tests assert the header's *text* and none assert the app still runs under it.

Fix, in order of preference:
1. Add `middleware.ts` that generates a per-request nonce, sets it on the CSP header, and let Next propagate it to its own scripts (`headers.set('x-nonce', ...)` pattern from the Next CSP docs). Drop the static `Content-Security-Policy` entry from `next.config.ts` for the same paths, since a static header cannot carry a nonce.
2. If a nonce is too much for v1, use `script-src 'self' 'unsafe-inline'` and say so in a comment. That is weaker than the review asked for but it is honest and the app works. The threat model here is five friends on a LAN game, not a hostile multi-tenant surface.

Then change `next.config.test.ts` to assert whichever choice is made, and add one test that fetches `/` from the built server and asserts the inline scripts carry a nonce that matches the header.

### B2. CRITICAL. Deployment secret names do not match. The pod will start healthy and fail every write.

`.pipeline/infra-spec.md` Deployment env block sets:

- `COOKIE_SIGNING_SECRET` — the app reads `QWIXX_COOKIE_SECRET` (`lib/cookies.ts:11`)
- no `QWIXX_IP_HASH_SECRET` at all — the app reads it at `lib/ipHash.ts:22`, and it is absent from the SealedSecret contract table in §2, so nobody will even generate it

Both throw on a missing value. `hashIp` is called on the first line of `POST /api/games` and `POST /api/games/join`, so game creation and joining 500 immediately. `getSecret` throws on every cookie sign and verify, so nothing authenticates.

`/api/health` deliberately does not touch anything (correct per the probe contract), so liveness and readiness both stay green while the app is completely non-functional. There is no startup validation of these three env vars either — `lib/supabase/server.ts:6` validates its two at module load, `cookies.ts` and `ipHash.ts` validate theirs lazily at call time.

Fix: reconcile the names in one direction (app-side names are more specific and I would keep them), add `QWIXX_IP_HASH_SECRET` to the manifest **and** to the SealedSecret contract table, and add a fail-fast check so a pod with missing secrets refuses to become ready rather than serving 500s.

### B3. HIGH. Migration 0002 can abort the run and take the C2 fix down with it.

`supabase/migrations/0002_cleanup_jobs.sql:41-42` ends with:

```sql
create extension if not exists pg_cron;
select cron.schedule('qwixx-cleanup', '7 * * * *', $$select qwixx.cleanup_abandoned();$$);
```

`0005_orphan_players.sql` ends with a second `cron.schedule`. `pg_cron` requires `shared_preload_libraries` and only works in the one database named by `cron.database_name`. On a Supabase instance shared with other services this is not something the app repo can assume. This is adversarial finding 8, which was flagged and never assigned to either fix pass.

The consequence is not just "cleanup does not run." Migrations are hand-applied in filename order (`.pipeline/infra-spec.md:614`). If 0002 errors under `ON_ERROR_STOP`, `0003_grants.sql`, `0004_locked_rows_merge.sql` and `0005` never land. Missing 0004 means `db.rpc('merge_locked_rows', ...)` returns "function does not exist" and **every lock in the game returns 500** — a hard failure of the feature C2 was fixing, caused by an unrelated migration two files earlier.

Fix: move both `cron.schedule` calls (and the `create extension`) into a separate, last-numbered, explicitly optional migration, e.g. `0006_schedules.sql`, with a header stating it may be skipped. Verify `select * from pg_extension where extname='pg_cron'` on the target database before applying anything. Nothing that the request path depends on should sit behind an extension install.

### B4. HIGH. The accessibility BLOCK was never cleared. Four Level A failures remain on the entry screen.

`.pipeline/a11y-review.md` returned BLOCK on 18 findings. The presentation pass was handed 6 (L1, A1–A5) and correctly flagged the rest as out of scope. Nobody picked them up. `intent.md` lists "WCAG 2.2 AA passes, reviewed by luwah-a11y-reviewer" as a required outcome, so that acceptance criterion is unmet.

I verified each is still open in the current code:

| Finding | WCAG | Verified |
|---|---|---|
| #8 mode toggle signals state by colour alone | 1.4.1 (A), 4.1.2 (A) | `components/CreateOrJoin.tsx:58-75` — no `aria-pressed` anywhere in the file |
| #10 join-code input's accessible name contains the 32-char alphabet | 4.1.2 (A) | `CreateOrJoin.tsx:112-114`, span still inside the `<label>` |
| #11 error region only mounts when populated, error not associated with the input | 4.1.3 (AA), 3.3.1 (A) | `CreateOrJoin.tsx:137` still `{error && (<p role="status">...)}` |
| #12 no `autocomplete` on three display-name inputs | 1.3.5 (AA) | zero `autoComplete` in `CreateOrJoin.tsx` or `GameClient.tsx` |
| #7 no `h1` and no landmarks on the game screen or lobby | 1.3.1 (A), 2.4.6 (AA) | only `GameOver.tsx:33` has an `h1`; `GameClient.tsx:264` main has none |
| #9 four row live regions plus a per-tap sync ticker | 4.1.3 (AA), 1.3.1 (A) | `ScoreRow.tsx:74` and `SyncStatus.tsx:19` both unchanged |
| #13, #15, #17 | mixed | `OpponentList.tsx:22` still bare `list-none`; no `tabIndex={-1}` on any `<main id="main">` |

These are one-line changes each. #8, #10, #11 and #12 all sit on the first screen every player touches. This is the cheapest block on the list to clear.

### B5. HIGH. The A2/A3 fix treats your own lock as a remote closure. Focus is stolen from the cell you just tapped.

`components/GameClient.tsx:278` passes `lockedRows={localLockedRows}` — the locally replayed value, which includes **this player's own lock** the instant they tap it. `ScoreSheet.tsx:44` then derives `closedByName` from it and `ScoreRow.tsx:21` sets `closed = closedByName !== null`. Three consequences, all on the single most important move in the game:

1. `ScoreRow.tsx:33-42` — the new focus-management effect fires on the false→true transition of `closed`. Your own lock triggers it, `document.activeElement` is the lock cell you just pressed, so focus is yanked off it and dumped on the row heading. Keyboard and screen reader users lose their place as a reward for playing correctly.
2. `ScoreSheet.tsx:32` announces "Red row closed by *your own display name*" to you, for your own action. The live region was built for a remote closure.
3. `NumberCell.tsx:47` labels every remaining open cell in your own locked row "Red 5, row closed by *yourself*", and `ScoreRow.tsx:79-80` renders the same wording visibly.

`LockCell` gets this right — it branches on `state === 'locked'` before `closedByName`. The other three consumers do not.

Fix: pass the closer's identity, not a name, and let each consumer distinguish self from other. `ScoreSheet` already receives enough to do it if `GameClient` also passes the local `playerId`: derive `closedByName` only when `lockedRows[color] !== myPlayerId`, and gate the `ScoreRow` focus effect and the `ScoreSheet` announcement on the same condition.

This was introduced by the fix pass, is not covered by any test, and cannot be — see §4.

---

## 2. Finding-by-finding: did the fixes close the root cause?

### C1, undo vs in-flight flush — genuinely fixed

`lib/sync.ts:138` adds `inFlightSeqs`, populated at `:434` before the network call and cleared at `:471` in a `finally` that runs after `handleFlushError` has been awaited. `undo()` at `:307` takes the delete-locally path only when the entry is both queued and not in flight; otherwise it falls through to queueing a real `undo` mutation. Every count-based `splice(0, batch.length)` is gone, replaced by `removeQueueEntriesBySeq()` at `:338`, which is paired correctly with the `deleteQueueEntries(batchSeqs)` call at all three sites.

I chased the two failure modes the fix could have moved rather than removed, and both self-heal:
- In-flight mark is rejected 422 → the offending seq is removed, then the remaining queue (including the new `undo`) is re-validated against the authoritative sheet at `:551-595`. `canUndoCross` returns false for a mark that never landed, so the orphan undo is dropped. Correct.
- 409 version conflict → the undo survives in the queue and is flushed next, where the server rejects it into the 422 path above. Recoverable.
- `localState()` at `:172` wraps `replay` in a try/catch and falls back to the server sheet, so a transiently inconsistent queue cannot throw in render.

The root cause is gone. The three regression tests use a deferred promise to hold the flush open and assert the follow-up mutation payload and final sheet state, not just a count. Meaningful.

### C2, locked_rows CAS — the deviation is correct, the SQL is right, the test does not prove it

The fixing agent's argument is sound and I would have made the same call. The adversarial review's suggested `case when g.locked_rows->k <> 'null' then keep else caller's value` treats "currently non-null" as "someone else owns this," which is equally true of the same player unlocking their own row one tick later. It would have silently swallowed a legitimate undo-of-your-own-lock. The CAS-on-previous-value shape in `0004_locked_rows_merge.sql` does not have that failure mode.

I checked the SQL for the things that usually go wrong in this shape:
- JSON `null` vs SQL `NULL`: `g.locked_rows -> k` returns jsonb `'null'`, not SQL NULL, so `'null' = 'null'` is true and the unlocked→locked transition works. Correct.
- A key missing from `p_prev` makes the comparison NULL, so the current value is kept. Fails safe.
- `jsonb_object_keys(g.locked_rows)` iterating the current row rather than `p_next` means a key absent from the row is dropped, and `jsonb_object_agg` over zero rows returns NULL. Both only bite if `locked_rows` is `{}`. `0001_qwixx_schema.sql:17` defaults it to all four colours and marks it `not null`, so unreachable.
- Atomicity: under READ COMMITTED, a blocked UPDATE re-evaluates its target list against the updated tuple via EvalPlanQual, so `g.locked_rows` in the SET subquery is the fresh value. This is the same mechanism that makes `set x = x + 1` safe. Correct.

`app/api/games/[code]/mutations/route.ts:180-186` passes `p_prev = game.locked_rows` (the value read at `:52`) and `p_next = workingLockedRows`, then feeds the merged result forward into `checkGameEnd`. That is exactly right, and it is what stops the two-locks end condition from going dead.

**Caveat that must be discharged before deploy.** The regression test at `mutations/route.test.ts:440` proves the *route* uses the merged result. It does not prove the SQL. `fakeDb.rpcHandlers.merge_locked_rows` at `:123` is a faithful JavaScript mirror of the SQL, executed single-threaded, where interruption is impossible by construction. The one property C2 is about — atomicity under two concurrent Postgres backends — is asserted against a function that cannot be preempted. That is the best available without a live database, and the agent was right to build it, but it is not evidence. Run this by hand in two psql sessions before sign-off:

```sql
-- session 1                          -- session 2
begin;                                begin;
select qwixx.merge_locked_rows(       select qwixx.merge_locked_rows(
  '<gid>', '{"red":null,...}',          '<gid>', '{"red":null,...}',
  '{"red":"p1",...}');                  '{"green":"p2",...}');
-- (blocks until session 1 commits)
commit;                               commit;
-- expect: red = p1 AND green = p2
```

Minor: the test uses `code = 'LOCKRACE'`, eight characters, which violates the `join_code ~ '^[...]{6}$'` check constraint in `0001`. Harmless against the fake, but it means the fixture is not one a real database would accept.

### C3, sheetsEqual vs jsonb key order — fixed, and the fake is right on the write path only

`lib/sync.ts:87` now compares `penalties`, `locks[color]` and `crosses[color]` element-by-element instead of `JSON.stringify`. That is the real fix and it is order-independent by construction.

`lib/test/fakeSupabase.ts:21-37` — `jsonbKeyCompare` sorts by length then bytewise, which is what Postgres jsonb actually does. For this app's keys that yields `red, blue, green, yellow`, and the sync test builds its fixture in exactly that order. The canonicalisation is applied at `:202` (insert) and `:212` (update), so anything written through a route handler and read back comes out jsonb-ordered. The class is now catchable.

Residual, correctly disclosed in changes.md and worth restating: `seedGame`/`seedSheet` in `mutations/route.test.ts:17,40` push straight into `fakeDb.tables` and bypass `reorderJsonbKeys`, so a **pre-existing** row still comes back in JS insertion order — which a real database would never do. Today nothing server-side does an order-sensitive comparison, so this is latent. The two-line fix is to route the seed helpers through the same canonicaliser. I would take it, because the whole point of C3 was that the fake made the bug invisible, and half the read paths in the suite still have the old blind spot.

### C4, transient DB error mapped to 404 — fixed correctly, and the diagnosis was right

`mutations/route.ts:61-66` and `:78-83` split the error branch from the empty branch on both reads. The agent's reasoning that no client change was needed is correct: `handleFlushError`'s 403/404 branch at `:637` was never the bug, the 500 already fell through to the leave-the-queue-alone path at `:645`. The `errorOnce` mechanism added to the fake is a clean way to force the branch. Both server and client regression tests are meaningful.

### C5, toast never cleared — fixed

`sync.ts:220-238`. `setToast` owns the whole lifecycle, clears any prior timer, and schedules its own `setToast(null)` on the same 4s as `Toast.tsx`. `Toast.tsx`'s own timer still fires and still only kicks a flush, which is now redundant rather than load-bearing. No conflict.

One loose end: `this.toastTimer` is not cleared in the stop path, so a dangling timer outlives the component. Trivial, one line, not blocking.

### C6, rate limiter comment — correct call

Fail-closed is right and the comment now says so. The test pins it so a future "fix" that reverts to fail-open is visible. Fine.

### S1, unauthenticated row creation — fixed, and the stronger of the two options was chosen

Making `GET /api/me` read-only (`app/api/me/route.ts:30-56`) is better than rate-limiting a GET that creates state, and the agent verified there are no client callers before removing the side effect. `POST /api/games:28-41` is now rate-limited before `ensureDevice()` runs, and `0005_orphan_players.sql` reclaims what already leaked. All three parts land.

Note: `/api/me` now has zero callers anywhere in `app/` or `components/`, and `getMe()` in `lib/api.ts:56` is unreferenced outside tests. Dead endpoint. Not harmful, but decide whether it stays.

### S2, build gate fails open — fixed

`scripts/check-no-secrets.mjs:194-204` adds a `.next/static` existence check and a `MIN_FILES = 10` floor, asserted before the success message. The test spawns the real script against four scratch scenarios including a planted secret. This is the right shape of test for a guard script — it re-derives the result rather than trusting the script's own output.

I ran the independent check anyway, per my own standing rule about guard scripts: grepping all three real secret values plus `eyJ`-shaped JWTs and `service_role` across `.next/static` and `public` returns zero hits, and there is no `NEXT_PUBLIC_` anywhere in the source. **No key in client code.** Confirmed independently, not on the gate's word.

### S3, RSC flight-payload leak — the residual risk is genuinely low, but the rule has two undocumented gaps

I probed the rule with `eslint --stdin --stdin-filename` against the real flat config:

| Shape | Caught |
|---|---|
| `<C p={process.env.K} />` | yes |
| `<C p={process.env["K"]} />` | yes |
| `<C cfg={{k: process.env.K}} />` | yes |
| `lib/**` (should not fire) | correctly silent |
| `const s = process.env.K; <C p={s} />` | **no** — documented by the author |
| `<C {...process.env} />` | **no** — not documented |
| `<C>{process.env.K}</C>` | **no** — not documented |

The two undocumented misses are direct, single-line, syntactic shapes squarely inside what the rule claims to cover. `{...process.env}` leaks the entire environment in eleven characters. Both are cheap to close: add a `JSXSpreadAttribute` selector and a `JSXElement > JSXExpressionContainer` selector alongside the existing one. That is a NEEDS-WORK item, not a blocker.

On the honest question you asked — the residual for the indirect-variable case is **low, and lower than the rule's author could see from inside their own file set**. Two independent facts hold it down:

1. `grep -rn "process\.env" app components lib` returns exactly six hits. Four are in modules that all carry `import 'server-only'` (`cookies.ts`, `ipHash.ts`, `supabase/server.ts`), two are `NODE_ENV` checks in route handlers. **No Server Component reads `process.env` at all today.** The exploit shape needs someone to write new code that does.
2. `server-only` is not decoration here. Every module that touches a secret imports it, so the ordinary way this leak happens — importing a config module into a Client Component — is a hard build failure, not a lint warning.

So the layered control is: `server-only` blocks the common path, the ESLint rule blocks the direct-JSX path, and the artifact scan catches the static-route case. What remains uncovered is a Server Component that reads a secret straight from `process.env` into a local and passes it down — narrow, and it would have to be newly written. Accepting that residual is defensible. Closing the two syntactic gaps first makes it cheaper to accept.

The `vitest.config.ts` alias for `server-only` is test-only and does not appear in `next.config.ts`, so it cannot weaken the production build.

### S4, S5, S6, S7 — fixed

- **S4**: `verifyCookie` takes a required `maxAgeSeconds`, rejects missing/non-numeric/expired/forward-dated `iat`. Making the parameter required is what forces every call site to be corrected. Test covers the boundary and confirms the two cookie types use different windows.
- **S5**: 32-char floor on the three real secrets, explicit `replace-me` rejection, `.env.example` updated to match. Fine.
- **S6**: `0003_grants.sql` puts the grants in a migration. Correct control given the `qwixx` schema will be exposed through the shared PostgREST once `PGRST_DB_SCHEMAS` is changed — `revoke all on schema qwixx from anon, authenticated` is what keeps an anon-key holder out, and revoking schema `USAGE` is sufficient even without table-level revokes. The two new functions carry their own grant pair inline. `grants.test.ts` is a static text check, correctly labelled as such, and it targets exactly the gap that caused S6 (`consume_rate_limit` defined and never revoked). Landing it as a new migration rather than editing `0001` was the right call.
- **S7**: `clientIp` trusts only `CF-Connecting-IP`. See §3 for the two consequences this creates.

### S8 / S9 — S9 fixed, S8 broke the app

`output: 'standalone'` is real: `.next/standalone/server.js` exists and I ran it. Headers are emitted on live responses, verified by curl, not just by calling `headers()` in a test. See B1 for the CSP.

---

## 3. Seams between the two concurrent agents

Both agents respected their file boundaries, and typecheck being clean means no prop shape drifted. The seams are behavioural, not structural.

1. **Own-lock treated as remote closure.** The presentation agent built `closedByName` and the focus effect assuming `lockedRows` means "somebody else closed this." `GameClient` feeds it `localLockedRows`, which includes you. Neither agent could see the other's assumption. This is B5 above and it is the one seam that matters.

2. **Dead ETag path across the boundary.** The presentation agent removed `etagRef` from `GameClient` and correctly reported that it could not wire it without touching `lib/api.ts`. Nobody picked that up. Current state: `app/api/games/[code]/route.ts:79-82,143` still computes an ETag on every poll and still handles `If-None-Match`, `lib/api.ts:110` still advertises `getGame(code, etag?)`, and no caller passes it because `request()` discards the `Response` and never surfaces the header. The 304 path is unreachable. Net cost is a full game-state transfer every 3 seconds per client, and a function signature that promises something it cannot deliver. LOW, but either wire it or delete the parameter and the server-side branch.

3. **Closure announcement lags a poll cycle.** Correctly flagged by the presentation agent for the sync owner, never picked up. `applyPollResult` sets `lockedRows` without a toast, so a remote closure announces up to 3s late. Acceptable as designed, worth a decision rather than a drift.

4. **changes.md is inaccurate about the mobile height fallback.** The presentation section claims `max-[359px]:h-11` was kept "fixed exactly as before." `grep -rn "359" components/` returns nothing — it was removed. Harmless in effect (cells stay 56px tall below 360px, and 41px wide at 320px, which clears the 24px AA target floor and incidentally resolves a11y finding #16), but the written record is wrong and the next reviewer will trust it.

---

## 4. Did anything get weakened? No. But the 135 is not what it looks like.

Nothing was skipped, weakened, or rewritten to assert buggy behaviour:

- Zero `.skip`, `.only`, `.todo`, `xit`, or `xdescribe` in the entire repo.
- All four named rulebook regressions from `intent.md` are intact in `lib/scoring.test.ts` at lines 66, 171, 187, and 360–393, with the correct assertions (lock scores as an extra mark, cross must be strictly right, lock needs rightmost + five held, game-end on four penalties or two locks).
- The auth boundary tests in `mutations/route.test.ts` are unchanged.
- The new tests I sampled (C1 variants, C2, C4, cookies, check-no-secrets) are genuine behavioural tests, not shape assertions.

Two honest qualifications on what the 135 covers:

**There is not one component test in this repo.** No `@testing-library/*` in `devDependencies`, no `.test.tsx` anywhere, `vitest.config.ts` runs in `environment: 'node'`. Every one of the 135 exercises `lib/`, `app/api/`, `scripts/` or config. That means the entire presentation fix pass — L1, A1 through A7, and the B5 regression it introduced — has **zero automated coverage**, and the 86→135 delta is entirely backend. The presentation agent's own verification line says "86 tests passing, same suite as before this pass," which is accurate and is the tell: its work added no tests because there is nowhere to put them. Judge that pass on manual testing only.

**Route handler coverage is uneven.** `mutations` has 13 tests, `join` has 4, `games` has 2. `app/api/games/[code]/route.ts`, `/start`, `/end`, `/player`, `/history` and `/profile` have no test file at all. Pre-existing, not caused by this pass, but it means the poll endpoint that every client hits every 3 seconds is untested.

`next.config.test.ts` is the one test I would call actively harmful — it pins the CSP that breaks the app. See B1.

---

## 5. Is the ESLint rule actually gating? Yes.

`package.json:9` is `next lint --max-warnings=0 && next build && node scripts/check-no-secrets.mjs`. The chain is real, `&&` short-circuits, and `next lint` exits non-zero on an error-level rule. `next lint`'s default directories include `app`, `components` and `lib`, which covers the rule's `files` glob.

Confirmed empirically rather than by reading, per my standing rule on new guard mechanisms — piped a violating fixture through the repo's real flat config:

```
app/zz-probe.tsx
  1:50  error  Never pass process.env into a JSX prop...  no-restricted-syntax
✖ 1 problem (1 error, 0 warnings)
```

It fires as an error, in both target directories, and correctly stays silent in `lib/`. The gate is real. Its coverage has the two holes listed in §2 under S3.

---

## 6. Deployment readiness against .pipeline/infra-spec.md

**Clean:**
- `output: 'standalone'` produces `.next/standalone/server.js`. I ran it and served real traffic from it.
- `/api/health` returns `{"status":"ok"}` with no database call, matching the probe contract at infra-spec §2 exactly. Correct — a Supabase blip will not restart healthy pods.
- No hardcoded origin anywhere. `grep -rnE "https?://[a-zA-Z]"` across `app`, `components`, `lib` returns nothing outside tests. `APP_ORIGIN` in the manifest is unread, which is fine and means the hostname decision genuinely does not block code.
- Tailwind v4 through the `@theme` block in `app/globals.css:3`. No `tailwind.config.js` exists.
- `SUPABASE_URL` matches the cluster-DNS form. No Supabase key reaches the browser (independently verified, §S2).
- No Claude API code in the repo, so no deprecated model string to check.
- Grants are in a migration and scoped to the `qwixx` schema only, so applying them cannot affect the other services on that Postgres.

**Blocking:** B2 (secret names) and B3 (pg_cron aborting the migration run). Both above.

**Medium, needs a ruling not a code change:**

`clientIp()` returning null outside the tunnel means, in production, `POST /api/games` and `POST /api/games/join` both return `400 bad_request`. The infra spec documents NodePort 30111 as "the fire escape on LAN and Tailscale," and §3 calls out tunnel failure as a mode worth designing for. As built, that fire escape cannot create or join a game — it only works for a session already holding cookies. Either accept that (say so in the spec) or allow a trusted-CIDR fallback for RFC1918 and the Tailscale range.

The same asymmetry cuts the other way on security. Through the tunnel the fix is real, because Cloudflare overwrites `CF-Connecting-IP` at the edge and it cannot be spoofed. Hitting NodePort 30111 directly on the LAN, a client sets `CF-Connecting-IP` to whatever it likes and gets an unlimited number of rate-limit buckets. The app cannot tell the two paths apart. S7 genuinely closed the internet-facing hole; it did not remove the class, it relocated it to a path the threat model treats as trusted. LOW given the VLAN, but it is the honest description, and it becomes a real finding the day anything else lands on that VLAN.

---

## 7. Open, accepted, not blocking

Listed so they are recorded as decided rather than missed. All are from the security review's LOW set, none were assigned:

- **L7**, `scripts/check-no-secrets.mjs:73` prints the whole offending line, value included, into build logs. The one branch that fires is the branch where that value is a secret. One-line fix, and I would take it now since it lives in the script whose job is to not leak secrets.
- **L4**, `code` is not normalised in the five `[code]` routes. Not injectable, supabase-js encodes filter values, and `app/g/[code]/page.tsx` upper-cases before render. Latent.
- **L5**, `app/api/history/route.ts:43` passes an unvalidated `cursor` into `.lt('ended_at', ...)`. Produces a generic 500 on a malformed value, nothing worse.
- **L8**, `sourceDirs` is still `['app','components','lib']`, so a future `src/`, `hooks/` or `utils/` would be scanned by nothing. No such directory exists today.
- **L2**, join codes are released on game end and the seat cookie still carries `gid`. Every handler re-resolves the code independently, so both paths fail closed — by accident, not by design. Any future handler that trusts `auth.gameId` inherits a cross-game read.
- Adversarial **#9** (concurrent joins report "game full"), **#10** (descriptor matching fragility), **#11** (rightmost cell and lock cell disagree on lock legality), **#12** (`bestRow` is `{red, 0}` not null for a player who has scored nothing).
- `app/profile/page.tsx:58` uses an em dash as an empty-value placeholder. Against the Luwah copy standard. Use `—`-free text or a plain hyphen.
- The repo has no commits. `git status` reports "No commits yet," so there is no diff to audit and "nothing was weakened" had to be established indirectly. Commit before sign-off so the next review has a baseline.

---

## What clearing this looks like

B1 and B2 are the only two that can take the app to zero, and B1 does it silently — everything builds, deploys, probes green, and does nothing. B3 is a coin flip that depends on the target database. B4 is a dozen one-line changes. B5 is a handful of lines in three components.

Re-run the pipeline on B1–B5. The rest of the backend pass is good work and should not be reopened.
