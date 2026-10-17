-- Decorative profile switches only. Roles, verification and paid access are
-- deliberately not read or changed by these RPCs.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table public.profile_badge_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  show_participant boolean not null default true,
  show_teacher boolean not null default true
);
alter table public.profile_badge_preferences enable row level security;
revoke all on public.profile_badge_preferences from public,anon,authenticated,service_role;

create function public.xelay_profile_badge_preferences(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'showParticipant',coalesce((select p.show_participant from public.profile_badge_preferences p where p.user_id=p_user_id),true),
    'showTeacher',coalesce((select p.show_teacher from public.profile_badge_preferences p where p.user_id=p_user_id),true)
  );
$$;

create function public.xelay_set_my_profile_badges(p_show_participant boolean,p_show_teacher boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_show_participant is null or p_show_teacher is null then
    raise exception 'Visibility must be boolean' using errcode='22023';
  end if;
  insert into public.profile_badge_preferences(user_id,show_participant,show_teacher)
    values(v_user,p_show_participant,p_show_teacher)
    on conflict(user_id) do update set
      show_participant=excluded.show_participant,show_teacher=excluded.show_teacher;
  return public.xelay_profile_badge_preferences(v_user);
end;
$$;

revoke all on function public.xelay_profile_badge_preferences(uuid),
  public.xelay_set_my_profile_badges(boolean,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_profile_badge_preferences(uuid) to anon,authenticated,service_role;
grant execute on function public.xelay_set_my_profile_badges(boolean,boolean) to authenticated;

comment on table public.profile_badge_preferences is
  'Private display switches. Never grants or revokes participant access, verified teaching status or other roles. No direct client table access.';
comment on function public.xelay_profile_badge_preferences(uuid) is
  'Public decorative visibility booleans only. Missing and unknown accounts return identical defaults, without roles, entitlements or verification data.';
comment on function public.xelay_set_my_profile_badges(boolean,boolean) is
  'Authenticated own-account display switches only. The target is always auth.uid(); both values must be non-null booleans.';
commit;
