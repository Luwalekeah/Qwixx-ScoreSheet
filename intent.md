# Qwixx score sheet rewrite, multiplayer and local first

## Problem

The existing Streamlit app at github.com/Luwalekeah/Qwixx-ScoreSheet loses state and scores wrong.

- Streamlit `st.session_state` lives server side and is keyed to the websocket connection. Backgrounding the tab on a phone kills the socket and destroys the whole score sheet. This is the primary pain and it cannot be fixed inside Streamlit.
- The 13 column checkbox rows are not usable at 390px phone width.
- Scoring is wrong in four documented ways.
  1. Lock bonus is applied as a flat plus one point. The lock counts as an extra crossed off number, so five crosses plus a lock must score 21, not 16.
  2. An already crossed cell, and the current rightmost mark, can be crossed again. A cross must be strictly to the right of the rightmost existing cross.
  3. A lock is permitted on five or more crosses alone. A lock requires crossing the rightmost number of the row, 12 for red and yellow, 2 for green and blue, and already holding at least five crosses in that row.
  4. There is no game end detection at all.
- It is single player only.

This is a replacement, not a patch. The old repo is archived with a README pointer to the new one.

## Desired outcome

A new app ships and the following are true and testable.

- A pure TypeScript scoring module exists with unit tests written from the rulebook before any UI exists. Each of the four bugs above has a named regression test.
- Game ends automatically on four penalties by any player, or when two colour rows are locked. Winner is resolved with the official tiebreakers, fewer penalties first, then most numbers crossed in a single row.
- A host creates a game and receives a six character code and a `/g/<CODE>` share link. Two to five players join by code or link, enter a display name, and appear in a lobby. The host starts the game.
- Late join is blocked once status is `active`. The code stops resolving once status is `ended`.
- Rejoin from the same device restores the seat with no prompt, after refresh, app switch, or phone restart.
- Every tap writes to IndexedDB and renders with no network in the path. Backgrounding the tab loses nothing.
- A service worker syncs to Supabase in the background. Other devices see updates by polling the app's own route handler roughly every three seconds.
- Every player's score and the game wide locked colours are visible live.
- The last mark can be undone.
- Game history records date, players, final scores, winner, and per row breakdown. Player profiles show lifetime win rate, average score, and best row.
- The app installs to a phone home screen and works offline.
- The layout is genuinely tappable at 390px.
- Rules, strategy, and probability reference content is carried over from the old app's `expander.py` into collapsible sections.
- No Supabase key of any kind appears in the browser bundle. A build time check or review step proves it.
- WCAG 2.2 AA passes, reviewed by `luwah-a11y-reviewer`.

## Affected users and systems

- Users: the operator and two to four friends playing on phones in the same room.
- New repo: `qwixx-scoresheet`, currently empty.
- Archived repo: `Luwalekeah/Qwixx-ScoreSheet`, Streamlit, plus the local copy under `Learning/Python/Streamlit/Qwixx-ScoreSheet`. Only `expander.py` content is carried forward.
- `luwah-k3s` cluster. New app deployment, plus a dedicated Cloudflare Tunnel following the existing pwpush pattern.
- Existing Supabase on `luwah-k3s`, namespace `supabase`, Argo managed, Postgres 15.8. A new `qwixx` schema is added. Nothing new is stood up. The existing twice daily `backup-postgres.sh` dump job already covers it.

## Constraints

Architecture below is approved and closed. Do not reopen it.

- Stack: Next.js 15 App Router, TypeScript, Tailwind CSS v4 configured through the CSS first `@theme` block, not `tailwind.config.js`. Framer Motion for subtle transitions only.
- Package manager is npm. pnpm is not installed on this machine. Node 26.
- Hosting is self hosted on `luwah-k3s`. Not Render.
- Supabase and Kong are never exposed to the public internet. Correction recorded 2026-09-01: `supabase-kong` is a NodePort Service on 30103, not ClusterIP. It is still not internet reachable, because it sits on a private VLAN with no port forward and the only public edge on this cluster is the pwpush Cloudflare Tunnel. No change is required and none should be made. The Next.js pod reaches it over cluster DNS at `http://supabase-kong.supabase.svc.cluster.local:8000` using the service role key, server side only. The browser only ever talks to the app's own Next.js route handlers.
- The `qwixx` schema must be added to the `PGRST_DB_SCHEMAS` env var on the supabase PostgREST deployment. PostgREST returns 406 for any schema it was not configured with, so creating the schema and granting on it is not sufficient.
- Supabase Realtime is ruled out by that constraint, because it needs a browser websocket to Kong. Sync is polling.
- Data model is fixed: `qwixx.games` (id, join_code, status, created_at, ended_at, end_reason, winner_player_id, locked_rows jsonb), `qwixx.players` (id, display_name, created_at), `qwixx.game_players` (game_id, player_id, seat, claimed_at, final_score), `qwixx.sheets` (game_id, player_id, crosses jsonb, locks jsonb, penalties int, updated_at, version int). Status is one of `lobby`, `active`, `ended`.
- `games.locked_rows` is game wide truth about which colours are closed, because locking a row removes that colour die for every player and only the first player to lock a colour closes it. `sheets.locks` is whether that one player earned the lock mark and its points. The two must not be conflated.
- `sheets.version` is optimistic concurrency and a safety net only. Each device is the sole writer of its own sheet.
- Join code is six characters from a thirty character alphabet excluding I, L, O, U, 0 and 1, so it is unambiguous read aloud or typed on a phone. The join endpoint is rate limited.
- Identity is a signed httpOnly cookie issued on join, binding the device to (game_id, player_id). No passwords and no OIDC in v1. Every write verifies the request may only write the sheet its cookie names.
- Colour is never the only signal. Red, yellow, green and blue rows each carry a non colour cue.
- Public hostname is still to be decided. It does not block application code.

## Out of scope

- Built in dice roller. Players use physical dice.
- Qwixx variants: Gemischt, Connected, Big Points.
- Authentik SSO and any OIDC login.
- Supabase Realtime.
- Any change to the archived Streamlit app beyond a README pointer.
- Spectator mode, chat, and push notifications. Not requested.

## Open questions

- Public hostname for the Cloudflare Tunnel, and whether the tunnel is shared or dedicated in DNS terms. Owner: operator. Not a code blocker.

## Resolved since intake

Decided by the operator on 2026-09-01. Treat these as constraints.

- Retention. Games with status `ended` are kept indefinitely. That retention is the history feature, and the data volume is trivial.
- Abandoned games. A game left in `lobby` with no start after 24 hours is deleted. A game left in `active` with no sheet write for 7 days is auto set to `ended` with `end_reason` of `abandoned`. Abandoned games are excluded from win rate and average score in player profiles, but still appear in history marked as abandoned. Cleanup runs as a scheduled job, not on request.
- Player profile keying. Profiles are keyed by a durable device identity, not by display name. A second signed httpOnly cookie holds a long lived `player_id` that is independent of any single game seat. The first join on a device creates the `qwixx.players` row. Later games on that device reuse it, so lifetime stats accumulate. The display name defaults to the last one used on that device and stays editable per game. Merging one person's profiles across two devices is out of scope for v1.

## Status

accepted
