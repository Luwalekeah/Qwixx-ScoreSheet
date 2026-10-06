# Final review gate 2: qwixx-scoresheet

Stage 4, second pass. Scope: is my own BLOCK (B1–B5) cleared at the root, and did
fix pass 2 introduce anything new. Verified independently, not from changes.md.

## VERDICT: SHIP

All five blockers are closed at the root. Fix pass 2 introduced no new defect that
reaches a user. The two criticals from pass 1 (B1, B5) were both runtime-only
failures that read fine, so I mutation-tested and ran the built artifact rather
than reading. Both hold up.

Four follow-ups below. None of them stop a deploy. One of them (the DOM test
library) should be taken before the next presentation change, not after.

---

## 1. B1 to B5, closed at the root

### B1. CLOSED. `'unsafe-inline'` is the right call for this app, and the test was corrected, not gutted.

The choice is defensible on the actual XSS surface, which I checked rather than
assumed:

- `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `document.write`:
  zero occurrences in `app`, `components`, `lib`.
- The served page loads eight scripts, all from `/_next/static/`. No third-party
  origin anywhere.
- The only user-controlled string that reaches the DOM is `displayName`, rendered
  as a JSX text child, which React escapes.

There is no sink. `'unsafe-inline'` on `script-src` opens a hole with nothing on
the other side of it, and the rest of the policy still holds: `default-src 'self'`,
`connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
Refusing to convert four static routes to per-request dynamic rendering to buy a
nonce is the correct trade for this threat model, and the reasoning is written into
`next.config.ts` where the next person will find it.

`next.config.test.ts` was corrected, not gutted. Every S8 assertion survives
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Strict-Transport-Security`, `frame-ancestors`, `default-src`, `output: 'standalone'`,
`poweredByHeader`). The one assertion that pinned the broken state is inverted, with a
comment saying why. That is the right shape.

### B2. CLOSED, but not by the mechanism the code claims. Outcome is still correct.

Names reconcile in both directions. The app reads exactly four vars
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `QWIXX_COOKIE_SECRET`,
`QWIXX_IP_HASH_SECRET`); `lib/env.ts`'s `MIN_LENGTHS` covers exactly those four;
`.pipeline/infra-spec.md` sets exactly those four in the Deployment env block, the
SealedSecret contract table, and the `kubectl create secret` command. No gap.

**The health endpoint genuinely cannot report green on a misconfigured pod.** I built
the standalone server, ran it with `QWIXX_IP_HASH_SECRET` removed and the other three
real, and probed it:

```
GET /api/health  -> HTTP 500
GET /            -> HTTP 500
process          -> STILL RUNNING
```

And with the full, valid env, `GET /api/health -> 200 {"status":"ok"}`. So the gate
does not false-positive on a good config either, which was the inverse risk.

**`instrumentation.ts` runs before traffic in the standalone build, and its throw is
fail-closed. But it does not do what its own comment says.** `.next/standalone/.next/server/instrumentation.js`
is present in the standalone output and executed at startup. `next-server.js:641`
awaits it inside `prepareImpl()`, and `instrumentation-globals.external.js` rethrows
on failure. What actually happens is that the server still prints `✓ Ready in 146ms`,
still binds the port, logs `Failed to prepare server` plus an `unhandledRejection`,
and then 500s every request forever (the register promise is cached, so it never
retries). The process does **not** exit.

The operational outcome is still correct, because `.pipeline/infra-spec.md` puts a
`startupProbe` on `/api/health` with `failureThreshold: 20`. Twenty consecutive 500s
and kubelet kills the container, so the pod does crash-loop. It just gets there via
the probe, not via a process crash.

That matters only because the comment in `instrumentation.ts` says "the pod never
becomes Ready at all -- it crash-loops ... instead of serving 500s from behind a
green liveness probe," and changes.md repeats it. It *does* serve 500s; the probe is
what saves it. An operator running this container outside k8s sees a server that
says Ready and answers 500. Follow-up F1.

### B3. CLOSED. The remaining migrations are independent and safe in any partial-failure state.

`grep` for `pg_cron`, `cron.`, `create extension`, `create role`, `alter system`,
`alter database` across `0001`–`0005` returns only comments. Every executable
`pg_cron` statement now lives in `0006_schedules.sql`, last-numbered, and both `do $$`
blocks carry `exception when others then raise notice`, so a missing extension or an
unpreloaded shared library raises a NOTICE and `ON_ERROR_STOP=1` never fires. The
second block also guards on `pg_extension` before calling `cron.schedule`, so the
handler is a backstop rather than the only control.

Nothing in `0001`–`0005` can abort on a Supabase target. `0003_grants.sql` depends on
the `anon`/`authenticated`/`service_role` roles, which are guaranteed present on
`supabase/postgres`, and every function defined in `0002`, `0004` and `0005` carries
its own `revoke ... from public, anon, authenticated` plus `grant ... to service_role`
inline, so `cleanup_orphan_players` is callable by the CronJob's service-role token.
The request path (`merge_locked_rows`, `0004`) now sits behind nothing that can fail.

### B4. CLOSED. All eighteen a11y findings are resolved or correctly closed as not-applicable.

I checked each in the code, not against changes.md. #1–#6 from pass 1 still hold.
#7 (h1 on the active game screen and the lobby, named row sections), #8
(`aria-pressed` on both toggle buttons), #9 (`aria-live` off the four row scores,
label inside the `TotalBar` region, `SyncStatus` split into a static label plus an
offline-only `role="status"`), #10 (hint moved out of the `<label>`, wired via
`aria-describedby="code-hint"`), #11 (`<p role="status" id="form-error">` rendered
unconditionally, empty when there is no error), #12 (`autoComplete="nickname"` on all
three name inputs plus the full iOS set on the code input), #13 (`+`/`−` via
`group-open:`), #14 (`opacity-60`), #15 (`tabIndex={-1}` on all twelve
`<main id="main">`), #17 (`role="status"` scoped to a short sr-only sentence, h1
keeps the focus move) are all present.

#16 is correctly closed as no-longer-applicable: the `max-[359px]` breakpoint no
longer exists. #18 (no a11y gate in CI) is genuinely still open and is follow-up F3.

One layout check worth recording, because four new `sr-only` nodes were inserted as
direct children of flex containers: the compiled stylesheet emits
`.sr-only{position:absolute}`, so none of them is a flex item and none of them
consumes a `gap`. No layout shift at any width. Mobile floor is unchanged from the
pass-1 assessment.

### B5. CLOSED, and `ScoreSheet` is the only consumer that could have had the bug.

`components/ScoreSheet.tsx:51` derives `closedByName` only when
`closerId && closerId !== myPlayerId`, and the announcement effect at `:32` gates on
the same condition. `GameClient.tsx:281` supplies `myPlayerId={state.you.playerId}`.

I traced every consumer of `lockedRows` rather than trusting the summary.
`ScoreSheet` is the **only** UI consumer: `GameClient.tsx:280` is the sole site that
passes `localLockedRows`, and `ScoreRow`, `NumberCell` and `LockCell` receive the
already-resolved `closedByName`, never the raw map. Everything else that touches
`lockedRows` is server-side (`mutations/route.ts`, `[code]/route.ts`, `end/route.ts`)
or pure logic (`lib/scoring.ts`), where the value is authoritative and self-versus-
remote is not a distinction that exists.

I also checked the one thing this fix could plausibly have broken: whether dropping
`closed` for a self-lock re-enables cells that should stay dead. It does not. After
you lock a colour, `rightmostIndex` is `LOCK_INDEX`, so every number cell in that row
is already `crossed` or `blocked` and there are no `open` cells left to re-enable.
`LockCell` still renders `state === 'locked'` from `sheet.locks[color]`, ahead of the
`closedByName` branch, so your own lock still reads "Lock red, locked". And
`lib/scoring.ts:149` rejects any cross into a locked row regardless of what the UI
allows, so the gameplay guard was never the cell's `disabled` attribute.

---

## 2. Did fix pass 2 introduce anything new?

No defect that reaches a user. I aimed specifically at the runtime-only class,
because that is what both pass-1 criticals were.

- **`instrumentation.ts`**: ran it. Fail-closed, but by a different mechanism than
  documented. F1.
- **`lib/env.ts`**: reads `process.env[name]` through a variable, not a literal member
  expression, so Next cannot inline a build-time value into it. That is the trap this
  file had to avoid and it avoids it. Verified live in both directions.
- **Health status logic**: verified both branches against the running standalone
  server, not just the unit test. 200 on valid, 500-from-prepare-failure on invalid.
  The 503 branch itself is real but is effectively unreachable in this deployment,
  because `secretKeyRef` env vars are snapshotted at process start and cannot change
  under a running pod. The comment's justification ("a Secret rotated or corrupted
  without a pod restart") does not describe how env-var secrets behave. Harmless dead
  defence, wrong rationale. F1.
- **Migration ordering**: `0006` is last-numbered and both blocks are exception-
  wrapped. I confirmed the guard test actually fires by appending a bare
  `cron.schedule` to `0002` in a scratch copy and watching it fail.
- **New `sr-only` nodes in flex containers**: checked for layout regression, none.
- **`lib/test/fakeSupabase.ts` `seed()`**: `reorderJsonbKeys` builds a new object via
  `Object.fromEntries`, so routing the four seed helpers through it cannot mutate a
  shared fixture across tests.
- **The two new ESLint selectors**: probed through the real flat config with
  `eslint --stdin`, seven shapes plus one out-of-glob path.

| Shape | Result |
|---|---|
| `<C p={process.env.K} />` | caught |
| `<C {...process.env} />` | caught (was a gap) |
| `<C>{process.env.K}</C>` | caught (was a gap) |
| `<C>{process.env["K"]}</C>` | caught |
| `<C p={{k: process.env.K}} />` | caught |
| `<C {...{...process.env}} />` | caught |
| `const s = process.env.K; <C p={s} />` | not caught, correctly documented as permanent |
| same fixture at `lib/probe.tsx` | correctly silent, no over-fire |

  Both gaps I raised are closed and the residual is the one the config comment names.

Nothing was weakened. Zero `.skip`, `.only`, `.todo`, `xit`, `xdescribe` anywhere.

---

## 3. The seam between the two agents. The gap was left open.

Confirmed: `package.json` has no `jsdom`, no `happy-dom`, no `@testing-library/*`,
no `react-test-renderer`, no `playwright`, no `puppeteer`, no `axe`, no `pa11y`.

The presentation agent reported it needed a DOM library and did not own
`package.json`. The backend agent owned `package.json` and was never asked. Nobody
took it. This is the third consecutive pass where an item handed across the boundary
went unclaimed (the dead ETag path is the other one, still open, see F4).

**How much it matters: less than it looks, but the class stays uncoverable.** There
are nine `useEffect` bodies across `components/`, and zero of them are executed by any
test. Four are the a11y behaviours this pass built or changed:

- `ScoreRow.tsx:33` — the focus move on remote closure, which is B5's headline symptom
- `ScoreSheet.tsx:26` — the closure announcement
- `SyncStatus.tsx:25` — the new offline-only announcement
- `GameOver.tsx:18` — focus on mount

The reason this is not a blocker is that B5's *input* is now covered in both
directions by tests I confirmed fail on revert, and the effect body is a single
`if (closed && !wasClosed)` branch that was unchanged by this pass and reviewed in
pass 1. The residual is that a future edit to any of those four effects ships
unverified. That is F2, and it should be taken before the next presentation change
rather than after.

---

## 4. Test quality. The 20 component tests are load-bearing. I proved it.

`renderToStaticMarkup` string assertions are exactly the shape that usually passes
trivially, so I did not take the count on trust. I copied the repo to a scratch
directory, reverted each fix one at a time, and re-ran. Every mutation was caught:

| Reverted fix | Tests failed |
|---|---|
| B5 self/remote check in `ScoreSheet` | 2 |
| #8 `aria-pressed` on the mode toggle | 1 |
| #11 error region back to conditional mount | 1 |
| #12 `autoComplete="nickname"` | 1 |
| #1 locked lock cell back to `aria-hidden` | 2 |
| #3 closed cell reusing "no longer available" | 3 |
| #6 `w-full min-w-6` back to `w-cell` | 1 |
| #17 `role="status"` back on the whole panel | 1 |

Zero survivors. These are real regression guards, not shape assertions.

**The B5 regression test earns its name.** Reverting `ScoreSheet.tsx`'s
`closerId !== myPlayerId` check fails two of its three cases by name:

```
× this player locking their own row does NOT mark the row closed
  → expected ... not to contain 'Closed by'
× open cells in a self-locked row stay interactive, not disabled as "closed"
  → expected ... not to contain 'row closed by You'
```

The third case (remote closure) correctly stays green under that mutation, because
the remote path was never the bug. That is the right discrimination.

The honest limit, which changes.md discloses rather than hides: these tests prove the
`closed` **boolean** is correct in both directions. They do not prove the focus moves,
because no effect runs. The one test in the set that reads component source text with
`readFileSync` (`CreateOrJoin`, the join-mode hint) is disclosed as unusual and is a
genuine guard, but it is not equivalent to the others and should not be counted as one.

---

## 5. Follow-ups. None block the deploy.

**F1. Correct two comments that describe mechanisms the code does not have.**
`instrumentation.ts` lines 7-10 claim the process crashes and the pod never becomes
Ready. It does not crash; it serves 500s and the `startupProbe` is what stops the
rollout. `app/api/health/route.ts` justifies its 503 branch as covering a Secret
rotated under a running pod, which cannot happen with `secretKeyRef` env vars. Both
outcomes are safe. Only the descriptions are wrong, and an operator will act on them.
Either fix the comments or add `process.exit(1)` in a `.catch()` so the code matches
the claim.

**F2. Add `jsdom` (or `happy-dom`) and `@testing-library/react` to `devDependencies`,
with an `environment: 'jsdom'` override for `components/**`.** Then write the two
tests that could not be written: focus does not move on a self-lock, focus does move
on a remote closure. This is the third pass in which the item has been reported and
not owned. Assign it to a named owner rather than restating it.

**F3. `supabase/migrations/schedules.test.ts` hardcodes its migration list.** I
verified the gap: dropping a `0007_rogue.sql` containing a bare `create extension
pg_cron` and `cron.schedule` into the directory leaves all six tests green. Read the
directory and exclude `0006` instead of listing `0001`–`0005`. Two lines. The five
files that exist today are correctly guarded, which is why this is a follow-up.

**F4. Rule on the dead ETag path instead of handing it over again.** Unchanged across
three passes: `app/api/games/[code]/route.ts:79-82,143` still computes an ETag and
handles `If-None-Match`, `lib/api.ts:110` still advertises `getGame(code, etag?)`, and
`request()` still discards the `Response` so no caller can pass one. The 304 branch is
unreachable and every client transfers full game state every 3 seconds. Either wire it
or delete the parameter and the server branch.

Also still open from my §7 last time, unchanged and still not blocking:
`app/profile/page.tsx:58` uses an em dash as an empty-value placeholder, which is
against the Luwah copy standard. And a11y #18, no accessibility gate in CI, which is
the same `package.json` owner as F2 and should go in the same change.

---

## 6. Deployment readiness

Clear on every stack check:

- No API key in client code. `NEXT_PUBLIC_` appears nowhere; the four secret-bearing
  modules all carry `import 'server-only'`; the artifact scan is green and I
  re-derived it in pass 1.
- No Claude API code in the repo, so no model string to check.
- Tailwind v4 through the `@theme` block in `app/globals.css:3`. No
  `tailwind.config.js` exists.
- Layout holds at mobile width. Cells stay at or above the 24px AA target floor at
  320px, and the four new `sr-only` nodes are out of flow.
- `output: 'standalone'` produces a server I ran and served real traffic from.

Two operator actions before rollout, both already called out in changes.md and both
correct: reseal the SealedSecret, because the key names changed and a stale one now
produces a crash-loop rather than silent 500s; and confirm `0006_schedules.sql` logs a
NOTICE rather than an error if it is applied at all.

The repo still has no commits. Commit before rollout so the next review has a
baseline, and so a regression in any of the four effects F2 covers is at least
attributable.
