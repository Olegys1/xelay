-- Owners control visibility only. Earned badges and payment data remain server-derived.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table public.supporter_badge_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  show_tier boolean not null default true,
  show_six_seven boolean not null default true
);
alter table public.supporter_badge_preferences enable row level security;
revoke all on public.supporter_badge_preferences from public,anon,authenticated,service_role;
grant select on public.supporter_badge_preferences to authenticated;
create policy "Read own supporter badge preferences" on public.supporter_badge_preferences
  for select to authenticated using(user_id=(select auth.uid()));

create function public.xelay_my_supporter_badges()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select jsonb_build_object(
    'tier',public.xelay_private_supporter_tier(e.total), 'sixSeven',e.secret,
    'showTier',coalesce(p.show_tier,true), 'showSixSeven',coalesce(p.show_six_seven,true))
  into v_result from (
    select coalesce(sum(amount_kopiykas),0)::bigint as total,
      coalesce(bool_or(amount_kopiykas=6700),false) as secret
    from public.support_orders where user_id=v_user and mode='live' and status='approved'
  ) e left join public.supporter_badge_preferences p on p.user_id=v_user;
  return v_result;
end $$;

create function public.xelay_set_my_supporter_badges(p_show_tier boolean,p_show_six_seven boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_show_tier is null or p_show_six_seven is null then
    raise exception 'Visibility must be boolean' using errcode='22023';
  end if;
  insert into public.supporter_badge_preferences(user_id,show_tier,show_six_seven)
    values(v_user,p_show_tier,p_show_six_seven)
    on conflict(user_id) do update set show_tier=excluded.show_tier,show_six_seven=excluded.show_six_seven;
  return public.xelay_my_supporter_badges();
end $$;

create or replace function public.xelay_supporter_badges(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'tier',case when coalesce(p.show_tier,true) then public.xelay_private_supporter_tier(e.total) else 0 end,
    'sixSeven',e.secret and coalesce(p.show_six_seven,true))
  from (
    select coalesce(sum(amount_kopiykas),0)::bigint as total,
      coalesce(bool_or(amount_kopiykas=6700),false) as secret
    from public.support_orders where user_id=p_user_id and mode='live' and status='approved'
  ) e left join public.supporter_badge_preferences p on p.user_id=p_user_id;
$$;

-- Older clients must respect the owner's choice too.
create or replace function public.xelay_supporter_tier(p_user_id uuid)
returns smallint language sql stable security definer set search_path='' as $$
  select (public.xelay_supporter_badges(p_user_id)->>'tier')::smallint;
$$;
create or replace function public.xelay_supporter_badge(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_supporter_tier(p_user_id)>0;
$$;

revoke all on function public.xelay_my_supporter_badges(),public.xelay_set_my_supporter_badges(boolean,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_supporter_badges(),public.xelay_set_my_supporter_badges(boolean,boolean) to authenticated;

comment on table public.supporter_badge_preferences is 'Private own-account display switches. Does not grant earned badges, subscriptions or academic access. No client direct writes.';
comment on function public.xelay_supporter_badges(uuid) is 'Only owner-selected earned badges. Hidden tier is 0; hidden secret is false. No exact totals, dates or history.';
commit;
