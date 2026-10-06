-- qwixx shares a Postgres instance with other services on the cluster, and
-- Kong's rest-v1 route admits the anon ACL group, so explicit grants are the
-- only control keeping an anon-key holder out of this schema. The grants
-- previously existed only as prose in .pipeline/infra-spec.md, applied by no
-- tool. The two functions defined so far (consume_rate_limit,
-- cleanup_abandoned) are SECURITY DEFINER and Postgres grants EXECUTE to
-- PUBLIC by default; that default was never revoked (finding S6).

grant usage on schema qwixx to service_role;
grant all on all tables    in schema qwixx to service_role;
grant all on all sequences in schema qwixx to service_role;
alter default privileges in schema qwixx grant all on tables to service_role;

revoke all on schema qwixx from anon, authenticated;

revoke execute on function qwixx.consume_rate_limit(text) from public, anon, authenticated;
grant  execute on function qwixx.consume_rate_limit(text) to service_role;

revoke execute on function qwixx.cleanup_abandoned() from public, anon, authenticated;
grant  execute on function qwixx.cleanup_abandoned() to service_role;
