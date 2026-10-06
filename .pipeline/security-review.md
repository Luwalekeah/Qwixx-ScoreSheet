# Security & Code Review

Target: `/Users/theafrooverlander/code/qwixx-scoresheet`
Reviewer: `luwah-security-code-review`
Date: 2026-09-01
Scope: all application source, `supabase/migrations/`, `scripts/check-no-secrets.mjs`, `public/sw.js`, `next.config.ts`, `package.json`. Not in scope: the Dockerfile and k8s manifests, which do not exist in this repo yet.

## 1. Summary of Vulnerabilities

Two High, seven Medium, ten Low. The authorisation model is the strong part of this codebase and it holds up: I traced every database write and found no path where one player can write another player's data, and no missing caller check on any state-changing route. The join code RNG, the HMAC construction, the constant-time compare, the input validation and the XSS and CSRF posture are all correct, and I say so explicitly in section 5 rather than inventing findings.

The two High findings are elsewhere. First, `POST /api/games` and `GET /api/me` create rows in a **shared** Supabase Postgres with no authentication and no rate limit at all, and nothing ever deletes them. Second, `scripts/check-no-secrets.mjs` — the control the whole "no credential reaches the browser" claim rests on — fails open in two proven ways. I demonstrated both empirically, including a green build that serves the service role key in plaintext to every browser.

**Not safe to ship as-is.** Fix H1 and H2 first. The current build output is genuinely clean of credentials (verified), so nothing is leaking today; the problem is that the gate would not tell you if it were.

---

## 2. High Severity Issues

### H1. Unauthenticated, unrate-limited row creation in a shared Postgres

`app/api/games/route.ts:14-85`, `app/api/me/route.ts:20-47`, `lib/auth.ts:50-69`, `supabase/migrations/0002_cleanup_jobs.sql`

`ensureDevice()` inserts a `qwixx.players` row whenever the request carries no valid `qx_device` cookie (`lib/auth.ts:56-60`). It is called from three routes. Rate limiting is applied on exactly one of them:

| Route | Method | Auth required | Rate limited | Rows created per call |
|---|---|---|---|---|
| `POST /api/games/join` | POST | no | yes, `join/route.ts:31-41` | 4 |
| `POST /api/games` | POST | **no** | **no** | **4** (`players`, `games`, `game_players`, `sheets`) |
| `GET /api/me` | **GET** | **no** | **no** | **1** (`players`) |

The exploit is a `for` loop around `curl -X POST https://<host>/api/games -H 'content-type: application/json' -d '{"displayName":"a"}'`. No cookie, no code, no session. Each request commits four rows. `GET /api/me` is worse in one respect: it is a GET, so a crawler, a link preview bot or a prefetch triggers it, and it needs no body at all.

Nothing reclaims the damage. `qwixx.cleanup_abandoned()` deletes `games` in `lobby` older than 24h and prunes `rate_limits`, but it **never deletes orphaned `qwixx.players` rows** — I grepped the migration and there is no `players` statement in it. `games` deleted at 24h cascade to `game_players` and `sheets`, but the `players` rows they created survive forever.

The blast radius is what makes this High rather than Medium. Per `intent.md:44`, `qwixx` is a new schema inside the **existing** Supabase Postgres on `luwah-k3s` that holds other data. Filling that volume is not a Qwixx outage, it is a Supabase outage for every other service on the instance, and it is reachable by an unauthenticated stranger through the public Cloudflare Tunnel.

**Fix:** apply the existing `consume()` IP limiter to `POST /api/games` and `GET /api/me` before `ensureDevice()` runs, and add an orphan-player sweep to `cleanup_abandoned()`. Code in section 4.

---

### H2. The build gate fails open. Two proven bypasses.

`scripts/check-no-secrets.mjs:129-176`

The script's own header comment (lines 1-4) promises it "exits 1 if it cannot actually verify anything (a check that silently skips is worse than no check)". It does not honour that. Both bypasses below were reproduced, not reasoned about.

#### Bypass A — the gate passes with no build output at all

`walk()` returns silently on a missing directory (line 38: `if (!existsSync(dir)) return;`). `filesChecked` is incremented but **never asserted to be non-zero** before the success message on line 175. The "refuse to pass vacuously" guard on lines 24-29 checks environment variables only, never that a bundle exists.

Reproduced by copying `app/ components/ lib/ public/ scripts/` to a scratch directory with no `.next/`, setting four dummy env vars, and running the script:

```
No Supabase credential found in the client bundle. Checked 1 files.
EXIT=0
```

One file. That was `public/sw.js`. The client bundle was never examined and the build was declared clean. Any CI ordering change, cwd change, multi-stage Docker layer that drops `.next`, or a run of `node scripts/check-no-secrets.mjs` outside the `npm run build` chain produces a green gate that proves nothing.

#### Bypass B — the scan cannot see anything a Server Component streams at runtime

This is the answer to "what could ship a secret to the client that this scan would not catch."

The scan covers two targets (lines 129-132): every file under `.next/static`, and only `*.html` / `*.rsc` under `.next/server/app`. That set is closed at build time. A secret read from `process.env` inside a Server Component and passed as a prop to a Client Component is serialised into the **RSC flight payload generated per request**, which never touches disk on a dynamically rendered route.

`app/g/[code]/page.tsx` is exactly such a route. It is an async Server Component with a dynamic segment and no `generateStaticParams`, so Next marks it `ƒ (Dynamic) server-rendered on demand`. I confirmed the current build emits **zero** `.html` or `.rsc` files for it:

```
$ find .next/server/app -type f \( -name '*.html' -o -name '*.rsc' \)
12 files: index, rules, profile, history, offline, _not-found
$ find .next/server/app -path '*g*' \( -name '*.html' -o -name '*.rsc' \)
(nothing)
```

The only page in the application that renders game state has no coverage from target 2, and never will.

**Proof of exploit.** In a scratch copy I changed `app/g/[code]/page.tsx` to a five-line diff, passing `process.env.SUPABASE_SERVICE_ROLE_KEY` as a prop into `GameClient` (which is `'use client'`). No `NEXT_PUBLIC_` variable, no `@supabase/supabase-js` import outside `lib/supabase/server.ts` — both existing static guards (lines 51-107) are untouched and pass. Then:

```
$ npx next build && node scripts/check-no-secrets.mjs
...
├ ƒ /g/[code]     44.9 kB     150 kB
No Supabase credential found in the client bundle. Checked 47 files.
GATE EXIT=0

$ grep -rl "SUPERSECRETSERVICEROLEKEYVALUE123456" .next
(nothing — it is read at runtime, so it is not in any build artifact)
```

Green build. Then start the server and fetch the page as a browser would:

```
$ curl -s http://127.0.0.1:3999/g/ABCDEF | grep -o '.\{0,80\}SUPERSECRET.\{0,40\}'
f.__next_f.push([1,"5:[\"$\",\"$L10\",null,{\"code\":\"ABCDEF\",
  \"data-leak\":\"SUPERSECRETSERVICEROLEKEYVALUE123456\"}]
```

The service role key, in cleartext, in the HTML delivered to every visitor, with the build gate reporting success. Scratch copy and test server were destroyed after the run; **no application source was modified**.

Two secondary weaknesses in the same file, both contributing:

- **Lines 147-153 are a literal substring search for the build-time env values.** If CI builds the image with placeholder secrets — which it must, unless production secrets are handed to `docker build` — then `needles[0..4]` are placeholders and prove nothing about the real key. Only the four static literals on lines 117-120 retain any value. Note the tension: `.pipeline/infra-spec.md:246` injects `SUPABASE_SERVICE_ROLE_KEY` from a k8s Secret **at runtime**, so the production value is by design not present at build time.
- **Line 144's `catch { return; // binary file }` is dead code.** `readFileSync(path, 'utf8')` does not throw on binary input; it returns a string with U+FFFD replacement characters. The stated premise is wrong. Harmless here, but it means the author's model of the scan's coverage is inaccurate.

**Fix:** assert a floor on `filesChecked`, and close the RSC hole with a lint-level rule rather than a grep, because a post-hoc scan of build artifacts structurally cannot see a runtime-serialised payload. Both in section 4.

---

## 3. Medium to Low Severity Issues

### Medium

**M1. No server-side cookie expiry. A captured cookie is valid forever.**
`lib/cookies.ts:32-52`, `lib/auth.ts:26-42`

`iat` is written into both payloads (`lib/auth.ts:66`, `:111`, and four sites in the route handlers) and **never read anywhere**. I grepped: every occurrence outside tests is a write. `verifyCookie()` checks the HMAC and returns the parsed payload with no temporal validation. `Max-Age` on lines 75 and 80 is a browser-side hint only — an attacker replaying a captured value simply sets the header directly. The stated 7-day seat window and 2-year device window are not enforced by anything. Fix: validate `iat` against the matching max-age inside `verifyCookie`.

**M2. `verifyCookie` returns an unvalidated payload, and the gate accepts an 8-character HMAC key.**
`lib/cookies.ts:46-51`, `scripts/check-no-secrets.mjs:26`

`JSON.parse(json) as T` is a cast, not a check. That is safe only while the secret is strong, because only the server can sign. But `check-no-secrets.mjs:26` accepts any `QWIXX_COOKIE_SECRET` of 8 characters or more, and `.env.example:3` ships the literal `replace-me-32-bytes-base64` — 26 characters, passes the gate, and is a **publicly known string in this repository**. An operator who deploys without substituting it gives any reader of the repo the ability to mint `{"gid":...,"code":"ABCDEF","pid":<any>,"seat":1}` and act as host of any game: `POST /end` and `POST /start` authorise on `auth.seat !== 1` alone (`start/route.ts:20`, `end/route.ts:22`). Your local `.env.local` is correctly set to 43 characters, so this is a deployment-time risk, not a current one. Fix: require 32 bytes of entropy in the gate, and parse the payload with a zod schema.

**M3. The migrations contain no `GRANT` or `REVOKE`. The grants exist only in a markdown file.**
`supabase/migrations/0001_qwixx_schema.sql`, `0002_cleanup_jobs.sql`

`grep -in "grant\|revoke" supabase/migrations/` returns nothing. The correct grants — including the important `REVOKE ALL ON SCHEMA qwixx FROM anon, authenticated` — live at `.pipeline/infra-spec.md:558-563`, in prose, in a different directory, in a file that is not applied by any tool. This matters precisely because `qwixx` sits in a shared database and `.pipeline/infra-spec.md:555` documents that Kong's `rest-v1` route allows the `anon` ACL group, so an anon-key holder can address `/rest/v1/` with `Accept-Profile: qwixx`. Postgres grants are the only control stopping them.

Two concrete consequences. (a) An operator applying only `supabase/migrations/*.sql` gets a schema with no grants, PostgREST returns permission-denied as `service_role`, and the likely field fix under pressure is a broad `GRANT ... TO PUBLIC`. (b) Both `security definer` functions (`0001:80-91`, `0002:1-41`) default to `EXECUTE TO PUBLIC` in Postgres. `infra-spec.md:759` revokes that for `cleanup_abandoned()` and says **nothing about `consume_rate_limit`** — a `SECURITY DEFINER` function that writes to `qwixx.rate_limits` and is, by default, callable by every role in the cluster. Whoever can reach it can pin any victim's rate-limit bucket over the limit. Schema `USAGE` currently blocks the path, so this is defence-in-depth, but the defence is one forgotten `GRANT` away. Fix: move the grants and both revokes into a `0003_grants.sql` migration.

**M4. `clientIp()` trusts `X-Forwarded-For`, and the app is reachable off-tunnel.**
`lib/ipHash.ts:7-18`

Line 11-16 takes `X-Forwarded-For.split(',')[0]` — the leftmost, entirely attacker-supplied entry. Through the Cloudflare Tunnel this branch is unreachable, because Cloudflare's edge always sets `CF-Connecting-IP` and overwrites any client-supplied value, and line 8 checks it first. **Through the tunnel, the rate limit is sound.** But `.pipeline/infra-spec.md:1028` documents a second live path: `curl http://192.168.10.20:30111`, the NodePort "fire escape". On that path there is no Cloudflare edge, `CF-Connecting-IP` is absent, and anyone on the VLAN sets `X-Forwarded-For` to a fresh value per request to get an unlimited number of 10-per-minute buckets. Nothing in the code asserts the request arrived through the tunnel. Fix: read only `CF-Connecting-IP`, and reject requests lacking it in production.

**M5. `games.locked_rows` is updated without optimistic concurrency. Locks can be lost.**
`app/api/games/[code]/mutations/route.ts:49-53`, `:156-159`

Every other write in this file is careful. The sheet update at `:124-137` uses `.eq('version', baseVersion)` as a proper compare-and-swap and handles the loss at `:140-154`. The `locked_rows` update at `:158` is a bare `update ... .eq('id', game.id)` against a value read at `:51`, with no CAS. Two players locking two different colours within the same window both compute `workingLockedRows` from the same stale base, and the second write erases the first player's colour. Consequence: a colour that should be closed for all players stays open, and `checkGameEnd`'s two-lock condition (`lib/scoring.ts`, `lockedColorCount >= LOCKS_TO_END_GAME`) never fires — the game does not end when it should. Per-player lock points in `sheets.locks` are unaffected. Fix: merge server-side in a single statement, or CAS on the previous `locked_rows` value.

**M6. No security headers at all.**
`next.config.ts:1-5`

No `headers()`, no `middleware.ts` anywhere in the tree. A public-internet PWA ships with no `Content-Security-Policy`, `X-Frame-Options` / `frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy`. XSS risk is genuinely low here (see section 5), so CSP is defence in depth, but clickjacking on a live game sheet needs only an iframe. Fix in section 4.

**M7. Every route handler swallows its error. Zero observability.**
Twelve `} catch {` blocks with an empty binding, across every route (`games/route.ts:86`, `join/route.ts:172`, `[code]/route.ts:147`, `mutations/route.ts:211`, `start:64`, `end:79`, `player:53`, `me:48`, `profile:95`, `history:101`). Not one logs. `grep console\. app components lib` returns only `scripts/`. The result: no signal on auth failures, no signal on 500s, and no way to detect H1 being exploited except by watching disk. The skill's rubric treats missing monitoring on auth and data-mutation paths as a real gap. Fix: `console.error` the caught value with a request-scoped id, never the cookie.

**M8. `output: 'standalone'` is missing from `next.config.ts`.**
`next.config.ts:3-5` sets only `typedRoutes: true`. `.pipeline/infra-spec.md:70` records it as a non-negotiable that "must already be set". It is not. The Dockerfile in `infra-spec.md:66` will produce an image with no `server.js`. This is a deploy break, not a vulnerability, but it blocks the same milestone.

### Low

**L1. `GET /api/me` does not bind the seat cookie to the device.** `app/api/me/route.ts:27-36` reads `seatPayload.gid`, `.code` and `.seat` and returns them **without checking `seatPayload.pid === device.playerId`** — the check `resolveSeat` does correctly at `lib/auth.ts:80`. Pairing a captured `qx_seat` with your own `qx_device` discloses that player's game code and seat number. Requires already having stolen a signed cookie, and the game code alone is not a capability, so impact is small. It is still an inconsistency with the module that gets it right.

**L2. Join codes are released on game end, so a stale seat cookie can name the wrong game.** The unique index at `0001_qwixx_schema.sql:54-56` is `where status <> 'ended'`, so an ended game's code is reusable. `resolveSeat` short-circuits on `seatPayload.code === code` (`lib/auth.ts:80`) and returns `gameId: seatPayload.gid` — the **old** game — while every handler independently re-resolves the code to the **new** game. No current handler trusts `auth.gameId`, so both paths fail closed by accident rather than by design. Any future handler that uses `auth.gameId` gets cross-game access. Fix: drop `gid` from the seat cookie, or verify it against the resolved game.

**L3. `GET /api/me` mutates state.** `ensureDevice()` at `app/api/me/route.ts:22` inserts a row and issues a `Set-Cookie` on a GET. This is what makes H1 crawler-triggerable and it violates GET safety. Split identity creation into an explicit POST.

**L4. `code` is not normalised in the `[code]` routes.** `[code]/route.ts:14`, `mutations:33`, `start:9`, `end:9`, `player:10` pass the raw path segment to `requireSeat` and `.eq('join_code', code)`. `POST /api/games/join` normalises properly via `normalizeJoinCode` (`join/route.ts:23`), and `app/g/[code]/page.tsx:5` upper-cases before rendering, so the client never hits it. Not injectable — supabase-js URL-encodes filter values — but a lowercase or 200-character segment reaches the database as a query. Apply `normalizeJoinCode` and return 400 on failure.

**L5. `history` `cursor` is unvalidated.** `app/api/history/route.ts:20,43` passes an arbitrary string into `.lt('ended_at', cursor)`. supabase-js encodes it into the query string so PostgREST filter injection is not reachable, but a non-timestamp produces a database error caught into a generic 500. Validate as ISO-8601.

**L6. `lib/ratelimit.ts:15-18` comment contradicts the code.** The comment says "Fail open on infrastructure trouble rather than locking everyone out"; the code `throw`s, which propagates to the caller's catch and returns 500. It fails **closed**. Closed is the better behaviour — fix the comment, not the code.

**L7. `check-no-secrets.mjs:60` prints a secret into build logs.** `console.error(\`Found a NEXT_PUBLIC_ variable in ${entry}: ${trimmed}\`)` echoes the whole line, value included. The one case this branch fires is the case where that value is a secret, and it lands in CI output. Print the key name only.

**L8. `check-no-secrets.mjs` source scanning misses whole directories.** `sourceDirs` (line 68) is `['app','components','lib']`; the import guard (line 92) adds `'public'`. A Client Component in `src/`, `hooks/`, `utils/`, or at the repo root is scanned by neither, and `next.config.ts` — which can inline values into the browser bundle via its `env` key — is scanned by neither. Currently no such directory exists. Scan the whole tree minus `node_modules`, `.git`, `.next`.

**L9. `npm audit`: one high, one moderate, both transitive through `next`.** `postcss <=8.5.22`, four advisories, all requiring attacker-controlled CSS or `sourceMappingURL` at build time. This project compiles only its own `app/globals.css`. Not reachable. Track it; the fix is `next@16`, a major bump, and is not urgent.

**L10. Concurrent joins report a misleading error.** `join/route.ts:132` computes `nextSeat` from a read at `:121`, then relies on the unique index to catch the race. Both `game_players_seat_uniq` and the `(game_id, player_id)` primary key raise `23505`, and `:138` maps both to `game_full`. Safe, but a fourth player racing a fifth is told the game is full when it is not. Retry once on `23505` before reporting.

---

## 4. Remediated Code Blocks

### Fix H1 — rate limit identity creation and reclaim orphaned players

`app/api/games/route.ts` — insert immediately after the `parseBody` block at line 18:

```ts
import { consume } from '@/lib/ratelimit';
import { clientIp, hashIp } from '@/lib/ipHash';

const CREATE_IP_LIMIT = 5;

// ...inside POST, after parseBody succeeds and BEFORE ensureDevice():

    // ensureDevice() commits a qwixx.players row for any caller without a valid
    // cookie, and this route commits three more. Unlimited, unauthenticated row
    // creation in a database shared with other services is an availability
    // problem for those services, not just for this app.
    const createLimit = await consume(`create:${hashIp(clientIp(req))}`, CREATE_IP_LIMIT);
    if (!createLimit.allowed) {
      return jsonError(
        429,
        'rate_limited',
        'Too many games created. Try again shortly.',
        { retryAfter: createLimit.retryAfter },
        { headers: { 'Retry-After': String(createLimit.retryAfter) } },
      );
    }

    const device = await ensureDevice(req);
```

`app/api/me/route.ts` — replace the body of `GET` from line 21:

```ts
const ME_IP_LIMIT = 30;

export async function GET(req: Request) {
  try {
    // A GET reached by crawlers and link-preview bots must not be an unbounded
    // INSERT. Callers that already hold a valid device cookie skip the limiter
    // entirely, so real players are never throttled.
    const known = await resolveDevice(req);
    if (!known) {
      const limit = await consume(`me:${hashIp(clientIp(req))}`, ME_IP_LIMIT);
      if (!limit.allowed) {
        return jsonError(
          429,
          'rate_limited',
          'Too many requests. Try again shortly.',
          { retryAfter: limit.retryAfter },
          { headers: { 'Retry-After': String(limit.retryAfter) } },
        );
      }
    }

    const device = await ensureDevice(req);
    // ...unchanged from here
```

Add `import { resolveDevice } from '@/lib/auth';`, `import { consume } from '@/lib/ratelimit';` and `import { clientIp, hashIp } from '@/lib/ipHash';` to that file.

New migration `supabase/migrations/0003_orphan_players.sql`:

```sql
-- cleanup_abandoned() reclaims games and rate_limits but never the players rows
-- that every unauthenticated request to POST /api/games and GET /api/me creates.
-- Without this the table only grows, in a database shared with other services.
create or replace function qwixx.cleanup_orphan_players()
returns int
language sql
security definer
set search_path = qwixx, public
as $$
  with d as (
    delete from qwixx.players p
    where p.created_at < now() - interval '48 hours'
      and not exists (select 1 from qwixx.game_players gp where gp.player_id = p.id)
      and not exists (select 1 from qwixx.games g where g.winner_player_id = p.id)
    returning 1
  ) select count(*)::int from d;
$$;

revoke execute on function qwixx.cleanup_orphan_players() from public, anon, authenticated;
grant  execute on function qwixx.cleanup_orphan_players() to service_role;

select cron.schedule('qwixx-cleanup-orphans', '23 * * * *',
                     $$select qwixx.cleanup_orphan_players();$$);
```

### Fix H2 bypass A — refuse to pass without a bundle

`scripts/check-no-secrets.mjs`, replace lines 171-176:

```js
// The script's contract is that it cannot pass vacuously. Env vars were the
// only thing checked for that; a missing .next made walk() a silent no-op and
// the gate reported success having read one file. Assert the bundle was
// actually there.
const MIN_FILES = 10;

if (hit) {
  fail('A Supabase credential was found in the client bundle. Failing the build.');
}

if (!existsSync(join(root, '.next', 'static'))) {
  fail('Cannot verify the bundle because .next/static does not exist. Run next build first.');
}

if (filesChecked < MIN_FILES) {
  fail(
    `Cannot verify the bundle: only ${filesChecked} files were scanned, expected at least ${MIN_FILES}. ` +
      'The build output is missing or this ran from the wrong directory.',
  );
}

console.log(`No Supabase credential found in the client bundle. Checked ${filesChecked} files.`);
process.exit(0);
```

While in the file, apply L7 and L8:

```js
// Print the variable name only. The one situation this branch fires in is the
// situation where the value is a secret, and build logs are not a secret store.
if (trimmed.startsWith('NEXT_PUBLIC_')) {
  console.error(`Found a NEXT_PUBLIC_ variable in ${entry}: ${trimmed.split('=')[0]}`);
  publicEnvLeak = true;
}
```

```js
// Scan the whole tree, not three hand-listed directories. A Client Component
// in src/ or hooks/, or an env key in next.config.ts, is just as capable of
// inlining a value into the browser bundle.
const sourceDirs = ['.'];
```

and extend `walk()`'s skip list on line 43 to `if (entry === 'node_modules' || entry === '.git' || entry === '.next' || entry === 'coverage') continue;`.

### Fix H2 bypass B — close the RSC hole where it can actually be closed

A post-hoc grep over build artifacts cannot see a payload serialised per request. The control has to move to compile time. Add to `eslint.config.mjs`:

```js
// A Server Component may read process.env freely, but the moment a secret
// becomes a prop on a Client Component it is serialised into the RSC flight
// payload and streamed to the browser. That payload never touches disk on a
// dynamically rendered route, so check-no-secrets.mjs structurally cannot see
// it. This rule is the only control that can.
{
  files: ['app/**/*.tsx', 'components/**/*.tsx'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "JSXAttribute > JSXExpressionContainer MemberExpression[object.object.name='process'][object.property.name='env']",
        message:
          'Never pass process.env into a JSX prop. It is serialised into the RSC payload and shipped to the browser.',
      },
    ],
  },
},
```

Add `next lint` to the build chain so the rule actually gates, and keep the runtime check as a second line of defence:

```json
"build": "next lint --max-warnings=0 && next build && node scripts/check-no-secrets.mjs"
```

### Fix M1 and M2 — enforce expiry and validate the payload

`lib/cookies.ts`, replace `verifyCookie` and add the schemas:

```ts
import { z } from 'zod';

const deviceCookieSchema = z.object({ pid: z.string().uuid(), iat: z.number().int().positive() });
const seatCookieSchema = z.object({
  gid: z.string().uuid(),
  code: z.string().regex(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/),
  pid: z.string().uuid(),
  seat: z.number().int().min(1).max(5),
  iat: z.number().int().positive(),
});

/**
 * maxAgeSeconds is not optional. Max-Age on the Set-Cookie header is a browser
 * hint; an attacker replaying a captured value sets the request header directly
 * and the HMAC stays valid forever. iat was already in the payload and was
 * never read.
 */
function verifySigned(value: string | undefined | null, maxAgeSeconds: number): unknown | null {
  if (!value) return null;
  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1) return null;

  const payloadB64 = value.slice(0, lastDot);
  const providedBuf = Buffer.from(value.slice(lastDot + 1), 'utf8');
  const expectedBuf = Buffer.from(sign(payloadB64), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(providedBuf, expectedBuf)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const iat = (parsed as { iat?: unknown })?.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  const age = Math.floor(Date.now() / 1000) - iat;
  // A negative age means a clock-skewed or forward-dated payload. Reject both.
  if (age < -60 || age > maxAgeSeconds) return null;

  return parsed;
}

export function verifyDeviceCookie(value: string | undefined | null): DeviceCookiePayload | null {
  const raw = verifySigned(value, DEVICE_COOKIE_MAX_AGE);
  if (raw === null) return null;
  // A cast is not a check. The signature proves this server minted it; the
  // schema proves the shape still matches what the authorisation code assumes,
  // which matters because seat drives the host-only routes.
  const result = deviceCookieSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function verifySeatCookie(value: string | undefined | null): SeatCookiePayload | null {
  const raw = verifySigned(value, SEAT_COOKIE_MAX_AGE);
  if (raw === null) return null;
  const result = seatCookieSchema.safeParse(raw);
  return result.success ? result.data : null;
}
```

Replace the three `verifyCookie<...>` call sites with the typed helpers: `lib/auth.ts:30`, `lib/auth.ts:79`, `app/api/me/route.ts:26`.

`scripts/check-no-secrets.mjs`, raise the entropy floor at lines 24-29:

```js
// 8 characters is not a bar for an HMAC key. .env.example ships the literal
// "replace-me-32-bytes-base64", which is 26 characters, passes a length-8
// check, and is public in this repository. Forging qx_seat with seat:1 gives
// host control of any game.
const MIN_LENGTHS = {
  SUPABASE_URL: 8,
  SUPABASE_SERVICE_ROLE_KEY: 32,
  QWIXX_COOKIE_SECRET: 32,
  QWIXX_IP_HASH_SECRET: 32,
};

for (const [name, min] of Object.entries(MIN_LENGTHS)) {
  const value = process.env[name];
  if (!value || value.length < min) {
    fail(`Cannot verify the bundle because ${name} is unset or shorter than ${min} characters.`);
  }
  if (value.startsWith('replace-me')) {
    fail(`${name} still holds the .env.example placeholder. Generate a real value.`);
  }
}
```

### Fix M3 — put the grants in a migration

New `supabase/migrations/0003_grants.sql` (merge with the orphan-players migration above if you prefer one file):

```sql
-- These grants were specified only in .pipeline/infra-spec.md, which no tool
-- applies. qwixx shares a database with other services and Kong's rest-v1 route
-- admits the anon ACL group, so Postgres grants are the only control keeping an
-- anon-key holder out of game data.
grant usage on schema qwixx to service_role;
grant all on all tables    in schema qwixx to service_role;
grant all on all sequences in schema qwixx to service_role;
alter default privileges in schema qwixx grant all on tables to service_role;

revoke all on schema qwixx from anon, authenticated;

-- Both functions are SECURITY DEFINER and Postgres grants EXECUTE to PUBLIC by
-- default. consume_rate_limit was never revoked anywhere; anyone who can call
-- it can pin a victim's bucket over the limit and lock them out of joining.
revoke execute on function qwixx.consume_rate_limit(text) from public, anon, authenticated;
grant  execute on function qwixx.consume_rate_limit(text) to service_role;

revoke execute on function qwixx.cleanup_abandoned() from public, anon, authenticated;
grant  execute on function qwixx.cleanup_abandoned() to service_role;
```

### Fix M4 — do not trust `X-Forwarded-For`

`lib/ipHash.ts`, replace `clientIp`:

```ts
/**
 * CF-Connecting-IP only. Cloudflare's edge always sets it and overwrites any
 * client-supplied value, so it is trustworthy through the tunnel. X-Forwarded-For
 * is not: its leftmost entry is whatever the caller typed, and the app is also
 * reachable on the NodePort fire escape (infra-spec.md:1028) where no edge
 * rewrites anything. Falling back to it there hands out unlimited buckets.
 */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  return cf ? cf : null;
}
```

At each call site, treat `null` as "not behind the tunnel" and fail closed in production:

```ts
const ip = clientIp(req);
if (!ip) {
  // No edge header means this did not arrive through the tunnel. In production
  // that is the NodePort path, where the limiter cannot be keyed on anything
  // the caller does not control.
  if (process.env.NODE_ENV === 'production') {
    return jsonError(400, 'bad_request', 'Unrecognised request origin.');
  }
}
const ipKey = `ip:${hashIp(ip ?? 'local')}`;
```

### Fix M5 — make the locked-rows write atomic

`app/api/games/[code]/mutations/route.ts`, replace lines 156-159:

```ts
    // The sheet write above is a proper CAS; this one was not. Two players
    // locking two different colours in the same window both computed from the
    // same stale base and the second write erased the first, which also stops
    // checkGameEnd's two-lock condition from ever firing.
    const lockedRowsChanged = COLORS.some((c) => workingLockedRows[c] !== game.locked_rows[c]);
    if (lockedRowsChanged) {
      const { error: lockError } = await db.rpc('merge_locked_rows', {
        p_game_id: game.id,
        p_locked_rows: workingLockedRows,
      });
      if (lockError) return jsonError(500, 'server_error', 'Something went wrong.');

      const { data: freshGame } = await db
        .from('games')
        .select('locked_rows')
        .eq('id', game.id)
        .maybeSingle();
      if (freshGame) workingLockedRows = freshGame.locked_rows;
    }
```

Add `COLORS` to the import from `@/lib/scoring`, and add to the grants migration:

```sql
-- First writer of a colour wins, per the rule that only the first player to
-- lock a colour closes it. jsonb_strip_nulls plus || would let a null clobber
-- a set value, so merge key by key.
create or replace function qwixx.merge_locked_rows(p_game_id uuid, p_locked_rows jsonb)
returns void
language sql
security definer
set search_path = qwixx, public
as $$
  update qwixx.games g
  set locked_rows = (
    select jsonb_object_agg(
      k,
      case when g.locked_rows -> k <> 'null'::jsonb
           then g.locked_rows -> k
           else p_locked_rows -> k end
    )
    from jsonb_object_keys(g.locked_rows) as k
  )
  where g.id = p_game_id;
$$;

revoke execute on function qwixx.merge_locked_rows(uuid, jsonb) from public, anon, authenticated;
grant  execute on function qwixx.merge_locked_rows(uuid, jsonb) to service_role;
```

### Fix M6 and M8 — security headers and standalone output

`next.config.ts`, full replacement:

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Required by the Dockerfile in .pipeline/infra-spec.md:70. Without it the
  // image has no server.js and the container will not start.
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            // No inline event handlers and no third-party origins in this app.
            // 'unsafe-inline' on style-src is required by Tailwind v4's runtime
            // style injection; script-src carries no such exception.
            value: [
              "default-src 'self'",
              "script-src 'self'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          // cloudflared terminates TLS at the edge, so the pod only ever sees
          // http and will not emit this on its own.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
```

If the CSP breaks a Next.js dev overlay, scope the `headers()` block behind `process.env.NODE_ENV === 'production'` rather than weakening `script-src`.

### Fix L1 — bind the seat cookie to the device in `/api/me`

`app/api/me/route.ts:27`:

```ts
    // resolveSeat() checks this at lib/auth.ts:80 and this route did not. A
    // captured qx_seat paired with any qx_device disclosed that player's game.
    if (seatPayload && seatPayload.pid === device.playerId) {
```

---

## 5. What Is Actually Fine

Stated plainly, because a report that only lists problems misrepresents this codebase.

**Authorisation is correct.** I traced every write. `POST /api/games/[code]/mutations` scopes both the read (`:66`) and the CAS update (`:134`) to `auth.playerId`, never to a client-supplied id — there is no field in `mutationsBatchSchema` that names a player, so there is nothing to tamper with. `PATCH /player` updates `.eq('id', auth.playerId)`. `POST /start` and `POST /end` both gate on `auth.seat !== 1`, and seat 1 is only ever assigned to the creator (`games/route.ts:58`) and is protected from reassignment by `game_players_seat_uniq`. **I found no IDOR and no missing caller check on any game-data write.** The only writes with no caller verification are identity-row creation, which is unauthenticated by design — the problem there is volume (H1), not authorisation.

**The HMAC construction is sound.** `createHmac('sha256', ...)` over the **base64url-encoded** payload, not over concatenated fields (`lib/cookies.ts:21-24`). That is the detail that matters for your field-boundary question: because the signed string is base64url — alphabet `A-Za-z0-9-_` — a display name or game code cannot introduce a delimiter, and `lastIndexOf('.')` cannot be shifted. **No crafted display name or game code can move a field boundary.** The comparison uses `timingSafeEqual` with a length pre-check (`:41-44`), which is the correct order since `timingSafeEqual` throws on unequal lengths; the signature is a fixed 43 characters, so the pre-check leaks nothing.

**A captured `qx_seat` cannot be replayed against a different game or player.** `resolveSeat` requires both `seatPayload.code === code` **and** `seatPayload.pid === device.playerId` (`lib/auth.ts:80`), so the seat cookie is useless without the matching device cookie, and `mutations/route.test.ts:173-174` has a regression test for exactly that mismatch. The one gap is `/api/me` (L1), which is read-only and low impact.

**Cookie flags are right.** `HttpOnly; Secure; SameSite=Lax; Path=/` on both, with `Secure` set as a **literal**, not auto-detected — which is exactly what `.pipeline/infra-spec.md:463` warns about, since the pod sees plain HTTP behind cloudflared. That warning was heeded.

**Join code generation is correct.** `randomBytes` is a CSPRNG (`lib/joincodeGenerate.ts:10`). The rejection sampling genuinely removes modulo bias: `REJECTION_CEILING = 240 = 8 × 30`, and bytes ≥ 240 are discarded (`:13`) before `% 30`, leaving 240 values mapping 8-to-1 onto 30 symbols with zero skew. Brute force is not feasible: 30⁶ = 729,000,000 ≈ 2²⁹·⁴, with only a handful of codes live at any time (the unique index is scoped `where status <> 'ended'`). At the implemented 10 attempts per minute per IP that is roughly 14,400 guesses per day against a space of 7.29 × 10⁸ — expected time to a single hit is measured in millennia. Even with the M4 evasion, the code space, not the rate limit, is what makes this safe.

**The IP hash is correct.** HMAC-SHA256 keyed with `QWIXX_IP_HASH_SECRET` (`lib/ipHash.ts:23`), not a bare digest, so the ~4 billion IPv4 preimages cannot be enumerated. The raw IP is never stored. The rate-limit counter itself is atomic — a single `insert ... on conflict do update ... returning count` (`0001:86-90`), so concurrent requests cannot race past the limit.

**Input validation holds.** Every route body goes through zod (`lib/apiError.ts:47`). `mutationsBatchSchema` caps the array at 50 (`lib/validation.ts:54`), so it is **not** unbounded. `color` is an enum, `index` an integer, and `canCross` independently bounds-checks `index` against the row length (`lib/scoring.ts:146`) — a client cannot write outside a row. **No prototype pollution:** `JSON.parse` creates `__proto__` as a plain own property rather than walking the prototype chain, zod's `z.object` strips unknown keys, and no code path does a recursive merge. **No SQL injection:** every query goes through supabase-js, which URL-encodes filter values, and there is no raw SQL string anywhere in the application.

**No XSS.** `grep -rn "dangerouslySetInnerHTML\|innerHTML\|eval(\|new Function\|document.write" app components lib public` returns nothing. Display names render as JSX children and are escaped by React; they never reach an `href`, `src`, or style attribute. The only interpolated URLs are internal paths built from server-returned codes.

**CSRF is adequately handled.** `SameSite=Lax` is set as an **explicit** attribute, so Chrome's two-minute "lax-allows-unsafe" grace period — which applies only to cookies with no `SameSite` attribute — does not apply. A cross-site POST therefore carries no cookies and gets a 401. Every state-changing endpoint is POST or PATCH; the only cookie-sending cross-site vector is a top-level GET navigation, and the only GET that changes anything is `/api/me` (L3), which creates a row for the visitor and discloses nothing about anyone else.

**No secret is in the current bundle.** I ran the gate against the real `.env.local` and the committed `.next`: clean, 47 files. I also confirmed `@supabase/supabase-js` is imported only from `lib/supabase/server.ts`, that `server-only` guards `auth.ts`, `cookies.ts`, `ipHash.ts`, `ratelimit.ts`, `gameEnd.ts` and `supabase/server.ts`, that there is no `NEXT_PUBLIC_` variable anywhere, and that `.env.local` is correctly gitignored and untracked (`git status` confirms). Nothing is leaking **today**. H2 is about the gate being unable to tell you if that changed.

**The service worker is clean.** It short-circuits every `/api/` request to network-only and never caches a response (`public/sw.js:35-38`); its cache holds only the app shell, `_next/static` and icons. No player data is written to any browser cache, and no identity is in `localStorage`, `sessionStorage` or `document.cookie` — I grepped for all three and the only identity storage is the httpOnly cookies, which is the correct design.

**Error responses do not over-disclose.** Every handler returns a fixed message from a closed `ErrorCode` union. No stack traces, no database error strings, no `error.message` from Supabase reaches the client. The one exception is `parseBody`'s zod `flatten()` detail (`lib/apiError.ts:52`), which describes only the caller's own body.

**Scoring is not a security surface but is worth noting as correct.** The four documented rulebook bugs from `intent.md:10-13` are each enforced server-side and independently of the client — `lock_requires_five`, `not_strictly_right`, the lock-as-extra-cross bonus, and game-end detection. A tampered client cannot cheat, because `applyCross` re-derives legality from server state on every mutation rather than trusting the batch.

---

## 6. Recommended Order of Work

1. **H1** — rate limit `POST /api/games` and `GET /api/me`, add the orphan sweep. Highest real exploitability, and the shared database makes the blast radius somebody else's outage.
2. **H2 bypass A** — six lines. A gate that fails open is worse than no gate, because it is trusted.
3. **M3** — move the grants into a migration before the schema is applied to the shared database. Cheapest to do now, most painful to retrofit.
4. **H2 bypass B**, **M2**, **M1** — the lint rule, the entropy floor, and the `iat` check.
5. **M8** and **M6** — `output: 'standalone'` and the headers block, before the first deploy.
6. **M4**, **M5**, **M7**, then the Low findings.

No application source was modified during this review. All empirical testing ran in throwaway copies under the session scratchpad, which were deleted.
