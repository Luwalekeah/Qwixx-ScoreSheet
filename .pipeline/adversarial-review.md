# Adversarial review: qwixx-scoresheet

VERDICT: BLOCK

Reviewed without sight of the conversation that produced the build. 86 tests pass, typecheck is clean
(`tsconfig.json` has `strict: true`, so that claim is worth something), lint and build pass. None of that
is evidence against what follows.

## Read this first

`lib/sync.ts` `undo()` splices an entry out of `this.queue` without checking whether that entry is
already inside the batch `doFlush()` is currently sending, and `doFlush()` then removes queue entries by
**count** (`splice(0, batch.length)`) rather than by seq. Tap a number, tap Undo before the flush round
trip returns, and the mark comes back permanently with no way to remove it. That is a wrong score on a
real path with no recovery, and it is the third sync bug after the two the tester already found.

Second, `app/api/games/[code]/mutations/route.ts:156-159` writes the whole `games.locked_rows` object
read-modify-write with no CAS. Two players locking two different colours in overlapping requests lose one
lock, and the game then never ends on `two_locks`.

Third, the 409 idempotency check in `lib/sync.ts:76` compares sheets with `JSON.stringify`. `crosses` and
`locks` are **jsonb** columns, and Postgres jsonb reorders object keys. The comparison returns false on
semantically identical sheets. The tests cannot see this because every fixture is built in JS key order.

The scoring engine itself is clean. I found no arithmetic or legality defect in `lib/scoring.ts`.

---

## Correctness findings

### 1. BLOCK. Undo during an in-flight flush resurrects the mark, permanently

`lib/sync.ts:254-265` (undo removing a queued entry) and `lib/sync.ts:369-371` (`splice(0, batch.length)`).

`doFlush()` snapshots `batch`/`batchSeqs` at line 357-358 and then awaits the network. Nothing marks
those queue entries as in flight. `undo()` has no `flushInFlight` check and no UI guard
(`components/GameClient.tsx:152`, `TotalBar` is never disabled during a flush).

Failure scenario, all values concrete:

1. `serverSheet.crosses.red = []`, `lastAckedVersion = 0`, queue empty.
2. Player taps red index 3. `mark()` appends `{seq:7, mark red 3}`, appends move `#1`, calls `kickFlush()`.
   `doFlush()` sends `batch=[mark red 3]`, `batchSeqs=[7]`, `baseVersion=0`, and awaits. On a phone over
   the Cloudflare Tunnel this await is 300 ms to 2 s.
3. Player realises the mistake and taps Undo inside that window. `undo()` finds move `#1`,
   `findQueueIndexForMove` returns 0, so it deletes seq 7 from IndexedDB, splices `this.queue` to `[]`,
   and calls `markMoveUndone(#1)`. The UI correctly shows red 3 gone.
4. The server, which never saw the undo, applies the mark. Version 0 to 1.
5. `doFlush()` resumes: `this.serverSheet = res.sheet` (contains red 3), `lastAckedVersion = 1`,
   `deleteQueueEntries([7])` is a no-op, `this.queue.splice(0, 1)` on an empty array is a no-op.
6. `localState()` = replay(serverSheet with red 3, empty queue) = **red 3 is crossed again**.

The move log says `#1` is undone, so `canUndo` is false and the Undo button is disabled. There is no
sequence of taps that removes red 3. The player's score is 1 point too high for the rest of the game and
the app offers no way to say so. A poll will not fix it: `applyPollResult` sees `res.you.version === lastAckedVersion`
and does nothing.

Two more variants of the same root cause, both reachable:

- Queue `[A(7), B(8)]`, both in the batch, player undoes B. `this.queue` becomes `[A(7)]`, then
  `splice(0, 2)` on a 1-element array removes **A**. B is applied server-side and shown; A is dropped from
  the in-memory queue.
- Queue `[A(7)]` in flight, player undoes A, then taps C (seq 9). `splice(0, 1)` removes **C** from
  `this.queue` while seq 9 stays in IndexedDB. C vanishes from the sheet now and reappears after a page
  reload, because `init()` reloads it from the queue store.

Fix: give `QueueRecord` an `inFlight` flag set by `doFlush()` before the await. When `undo()` finds the
matching entry in flight, take the acked path (queue an `undo` mutation) instead of deleting it. And in
`doFlush()`, remove entries by matching `batchSeqs` against `this.queueSeqs` rather than
`splice(0, batch.length)`.

### 2. BLOCK. `games.locked_rows` lost update, and the game then never ends on two locks

`app/api/games/[code]/mutations/route.ts:51-53, 83, 156-159`.

`locked_rows` is read at line 51, mutated in memory by `applyCross`, and written back whole at line 158
with `.eq('id', game.id)` only. No `.eq('locked_rows', <previous value>)`, no RPC, no row lock. The sheet
update above it (line 124-137) does have a proper CAS on `version`. `locked_rows` does not.

Failure scenario:

1. `games.locked_rows = {red:null, yellow:null, green:null, blue:null}`. Alice has 5 red crosses, Bob has
   5 green crosses. Both tap their lock cell within the same round trip window, which is exactly when
   locks happen in a real game.
2. Request A reads `locked_rows` (all null). Request B reads `locked_rows` (all null).
3. A computes `{red:'alice', ...null}` and writes it. B computes `{green:'bob', ...null}` and writes it.
   B lands last.
4. Final `games.locked_rows = {red:null, yellow:null, green:'bob', blue:null}`.

Wrong outcomes, all silent:

- Red reopens for every player, including for Alice's opponents, after Alice legally closed it. Alice's
  `sheets.locks.red` is still `true` and she keeps the 28-point row, so the two lock concepts are now
  inconsistent in the database.
- Neither request saw two locks, so `checkGameEnd` returned `ended:false` in both. The game does not end.
- No later request can ever see two locks either, because one was erased. The `two_locks` end condition,
  which is regression bug 4 from the intent, is dead for the rest of that game.

Fix: replace lines 156-159 with an `update ... set locked_rows = ... where id = ? and locked_rows = ?`
CAS and retry once on zero rows affected, or move the read-modify-write of `locked_rows` into a
`security definer` SQL function that does `select ... for update` on the games row.

### 3. HIGH. jsonb key order breaks the 409 replay-idempotency check on the first flush of every game

`lib/sync.ts:76-78` and `lib/sync.ts:417-418`. Schema: `supabase/migrations/0001_qwixx_schema.sql:36-37`,
`crosses` and `locks` are `jsonb`.

`sheetsEqual` is `JSON.stringify(a) === JSON.stringify(b)`. Postgres jsonb does not preserve object key
order; it stores keys sorted by length then bytewise. For these keys that is `red, blue, green, yellow`.
`emptySheet()` in `lib/scoring.ts:106-112` builds `red, yellow, green, blue`.

Verified on the JS side:

```
local  : {"crosses":{"red":[0],"yellow":[],"green":[],"blue":[]},"locks":{"red":false,...}}
from db: {"crosses":{"red":[0],"blue":[],"green":[],"yellow":[]},"locks":{"red":false,...}}
sheetsEqual = false
```

`this.serverSheet` is the locally built `emptySheet()` from `init()` (line 97) until the first successful
flush. `applyPollResult` does not overwrite it, because on a fresh game `res.you.version === lastAckedVersion === 0`
and line 620 takes the "agree, do nothing" branch. So the exposure window is exactly the first flush of
every game on every device, which is precisely when a lost response is being handled.

Failure scenario: player's first tap. `postMutations` succeeds server-side (version 0 to 1) but the
response is lost on flaky wifi. The retry sends `baseVersion=0` and gets a 409. `replay()` reproduces the
sheet correctly, but the key order differs from the jsonb-sourced `authoritative`, so `matches = false`.
The client shows "Your sheet was updated from the server. Some taps were not saved." for taps that were
saved, and marks every move in the batch `undone`, killing the player's ability to undo them. Combined
with finding 5, that false alarm stays pinned to the screen for the rest of the game.

Why the tests miss it: `lib/sync.test.ts:53-61` and `:340` build the 409 body with
`applyCross(emptySheet(), ...)`, so both sides of the comparison are in JS key order.
`lib/test/fakeSupabase.ts` stores JS objects verbatim and never normalises keys.

Fix: compare structurally, not by `JSON.stringify`. Compare `penalties`, then for each colour in `COLORS`
compare `locks[c]` and the crosses arrays element by element.

### 4. HIGH. A transient Supabase read error is reported as 404, and the client answers 404 by deleting unsent work

`app/api/games/[code]/mutations/route.ts:55-57` and `:69-71` collapse `gameError`/`sheetError` (any
PostgREST or network failure) into `404 game_not_found`. `lib/sync.ts:564-571` treats 403 and 404 as
terminal: `deleteQueueEntries(this.queueSeqs)`, `this.queue = []`, toast "You are no longer in this game",
`stopFlushing()` which sets `stopped = true` permanently.

Failure scenario: the Supabase pod restarts on the single-node k3s cluster mid-game, which is the normal
cost of a rollout. One `POST /mutations` returns a PostgREST error on the `sheets` select. The route
returns 404. The client deletes its three pending marks from IndexedDB, drops them from memory, tells the
player they are no longer in the game, and never flushes again for the life of the page. The three marks
are gone from the server and from the local sheet.

Fix: return `500 server_error` when `gameError`/`sheetError` is set and reserve 404 for `!game` / `!sheetRow`.
Separately, the 403/404 handler in sync should not delete the queue; leave it in IndexedDB so a reload
recovers it.

### 5. MEDIUM. The toast is never cleared, so the first error message pins to the screen for the whole game

`lib/sync.ts:109, 193-196`. `this.toast` is assigned by `setToast` and there is no call site anywhere that
passes `null` (`grep -n toast lib/sync.ts` returns 5 lines, none clearing). Every subsequent `emit()`
carries the same string. `components/Toast.tsx:13` fires `onDismiss` after 4 s, and
`components/GameClient.tsx:264` wires `onDismiss` to `syncRef.current?.kickFlush()`, which does not touch
the toast. `onDismiss` is a fresh arrow on every render, so the effect just re-arms the timer forever.

Failure scenario: player taps the "12" cell in red with 2 crosses. Toast reads "You need five crosses in
that row before you can lock it." It stays on screen, overlaying the header, until the page is reloaded.
The same applies to the false "Some taps were not saved" from finding 3.

Fix: `setToast(null)` in `onDismiss`, or expire the toast in `getSnapshot` against a timestamp.

### 6. MEDIUM. `schedulePoll` polls a finished game forever

`components/GameClient.tsx:75-88`. `schedulePoll` is a `useCallback` over `[poll, phase]`, but the effect
at line 86 has `[]` deps and runs the render-0 instance once. Inside the timeout it calls `schedulePoll()`,
which resolves to render-0's closure, so `phase` is pinned at `{kind:'loading'}` forever, `status` is
always `null`, and the guard `status !== 'ended'` never fires. Every device keeps polling
`GET /api/games/[code]` every 3 s after the game ends, and each poll costs four round trips to Postgres.
Not a scoring bug, but the code says it stops and it does not.

### 7. MEDIUM. The rate limiter's comment says fail open; the code fails closed

`lib/ratelimit.ts:14-18`. The comment reads "Fail open on infrastructure trouble rather than locking
everyone out" and the next statement is `throw new Error(...)`. The throw reaches the join route's outer
catch and becomes a 500.

Failure scenario: `qwixx.consume_rate_limit` is not reachable, which is a live risk because the intent
already flags that `PGRST_DB_SCHEMAS` must be extended for the `qwixx` schema or PostgREST returns 406.
Every `POST /api/games/join` then returns 500 with the message "Something went wrong." Nobody can join and
the log says nothing about the rate limiter. Pick one behaviour and make the comment match it.

### 8. MEDIUM. The pg_cron fallback the spec promises does not survive a failed CREATE EXTENSION

`supabase/migrations/0002_cleanup_jobs.sql:42-43`. The spec's open question 2 says that if
`create extension pg_cron` fails, "the function still exists and the operator wires a k3s CronJob".
`create extension` and `cron.schedule` are in the same migration file after the function definition. Run
under a transaction or with `ON_ERROR_STOP`, the failure rolls back or aborts before
`qwixx.cleanup_abandoned` is committed, so the fallback the spec relies on is not there. Split the
extension and schedule into `0003_pg_cron_schedule.sql`.

### 9. LOW. Concurrent lobby joins report "This game already has five players"

`app/api/games/join/route.ts:121-141`. `nextSeat = Math.max(...takenSeats) + 1` is computed from a
non-transactional read. Two players scanning the QR code at the same time both compute seat 2. The second
insert violates `game_players_seat_uniq` with 23505, which line 138 maps to `game_full`. A two-player
lobby tells the third person the game is full. Retry the seat computation on 23505 instead.

### 10. LOW. Descriptor matching in the 409 handler is fragile and matches newest-first

`lib/sync.ts:439-447`. `describeMutation` (line 578-582) returns the descriptor of the mark an `undo`
mutation *removes*, so an undo and a mark are indistinguishable, and every penalty maps to the single
string `'penalty'`. The loop then iterates `.reverse()`, so it consumes the **newest** matching move
first, which can be a mid-flight move that was never in the batch. I traced the penalty cases and could
not produce a wrong score, only a wrong `undone` flag that self-corrects on the next Undo. Reporting it
because the mechanism is one queue shape away from being wrong and the fix is free: `QueuedMutation`
already carries a UUID `id` (`lib/idb.ts:39-45`). Add `mutationId` to `MoveRecord` and match on it exactly.

### 11. LOW. The rightmost number cell and the lock cell disagree about when a lock is legal

`components/ScoreRow.tsx:25-38` renders `NumberCell` for indices 0 through `LOCK_INDEX` inclusive, so
index 10 is an enabled button whenever the row is open, regardless of cross count. Line 64 renders
`LockCell` for the same index 10, correctly greyed with "5 needed" below five crosses. Two adjacent
controls fire the identical `onCross(10)`, one enabled and one not. Tapping the enabled one always
fails and, per finding 5, pins a permanent toast.

Separately, when another player closed the row, `LockCell` takes the disabled branch at line 33 and
announces `aria-label="Lock red, five crosses needed"` and the text "5 needed" even when the player holds
seven crosses. The reason it is disabled is that the row is closed.

### 12. LOW. `bestRow` is `{red, 0}` rather than `null` for a player who has scored nothing

`app/api/profile/route.ts:76-80`. The `!bestRow ||` seed sets red on the first iteration even when
`rows.red` is 0, and later colours only replace it on strictly greater. A profile with only zero-scoring
games reports "best row: red, 0 points" instead of the `null` the type allows.

---

## Simplicity findings

- **The whole ETag / conditional GET path is dead.** `components/GameClient.tsx:41` declares `etagRef` and
  line 47 reads it, but nothing ever assigns to it (`grep -rn etagRef` returns exactly those two lines),
  and `lib/api.ts:24-46` never reads the response `ETag` header. So `If-None-Match` is never sent, the 304
  branch at `app/api/games/[code]/route.ts:80-83` is unreachable, the `lockedRowsHash` helper and the etag
  construction at line 79 run on every request for nothing, and `getGame`'s `| undefined` return type plus
  the `res === undefined` guard at `GameClient.tsx:48` are dead. Either wire it up or delete all of it.
  Note that if you do wire it up, the etag omits `players.display_name`, so a lobby rename would 304
  forever and never reach the other devices.
- **`putSnapshot` writes the full poll response to IndexedDB every 3 seconds and nothing reads it.**
  `lib/sync.ts:614` calls it; `lib/idb.ts:141` `getSnapshot` has no non-test caller. That is a disk write
  per poll per device for no benefit.
- **Dead exports with no non-test caller:** `lib/idb.ts:129` `getMeta` and the `MetaDevice` variant,
  `lib/idb.ts:197` `clearQueueForGame`, `lib/scoring.ts:88` `indexOfNumber`. `gameId` in `SeatAuthResult`
  (`lib/auth.ts:118`) is populated by `resolveSeat` and read by nobody, which is fortunate, because it is
  taken straight from the cookie without validation.
- **`app/api/history/route.ts:49-66` runs three queries per game inside a loop over up to 100 games.** 300
  round trips for one history page. Also, both history and profile embed every game id the device has ever
  played into a PostgREST `in()` filter. Retention is "indefinitely" per the intent, so that URL grows
  without bound and will eventually hit a proxy header limit. One join or an RPC would replace both.

---

## Assumptions and design decisions

**Unverified and load bearing.**

- **Decision.** `sheetsEqual` uses `JSON.stringify` for the replay-idempotency comparison.
  **Assumption.** The server returns sheet objects with the same key order the client constructs locally.
  **Unverified.** No test exercises a jsonb-ordered payload, and `lib/test/fakeSupabase.ts` cannot produce one.
  **If wrong.** Loud but wrong: a false "some taps were not saved" alarm on saved data, plus the undo log
  is wiped for those moves. Wrong message, right score. See finding 3.

- **Decision.** Each device is the sole writer of its own sheet, so `sheets.version` is "a safety net only"
  (intent, Constraints).
  **Assumption.** One device means one `GameSync` instance and one queue.
  **Unverified.** Two tabs on the same phone share the seat cookie, the origin, and the IndexedDB queue
  store, but hold independent in-memory `queue` and `lastAckedVersion`. `init()` at `lib/sync.ts:137-139`
  loads **all** queue rows for the code, so tab B adopts tab A's pending mutations and flushes them too.
  **If wrong.** Silent. Tab B's own tap is lost: its batch (A's mutations plus B's) will not replay-match
  the authoritative sheet A already wrote, so `matches` is false and every move in it is marked undone and
  dropped. The player sees the "some taps were not saved" toast and one mark missing.

- **Decision.** `resolveSeat` returns `seat` from the signed cookie without re-reading `game_players`
  (`lib/auth.ts:80-87`), and `auth.seat !== 1` is the entire host check for start and end.
  **Assumption.** A signed `qx_seat` for code X always still describes the current game with code X.
  **Unverified.** The unique index on `join_code` is partial (`where status <> 'ended'`,
  `0001_qwixx_schema.sql:54-56`), so an ended game releases its code immediately, and
  `cleanup_abandoned` deletes stale lobbies. A seat cookie lives 7 days and its `Max-Age` is enforced only
  by the browser; the server never checks `iat`.
  **If wrong.** Silent privilege confusion: a stale seat-1 cookie for a recycled code would pass the host
  check on a game the holder does not host. The odds are 1 in 30^6 per game creation, so I am filing this
  as an assumption, not a finding. The fix is one line: verify `seatPayload.gid` against the game row
  looked up by code, and reject the fast path on mismatch.

- **Decision.** `clientIp` trusts `cf-connecting-ip` then `x-forwarded-for` with no trusted-proxy check
  (`lib/ipHash.ts:7-18`).
  **Assumption.** Every request arrives through cloudflared, which overwrites `cf-connecting-ip`.
  **Unverified.** The Next.js pod is a k3s Service on the private VLAN and is directly reachable from the
  LAN. Anyone on that VLAN can rotate the header and defeat the join rate limit entirely, and
  `POST /api/games` has no rate limit at all while calling `ensureDevice`, which inserts a `players` row
  per request.
  **If wrong.** Low consequence at this threat model, but it means the rate limit is decoration on the LAN
  path.

**Verified.**

- **Decision.** Only the first player to lock a colour closes it, and the row is then closed for everyone
  including that player (`canCross` step 2, `lib/scoring.ts:149-151`).
  **Assumption.** No two players ever legally lock the same colour.
  **Verified against the intent**, which states this in Constraints, so it is a closed decision.
  **The strongest case against it, since you asked for it:** the official rulebook does not say this. The
  white dice sum is available to every player simultaneously. If the white sum is 12 and both Alice and
  Bob hold five or more red crosses, both may legally cross red 12 and both take the lock mark and its
  points. Your model makes that impossible, and because there is no turn structure in the data model at
  all (`game_players` has `seat` but no active-player concept), "simultaneous" degrades to whichever HTTP
  request lands first. The loser gets a `row_closed` rejection and loses a 28-point row. This is exactly
  the class of thing that starts an argument at game night, and the app will be confidently wrong about
  it. **Was rejecting the alternative right?** For v1, yes. Supporting a shared lock needs a round or turn
  concept that the intent explicitly does not have, and the scenario needs two players to have five plus
  crosses in the same colour and to lock in the same roll. But it should be a known limitation in the
  rules page, not an invisible one, and it is the reason finding 2 matters more than its probability
  suggests: when two locks do collide, the current code loses one silently rather than rejecting it loudly.

- **Decision.** `winner_player_id` is a single nullable uuid; a true tie writes `null`
  (`lib/gameEnd.ts:18`).
  **Assumption.** A tie surviving all three tiebreakers is rare enough to ignore.
  **Verified.** `lib/scoring.ts:291-294` returns every rank-1 player, and `resolveWinners returns every
  player when the game is fully tied` proves it. But `app/api/profile/route.ts:51` counts a win as
  `winner_player_id === device.playerId`, so a shared win counts as a **loss** for both players in lifetime
  win rate. Quiet, small, and worth one line of thought before you ship the profile page.

- **Decision.** `canUndoCross` allows undoing the rightmost cross of any row, not the globally last action
  (`lib/scoring.ts:203-206`).
  **Assumption.** Undo is a scoresheet correction tool, not a game rewind.
  **Verified** and consistent between the client (`undo()` uses the move log, so the UI does enforce
  last-action-first) and the server (which accepts any row's rightmost). A hand-crafted POST could undo an
  older row's mark, but only on the caller's own sheet, so the blast radius is self-inflicted. Fine.

- **Decision.** `checkGameEnd` checks penalties before locks, so a batch producing both reports
  `'penalties'` (`lib/scoring.ts:243-252`).
  **Verified** against the spec and tested at `lib/scoring.test.ts:393`. Arbitrary but harmless: it only
  affects `end_reason`, never the standings.

---

## Verified clean

Checked and found sound. Do not re-spend budget here.

- **`lib/scoring.ts` in full.** I reconstructed the rules independently and checked every function against
  them, not against the spec.
  - `triangular(n) = n(n+1)/2` is right at every n from 0 to 12, and `scoreRow(c, locked) = triangular(c + (locked?1:0))`
    is right at every count. Max reachable is 11 crosses plus a lock, `triangular(12) = 78`, inside the
    guard. The lock-as-extra-mark fix (regression bug 1) is correct: `scoreRow(5,true) = 21`,
    `scoreRow(6,true) = 28`.
  - The lock legality boundary is **not** off by one. `canCross` requires `crossCount >= 5` **before**
    crossing index 10, and the test asserts both sides of the boundary (4 rejects, 5 accepts,
    `lib/scoring.test.ts:187-197`). This is the boundary the intent specifies.
  - `canCross` ordering is correct and the `not_strictly_right` check catches both re-crossing an existing
    cell and re-crossing the current rightmost, including index 10.
  - Penalties: -5 each, capped at 4, both enforced in code and by a DB check constraint.
  - `checkGameEnd`: any player at 4 penalties, or two colours locked game-wide, counted across the whole
    game rather than per player.
  - `rankPlayers` tiebreakers run total, then fewer penalties, then `bestRowCrosses` with the lock mark
    excluded, then ascending seat for determinism. Rank sharing is standard competition ranking (1,1,3), and
    ties are contiguous in the sorted array so the pairwise `isTied` check is sufficient.
  - Purity holds. Nothing mutates its arguments. `applyPenalty`/`undoPenalty` alias the input's `crosses`
    and `locks` objects by reference, which is safe because every mutating path in the module rebuilds them
    with a spread, but it is worth knowing before someone adds an in-place `push`.
- **Cookie signing.** `lib/cookies.ts` is HMAC-SHA256 over the base64url payload, length-checked before
  `timingSafeEqual`, `lastIndexOf('.')` is safe because base64url contains no dot, and a missing
  `QWIXX_COOKIE_SECRET` throws and fails closed. Putting a seat cookie in the device cookie slot verifies
  but yields the same `pid`, so there is no cross-type escalation.
- **Cross-player write isolation.** `mutations/route.ts` looks the sheet up by `auth.playerId`, never by
  anything in the request body. `app/api/games/[code]/mutations/route.test.ts:133-214` covers game A
  writing game B, P1 writing P2, a tampered signature, and no cookie. I traced all four and they hold.
- **The `sheets.version` CAS itself.** `.eq('version', baseVersion)` on the update plus the pre-read check,
  with a fresh re-read on zero rows affected. This part is correct. It is only `locked_rows` that lacks it.
- **The flush continuation and the `progressed` flag.** I attacked this specifically. I could not construct
  a deadlock, a spin, or a dropped tail. The batch-cap-50 continuation at `lib/sync.ts:351` is real and the
  comment explaining why `doFlush`'s own `kickFlush` no-ops is accurate. The 422 path always shrinks the
  queue or changes the batch, so `progressed = true` cannot loop on the same batch: even the case where
  `queueSeqs.indexOf(offendingSeq) === -1` (the entry was already removed by a mid-flight Undo) leaves the
  queue changed.
- **Queue ordering across a reconnect.** `getQueueForGame` uses `index.getAll(code)`, which IndexedDB
  returns in index-key then primary-key order, and the primary key is the autoincrement `seq`. FIFO holds.
  `lib/idb.test.ts:67` covers it.
- **Poll reconciliation guards.** `applyPollResult` correctly refuses to adopt a server-ahead version while
  the queue is non-empty, and ignores stale reads where `res.you.version < lastAckedVersion`.
- **`undoCross` and the two lock concepts.** `lib/scoring.ts:224` clears `lockedRows[color]` only when
  `lockedRows[color] === playerId`, and the mutations route passes `auth.playerId`. I grepped for every
  other place the two could be conflated: `lockedColorCount`, `checkGameEnd`, `scoreSheet`, the GET route's
  `lockedRowsHash`, and `ScoreRow`'s `closedByName` all read the correct one. The only defect is the
  missing CAS in finding 2, which is a concurrency problem, not a conflation.
- **No Supabase key reaches the browser.** `scripts/check-no-secrets.mjs` refuses to pass vacuously, blocks
  any `NEXT_PUBLIC_` variable, enforces that only `lib/supabase/server.ts` imports `@supabase/supabase-js`,
  and scans `.next/static`, prerendered HTML/RSC, and `public/sw.js` for nine needles including the URL,
  the key prefix, and both HMAC secrets. This is the strongest part of the build. `.env.local` is gitignored.
- **`public/sw.js`** never caches `/api/*` and contains no environment reference.
- **Security scanner.** `luwah-security-code-review` returned 0 HIGH, 1 MEDIUM, 1 LOW. Both are false
  alarms confirmed by reading: the `math-random-token` hit is a comment in `lib/scoring.ts` forbidding
  `Math.random`, and the `a11y-outline-removed` hit is `focus:outline-none` on a `tabIndex={-1}` heading in
  `GameOver.tsx`, which is a programmatic focus target and not keyboard reachable.
