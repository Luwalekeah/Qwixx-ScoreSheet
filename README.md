# Qwixx Score Sheet

A multiplayer, local-first score sheet for the dice game Qwixx. Next.js 15 App
Router, TypeScript, Tailwind CSS v4, Supabase (server-side only) for storage,
polling for sync.

## Stack

- Next.js 15 App Router, TypeScript strict mode.
- Tailwind CSS v4, configured entirely through the `@theme` block in
  `app/globals.css`. There is no `tailwind.config.js`.
- Framer Motion for subtle transitions only.
- Supabase Postgres for storage. The browser never talks to Supabase; it only
  calls this app's own route handlers under `/api/*`.
- IndexedDB plus a background flush loop for local-first gameplay. Sync is
  polling, never Supabase Realtime.

## Requirements

- Node 26 (pinned in `.nvmrc`).
- npm, not pnpm.
- A reachable Postgres instance with the `qwixx` schema applied (see
  Migrations below). In production this is the existing self-hosted Supabase
  on `luwah-k3s`, reached over its ClusterIP address and never exposed
  publicly.

## Setup

```bash
nvm use
npm install
cp .env.example .env.local
# fill in real values in .env.local
npm test
npm run dev
```

## Environment variables

Four variables, all server-only. None is prefixed `NEXT_PUBLIC_`.

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Base URL of the Supabase/Kong instance. Reached server-side only. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key. Never sent to the browser. |
| `QWIXX_COOKIE_SECRET` | HMAC key for the two signed cookies (`qx_device`, `qx_seat`). |
| `QWIXX_IP_HASH_SECRET` | HMAC key used to hash the client IP for the join rate limiter. The raw IP is never stored. |

## Migrations

Run in order against the Postgres instance behind `SUPABASE_URL`:

1. `supabase/migrations/0001_qwixx_schema.sql` — the `qwixx` schema, four
   domain tables, `rate_limits`, constraints and indexes.
2. `supabase/migrations/0002_cleanup_jobs.sql` — `qwixx.cleanup_abandoned()`
   plus a `pg_cron` schedule.

If `create extension pg_cron` fails on the target instance (not every managed
Postgres allows it), the `qwixx.cleanup_abandoned()` function still installs.
In that case wire an external scheduler — a k3s `CronJob` running
`psql -c "select qwixx.cleanup_abandoned();"` on the same hourly cadence — to
call it instead. Do not add a request-time cleanup path.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server. |
| `npm test` | Runs the Vitest suite (`lib/**/*.test.ts`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | `next lint`. |
| `npm run build` | `next build`, then `scripts/check-no-secrets.mjs`, which fails the build if any Supabase credential reaches the client bundle. |
| `npm start` | Runs the production build. |

## Architecture notes

- **`games.locked_rows`** is game-wide colour closure: which colour dice are
  removed for every player, and who removed them. **`sheets.locks`** is one
  player's own lock mark and the extra point it earns. These are different
  concepts and the codebase never conflates them, except in the one place
  `lib/scoring.ts` documents (`applyCross` / `undoCross` on the lock index).
- **The pure scoring engine** lives entirely in `lib/scoring.ts`. It has no
  React, network, clock, or randomness. `lib/scoring.test.ts` names 49 tests,
  including four regression suites for the four scoring bugs in the old
  Streamlit app, and was written and green before any UI file existed.
- **Local-first sync.** Every tap writes to IndexedDB and updates local state
  synchronously; the network is a background flush (`lib/sync.ts`). Other
  devices see updates by polling `GET /api/games/[code]` every 3 seconds.
  There is no websocket to Supabase.
- **No Supabase client in the browser.** `lib/supabase/server.ts` is the only
  file allowed to import `@supabase/supabase-js`, starts with
  `import 'server-only'`, and is never imported from a Client Component.
  `scripts/check-no-secrets.mjs` enforces both of these as part of every
  build.
- **Transactions.** The spec describes several handlers as a single
  `SELECT ... FOR UPDATE` transaction. This project talks to Postgres through
  `@supabase/supabase-js`, which is a PostgREST client and has no primitive
  for a multi-statement transaction with row locking from application code.
  Two compensating designs are used instead, and both are the standard
  pattern for this client:
  - **Optimistic concurrency** for sheet writes: `sheets.version` is checked
    and then the update is issued with `.eq('version', baseVersion)`; a
    zero-row update result means a concurrent writer won the race, and the
    handler returns `409 version_conflict` with freshly read authoritative
    state. Each device is the sole writer of its own sheet, so this is a
    safety net, not a merge strategy, exactly as the spec intends.
  - **A Postgres function reached over RPC** for the one place that
    genuinely needs a single atomic statement outside the JS client's reach:
    the join rate limiter's fixed-window upsert
    (`qwixx.consume_rate_limit`, added to `0001_qwixx_schema.sql`, called via
    `db.rpc(...)` from `lib/ratelimit.ts`). This is the literal upsert from
    the design section, wrapped so it runs in one round trip.
  - Seat assignment and join-code generation lean on the two partial unique
    indexes in the schema (`games_join_code_live_uniq`,
    `game_players_seat_uniq`) and retry-on-23505, per the spec's own
    collision-handling design for join codes.
- **Cookies.** `qx_device` (2 years) is the durable per-device profile key.
  `qx_seat` (7 days) is the per-game seat claim. They are never merged; see
  `lib/cookies.ts` and `lib/auth.ts`.

## Layout floor

The score grid is built mobile-first as a 6-column, 2-row CSS grid (11
numbers plus the lock cell) inside each row card. At 390 px this computes to
56 px cells; the tap target floor is 48 px. **360 px is the supported floor.**
Below that (down to 320 px) cells shrink to 44 px and the layout still works
with no horizontal scroll, but is considered degraded rather than the target
experience.

## Known gaps against the spec

- **Icons are placeholders.** `public/icons/*.png` are flat solid-colour PNGs
  generated by `scripts/generate-icons.mjs`, not final artwork. Replace
  before shipping to real users.
- **Public hostname.** Per the spec's own open question, the app is built
  entirely with relative URLs and never hardcodes an origin. The share link
  is built from `request.headers.get('host')` on the server and
  `window.location.origin` on the client.
- **`pg_cron` availability** is unconfirmed on the target Postgres instance,
  also per the spec's open question. Both artefacts (the SQL function and the
  `pg_cron` schedule statement) are shipped in `0002_cleanup_jobs.sql`; if the
  extension is unavailable, wire the k3s CronJob described above.
