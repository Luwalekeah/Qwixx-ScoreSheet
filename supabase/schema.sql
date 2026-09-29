-- Saved games for the ScoreSheet apps (Quiddler, Qwixx).
--
-- PROPOSAL: nothing here has been run against a live Supabase project. Review it, then paste it into
-- the Supabase SQL editor. It is safe to run more than once. One project can serve both apps.
--
-- Access model
--   * The Streamlit server holds SUPABASE_URL and SUPABASE_KEY (the anon / publishable key). They are
--     never sent to the browser.
--   * The table has row level security turned on and NO policies, so the anon and authenticated roles
--     cannot select, insert, update or delete rows directly.
--   * The only way in is the two functions below (security definer). Both require the game's id, a
--     random uuid that the app puts in the page URL. So a caller can read and write a game whose id
--     they hold, but cannot list, search or count games.
--   * Anyone with a game's link can view and edit that game. Rows hold player names and scores only.
--
-- There are no user accounts, so this saves and resumes games; it cannot list "my past games".
-- If you want a history page later, add an owner_id (references auth.users) and policies for it.

create table if not exists public.games (
  id          uuid        primary key,
  app         text        not null check (app in ('quiddler', 'qwixx')),
  state       jsonb       not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 16384),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists games_updated_at_idx on public.games (updated_at);

alter table public.games enable row level security;
-- Deliberately no policies: direct table access stays closed.


-- Returns the saved state for a game, or null if there is no such game for that app.
create or replace function public.load_game(p_app text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select g.state
  from public.games as g
  where g.id = p_id and g.app = p_app;
$$;

-- Creates the game or replaces its state. Cannot touch a game that belongs to a different app.
create or replace function public.save_game(p_app text, p_id uuid, p_state jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.games as g (id, app, state)
  values (p_id, p_app, p_state)
  on conflict (id) do update
    set state = excluded.state,
        updated_at = now()
    where g.app = excluded.app;
$$;

-- Functions are executable by everyone by default; allow only the anon role that the app uses.
revoke all on function public.load_game(text, uuid) from public, anon, authenticated;
revoke all on function public.save_game(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.load_game(text, uuid) to anon;
grant execute on function public.save_game(text, uuid, jsonb) to anon;


-- Optional retention (needs the pg_cron extension, Database > Extensions): drop games untouched for 90 days.
-- select cron.schedule(
--   'games-retention', '17 3 * * *',
--   $$ delete from public.games where updated_at < now() - interval '90 days' $$
-- );
