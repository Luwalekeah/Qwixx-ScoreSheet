-- Fixes finding C2: games.locked_rows was updated with a bare
-- `update ... .eq('id', game.id)` read-modify-write and no compare-and-swap.
-- Two players locking two different colours in overlapping requests both
-- computed from the same stale base, and the second write silently erased
-- the first's colour: the row reopened for everyone even though its owner
-- kept the points, and the two-locks game-end condition could go dead for
-- the rest of that game.
--
-- This does a per-colour CAS inside one atomic UPDATE: a key is only
-- overwritten with the caller's new value (p_next) if the row's CURRENT
-- value for that key still matches what the caller originally read
-- (p_prev). If a concurrent writer already changed that key since the
-- caller's read, the concurrent writer's value is kept and the caller's
-- change to that one key is dropped -- its own request response already
-- carries the merged, authoritative result to reconcile against. Keys the
-- caller did not intend to change (p_prev[k] = p_next[k]) are always a
-- same-value no-op CAS and never at risk.
create or replace function qwixx.merge_locked_rows(p_game_id uuid, p_prev jsonb, p_next jsonb)
returns jsonb
language sql
security definer
set search_path = qwixx, public
as $$
  update qwixx.games g
  set locked_rows = (
    select jsonb_object_agg(
      k,
      case when g.locked_rows -> k = p_prev -> k then p_next -> k else g.locked_rows -> k end
    )
    from jsonb_object_keys(g.locked_rows) as k
  )
  where g.id = p_game_id
  returning locked_rows;
$$;

revoke execute on function qwixx.merge_locked_rows(uuid, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function qwixx.merge_locked_rows(uuid, jsonb, jsonb) to service_role;
