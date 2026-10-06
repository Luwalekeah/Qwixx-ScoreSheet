create or replace function qwixx.cleanup_abandoned()
returns table (lobbies_deleted int, games_abandoned int, rate_rows_deleted int)
language plpgsql
security definer
set search_path = qwixx, public
as $$
declare
  l int; a int; r int;
begin
  -- A lobby with no start after 24 hours is deleted outright.
  with d as (
    delete from qwixx.games
    where status = 'lobby' and created_at < now() - interval '24 hours'
    returning 1
  ) select count(*)::int into l from d;

  -- An active game with no sheet write for 7 days is marked abandoned.
  with d as (
    update qwixx.games g
    set status = 'ended',
        ended_at = now(),
        end_reason = 'abandoned',
        winner_player_id = null
    where g.status = 'active'
      and coalesce(
            (select max(s.updated_at) from qwixx.sheets s where s.game_id = g.id),
            g.created_at
          ) < now() - interval '7 days'
    returning 1
  ) select count(*)::int into a from d;

  -- Rate limit windows older than one hour are dead weight.
  with d as (
    delete from qwixx.rate_limits
    where window_start < now() - interval '1 hour'
    returning 1
  ) select count(*)::int into r from d;

  return query select l, a, r;
end;
$$;

-- Scheduling qwixx.cleanup_abandoned() does NOT live in this file (finding
-- B3). It used to run `create extension pg_cron` and `cron.schedule(...)`
-- right here, against a Postgres instance shared with other cluster
-- services where pg_cron availability was never verified. If that
-- statement aborted, every migration after this one in the hand-applied,
-- filename-ordered, ON_ERROR_STOP=1 run never landed -- including
-- 0004_locked_rows_merge.sql, which every lock in the game depends on. One
-- unrelated, optional scheduling statement is not allowed to take that
-- down. The pg_cron attempt now lives in the last-numbered, explicitly
-- optional 0006_schedules.sql, and the actually-deployed path is the k3s
-- CronJob at namespaces/qwixx/cleanup-cronjob.yaml, documented in
-- .pipeline/infra-spec.md section 5.
