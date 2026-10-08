-- Three consecutive primary answers on a subject now trigger a recommendation,
-- never a prohibition. Keep existing reservation history and every access,
-- capacity, format, chronology and concurrency check in the calling functions.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.study_group_seminars') is null
    or to_regclass('public.study_group_seminar_reservations') is null
    or to_regprocedure('public.xelay_lock_seminar_group(uuid,boolean)') is null
    or to_regprocedure('public.xelay_seminar_streak_internal(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_seminar_streak(uuid,uuid)') is null
    or to_regprocedure('public.xelay_reserve_seminar(uuid,text,uuid)') is null
    or not exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.xelay_assert_seminar_streaks(uuid,uuid)')
        and prorettype = 'void'::regtype
        and prosecdef and provolatile = 'v'
    )
  then
    raise exception 'Apply group seminar migrations before seminar rotation recommendations';
  end if;
end;
$$;

-- Preserve this internal signature for all existing mutation paths, including
-- cancellation, schedule changes and deletion of assignments/questions. These
-- operations must not fail because a later primary reservation exceeds a streak.
-- CREATE OR REPLACE retains the function owner and existing EXECUTE privileges;
-- no table, row policy, reservation or public RPC permission is changed here.
create or replace function public.xelay_assert_seminar_streaks(
  p_group_id uuid, p_primary_attempt_id uuid default null
)
returns void language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
begin
  -- The authenticated, group-locked calling functions enforce actual access,
  -- valid roles, start-time restrictions, capacity and atomic selection changes.
  -- Rotation of primary/supplement roles is advisory and needs no write guard.
  return;
end;
$$;

comment on function public.xelay_assert_seminar_streaks(uuid,uuid) is
  'Compatibility no-op: primary-answer rotation is a recommendation only. Reservation and management callers retain their existing authorization, locking, capacity, format and start-time checks. Question-format streaks remain available through the member-scoped xelay_seminar_streak RPC.';

-- xelay_seminar_streak_internal already returns the full consecutive count and
-- includes questions only. Leave its subject scoping and reset rules unchanged:
-- supplements and missed past questions reset; teams/booking do not contribute.
commit;
