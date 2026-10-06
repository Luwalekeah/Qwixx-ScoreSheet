create schema if not exists qwixx;

create table qwixx.players (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 24),
  created_at   timestamptz not null default now()
);

create table qwixx.games (
  id               uuid primary key default gen_random_uuid(),
  join_code        text not null check (join_code ~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$'),
  status           text not null default 'lobby' check (status in ('lobby','active','ended')),
  created_at       timestamptz not null default now(),
  ended_at         timestamptz,
  end_reason       text check (end_reason in ('penalties','two_locks','abandoned','host_ended')),
  winner_player_id uuid references qwixx.players(id),
  locked_rows      jsonb not null default '{"red":null,"yellow":null,"green":null,"blue":null}'::jsonb,
  constraint games_ended_consistency check (
    (status = 'ended' and ended_at is not null and end_reason is not null)
    or (status <> 'ended' and ended_at is null and end_reason is null)
  )
);

create table qwixx.game_players (
  game_id     uuid not null references qwixx.games(id) on delete cascade,
  player_id   uuid not null references qwixx.players(id) on delete cascade,
  seat        int  not null check (seat between 1 and 5),
  claimed_at  timestamptz not null default now(),
  final_score int,
  primary key (game_id, player_id)
);

create table qwixx.sheets (
  game_id    uuid not null references qwixx.games(id) on delete cascade,
  player_id  uuid not null references qwixx.players(id) on delete cascade,
  crosses    jsonb not null default '{"red":[],"yellow":[],"green":[],"blue":[]}'::jsonb,
  locks      jsonb not null default '{"red":false,"yellow":false,"green":false,"blue":false}'::jsonb,
  penalties  int  not null default 0 check (penalties between 0 and 4),
  updated_at timestamptz not null default now(),
  version    int  not null default 0,
  primary key (game_id, player_id),
  foreign key (game_id, player_id) references qwixx.game_players(game_id, player_id) on delete cascade
);

create table qwixx.rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (bucket_key, window_start)
);

-- A live game's code must be unique. An ended game releases its code, which is
-- also what makes the code stop resolving for join.
create unique index games_join_code_live_uniq
  on qwixx.games (join_code)
  where status <> 'ended';

create unique index game_players_seat_uniq
  on qwixx.game_players (game_id, seat);

create index game_players_player_idx
  on qwixx.game_players (player_id);

create index games_status_created_idx
  on qwixx.games (status, created_at);

create index games_ended_at_idx
  on qwixx.games (ended_at desc) where status = 'ended';

create index sheets_game_updated_idx
  on qwixx.sheets (game_id, updated_at desc);

create index rate_limits_window_idx
  on qwixx.rate_limits (window_start);

-- Atomic fixed-window increment, callable through supabase-js as an RPC
-- because PostgREST has no raw parameterised SQL endpoint. This is the
-- literal upsert from the join rate limit design, wrapped so it can be
-- called in one round trip.
create or replace function qwixx.consume_rate_limit(p_bucket_key text)
returns int
language sql
security definer
set search_path = qwixx, public
as $$
  insert into qwixx.rate_limits (bucket_key, window_start, count)
  values (p_bucket_key, date_trunc('minute', now()), 1)
  on conflict (bucket_key, window_start)
  do update set count = qwixx.rate_limits.count + 1
  returning count;
$$;
