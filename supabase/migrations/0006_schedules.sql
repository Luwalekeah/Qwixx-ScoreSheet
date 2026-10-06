-- OPTIONAL. Finding B3. This migration may be skipped entirely -- nothing
-- in the request path depends on it. The documented, actually-deployed
-- cleanup path is the k3s CronJob at namespaces/qwixx/cleanup-cronjob.yaml
-- (.pipeline/infra-spec.md section 5), which calls the PostgREST RPC
-- endpoints for qwixx.cleanup_abandoned() and qwixx.cleanup_orphan_players()
-- directly and needs no Postgres extension. This file exists only for a
-- future environment where pg_cron is confirmed available and someone
-- prefers an in-database schedule over the CronJob.
--
-- pg_cron availability on supabase/postgres:15.8.1.085 was never verified
-- for this project (.pipeline/infra-spec.md section "pg_cron: unverified,
-- use the CronJob"). Before applying this file by choice, check first:
--
--   select name, default_version, installed_version
--   from pg_available_extensions where name = 'pg_cron';
--   show shared_preload_libraries;
--
-- pg_cron needs both a preloaded shared library and a database restart to
-- enable if it is not already preloaded -- a shared-component change to the
-- cluster's only Postgres, not something this migration should force.
--
-- Even so, every statement here is wrapped so a failure (missing
-- extension, missing preload, wrong cron.database_name) raises a NOTICE
-- and moves on rather than aborting. That holds whether this file is
-- applied deliberately, on its own, or picked up automatically by a
-- `for f in supabase/migrations/*.sql` loop that does not know it is
-- optional -- the previous version of this schedule attempt ran
-- unconditionally from inside 0002_cleanup_jobs.sql, and its potential
-- failure could have taken 0004_locked_rows_merge.sql down with it.

do $$
begin
  execute 'create extension if not exists pg_cron';
exception
  when others then
    raise notice 'pg_cron extension unavailable, skipping in-database schedule (using the k3s CronJob instead): %', sqlerrm;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('qwixx-cleanup', '7 * * * *', $sched$select qwixx.cleanup_abandoned();$sched$);
    perform cron.schedule('qwixx-cleanup-orphans', '23 * * * *', $sched$select qwixx.cleanup_orphan_players();$sched$);
  else
    raise notice 'pg_cron not installed, skipping schedule registration (using the k3s CronJob instead)';
  end if;
exception
  when others then
    raise notice 'pg_cron schedule registration failed, using the k3s CronJob instead: %', sqlerrm;
end;
$$;
