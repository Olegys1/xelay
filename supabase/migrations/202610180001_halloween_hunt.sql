-- Scheduled Halloween hunt. Installing this migration never collects pumpkins,
-- grants access, creates a payment or sends a historical notification.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$ begin
  if to_regclass('public.profiles') is null or to_regclass('public.notifications') is null
    or to_regclass('public.participant_entitlements') is null or to_regclass('public.billing_audit_log') is null
    or to_regprocedure('public.xelay_reflow_participant_access(uuid)') is null
    or not exists(select 1 from information_schema.columns where table_schema='auth'
      and table_name='users' and column_name='banned_until') then
    raise exception 'HALLOWEEN_PREREQUISITES_MISSING';
  end if;
end $$;

-- This counter is permanent: deleting an account cannot reopen a prize slot.
create table public.halloween_2026_campaign (
  singleton boolean primary key default true check(singleton),
  winners_claimed smallint not null default 0 check(winners_claimed between 0 and 10)
);
insert into public.halloween_2026_campaign(singleton) values(true);
create table public.halloween_2026_collections (
  user_id uuid not null references public.profiles(id) on delete cascade,
  pumpkin_id text not null check(pumpkin_id in(
    'home','questions','news','groups','people','messages','support','opportunities','subscription','profile')),
  collected_at timestamptz not null default clock_timestamp(),
  primary key(user_id,pumpkin_id)
);
create table public.halloween_2026_rewards (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  completed_at timestamptz not null,
  show_badge boolean not null default true,
  subscription_slot smallint unique check(subscription_slot between 1 and 10),
  entitlement_id uuid unique references public.participant_entitlements(id) on delete set null
);
alter table public.halloween_2026_campaign enable row level security;
alter table public.halloween_2026_collections enable row level security;
alter table public.halloween_2026_rewards enable row level security;
revoke all on public.halloween_2026_campaign,public.halloween_2026_collections,public.halloween_2026_rewards
  from public,anon,authenticated,service_role;

-- No caller-controlled clock, campaign dates, recipient or progress count.
-- The private clock seam lets the isolated database tests exercise DST/boundaries.
create function public.xelay_private_halloween_clock()
returns timestamptz language sql volatile security invoker set search_path='' as $$
  select pg_catalog.clock_timestamp();
$$;

create function public.xelay_my_halloween_hunt()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_now timestamptz:=public.xelay_private_halloween_clock();
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return (
    select jsonb_build_object(
      'campaignId','halloween-2026',
      'startsAt','2026-10-18T09:00:00.000Z','endsAt','2026-11-01T22:00:00.000Z',
      'serverNow',v_now,
      'eligible',u.id is not null and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=v_now and u.email_confirmed_at is not null
        and exists(select 1 from public.profiles where id=v_user),
      'ineligibleReason',case when u.id is null or u.deleted_at is not null or coalesce(u.banned_until,'-infinity'::timestamptz)>v_now
        or not exists(select 1 from public.profiles where id=v_user) then 'account_unavailable'
        when u.email_confirmed_at is null then 'email_unconfirmed' else null end,
      'phase',case when v_now<'2026-10-18 09:00:00+00'::timestamptz then 'upcoming'
        when v_now<'2026-11-01 22:00:00+00'::timestamptz then 'active' else 'ended' end,
      'collected',coalesce((select jsonb_agg(c.pumpkin_id order by array_position(
        array['home','questions','news','groups','people','messages','support','opportunities','subscription','profile'],c.pumpkin_id))
        from public.halloween_2026_collections c where c.user_id=v_user),'[]'::jsonb),
      'completed',r.user_id is not null,'completedAt',r.completed_at,
      'badgeEarned',r.user_id is not null,'showBadge',coalesce(r.show_badge,true),
      'subscriptionWon',r.subscription_slot is not null,
      'subscriptionStartsAt',e.valid_from,'subscriptionEndsAt',e.valid_until,
      'winnersRemaining',10-campaign.winners_claimed)
    from public.halloween_2026_campaign campaign
    left join auth.users u on u.id=v_user
    left join public.halloween_2026_rewards r on r.user_id=v_user
    left join public.participant_entitlements e on e.id=r.entitlement_id
    where campaign.singleton
  );
end $$;

create function public.xelay_collect_halloween_pumpkin(p_pumpkin_id text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_user uuid:=auth.uid(); v_now timestamptz; v_count integer; v_claimed smallint;
  v_slot smallint; v_from timestamptz; v_until timestamptz; v_entitlement uuid;
  v_completed boolean:=false;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_pumpkin_id is null or p_pumpkin_id not in(
    'home','questions','news','groups','people','messages','support','opportunities','subscription','profile') then
    raise exception 'HALLOWEEN_UNKNOWN_PUMPKIN' using errcode='22023';
  end if;
  if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=v_user and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_halloween_clock()) then
    raise exception 'Active account required' using errcode='42501';
  end if;
  if not exists(select 1 from auth.users where id=v_user and email_confirmed_at is not null) then
    raise exception 'HALLOWEEN_EMAIL_UNCONFIRMED' using errcode='42501';
  end if;
  -- Same-account tabs cannot race the last two distinct pickups or duplicate a reward.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:halloween-2026:'||v_user::text,0));
  if exists(select 1 from public.halloween_2026_collections where user_id=v_user and pumpkin_id=p_pumpkin_id) then
    return public.xelay_my_halloween_hunt()||jsonb_build_object('newlyCollected',false,'newlyCompleted',false);
  end if;
  v_now:=public.xelay_private_halloween_clock();
  if v_now<'2026-10-18 09:00:00+00'::timestamptz then
    raise exception 'HALLOWEEN_NOT_STARTED' using errcode='22023';
  elsif v_now>='2026-11-01 22:00:00+00'::timestamptz then
    raise exception 'HALLOWEEN_ENDED' using errcode='22023';
  end if;
  if exists(select 1 from public.halloween_2026_collections where user_id=v_user
    and collected_at>v_now-interval '2 seconds') then
    raise exception 'HALLOWEEN_TOO_FAST' using errcode='22023';
  end if;
  insert into public.halloween_2026_collections(user_id,pumpkin_id,collected_at) values(v_user,p_pumpkin_id,v_now);
  select count(*) into v_count from public.halloween_2026_collections where user_id=v_user;
  if v_count=10 then
    -- One shared row serializes all finishers; the counter and entitlement commit together.
    select winners_claimed into v_claimed from public.halloween_2026_campaign where singleton for update;
    v_now:=public.xelay_private_halloween_clock();
    if v_now>='2026-11-01 22:00:00+00'::timestamptz then
      raise exception 'HALLOWEEN_ENDED' using errcode='22023';
    end if;
    if v_claimed<10 then
      v_slot:=v_claimed+1;
      update public.halloween_2026_campaign set winners_claimed=v_slot where singleton;
      -- Match the exact billing lock and existing access reflow. Never create an order/payment.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:premium:'||v_user::text,0));
      perform public.xelay_reflow_participant_access(v_user);
      select greatest(v_now,coalesce(max(valid_until),v_now)) into v_from
        from public.participant_entitlements where user_id=v_user and revoked_at is null and valid_until>v_now;
      v_until:=((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv';
      insert into public.participant_entitlements(user_id,source,term_months,valid_from,valid_until)
        values(v_user,'admin_grant',1,v_from,v_until) returning id into v_entitlement;
      insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
        values(v_user,'halloween_reward',v_user,jsonb_build_object('campaign','halloween-2026','months',1,'slot',v_slot));
    end if;
    insert into public.halloween_2026_rewards(user_id,completed_at,subscription_slot,entitlement_id)
      values(v_user,v_now,v_slot,v_entitlement);
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read)
      values(v_user,v_user,'Xelay','halloween_reward',case when v_slot is not null then
        'Вітаємо! Ви зібрали 10 гарбузиків, отримали сяйний бейдж і місяць «Учасника». Якщо підписка вже активна, подарунковий місяць додано після неї.'
        else 'Вітаємо! Ви зібрали 10 гарбузиків та отримали сяйний бейдж. Перші 10 подарункових підписок уже розібрали, але ваш бейдж залишиться з вами.' end,false);
    v_completed:=true;
  end if;
  return public.xelay_my_halloween_hunt()||jsonb_build_object('newlyCollected',true,'newlyCompleted',v_completed);
end $$;

create function public.xelay_set_my_halloween_badge(p_visible boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_visible is null then raise exception 'Visibility must be boolean' using errcode='22023'; end if;
  update public.halloween_2026_rewards set show_badge=p_visible where user_id=v_user;
  if not found then raise exception 'HALLOWEEN_BADGE_NOT_EARNED' using errcode='22023'; end if;
  return public.xelay_my_halloween_hunt();
end $$;

create function public.xelay_halloween_badge(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.halloween_2026_rewards where user_id=p_user_id and show_badge);
$$;

-- Clients may mark their genuine reward read; they cannot fabricate congratulations
-- or edit their content. Existing notification types keep their existing policies.
create policy "Halloween reward notifications server insert" on public.notifications as restrictive
  for insert to anon,authenticated with check(coalesce(type,'')<>'halloween_reward');
create function public.xelay_guard_halloween_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (old.type='halloween_reward' and (to_jsonb(new)-'is_read') is distinct from (to_jsonb(old)-'is_read'))
    or (old.type is distinct from 'halloween_reward' and new.type='halloween_reward') then
    raise exception 'HALLOWEEN_NOTIFICATION_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
create trigger halloween_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_halloween_notification_update();

revoke all on function public.xelay_private_halloween_clock(),public.xelay_my_halloween_hunt(),
  public.xelay_collect_halloween_pumpkin(text),public.xelay_set_my_halloween_badge(boolean),
  public.xelay_halloween_badge(uuid),public.xelay_guard_halloween_notification_update()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_halloween_hunt(),public.xelay_collect_halloween_pumpkin(text),
  public.xelay_set_my_halloween_badge(boolean) to authenticated;
grant execute on function public.xelay_halloween_badge(uuid) to anon,authenticated,service_role;

comment on table public.halloween_2026_rewards is 'Permanent 2026 campaign completion. Public lookup exposes only visible earned badge; no rank, identity list or private progress.';
comment on function public.xelay_collect_halloween_pumpkin(text) is 'Own authenticated account only; server time window, fixed ten IDs, unique pickups, serialized first ten monthly access rewards. Not an anti-multi-account or physical-page-visit attestation.';
commit;
