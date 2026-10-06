-- Fixes finding S1 (part 3). POST /api/games and GET /api/me both used to
-- call ensureDevice(), which inserts a qwixx.players row for any caller with
-- no valid device cookie -- including crawlers, link-preview bots, and
-- prefetch. qwixx.cleanup_abandoned() reclaims games, game_players and
-- sheets, but never players, so those rows only ever grew, in a Postgres
-- instance shared with other services. GET /api/me is now read-only and
-- POST /api/games is rate limited (see the route handlers), but rows
-- created before this fix, and any created by a caller who is throttled but
-- not blocked outright, still need to be reclaimed.
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

-- Scheduling (finding B3): the same reasoning as 0002_cleanup_jobs.sql
-- applies here. An in-database `cron.schedule` call is not allowed to sit
-- in the required path of a migration two files before
-- 0004_locked_rows_merge.sql. The optional pg_cron attempt lives in
-- 0006_schedules.sql; the deployed path is the k3s CronJob at
-- namespaces/qwixx/cleanup-cronjob.yaml (.pipeline/infra-spec.md section 5),
-- extended to call this function's RPC alongside cleanup_abandoned's.
