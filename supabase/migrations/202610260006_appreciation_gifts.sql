-- Installing this mechanism offers/grants nothing. A verified MFA administrator
-- explicitly offers one community appreciation gift; its recipient claims it.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
declare v_constraint record;v_allowed boolean;
begin
  if to_regclass('public.birthday_gifts') is null or to_regclass('public.appreciation_gifts') is not null
    or to_regclass('public.participant_entitlements') is null or to_regclass('public.billing_audit_log') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_reflow_participant_access(uuid)') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.notifications'::regclass and tgname='notification_email_queue'
      and not tgisinternal and tgfoid='public.xelay_queue_notification_email()'::regprocedure
      and tgtype=5 and tgenabled='O' and tgnargs=0
      and position('WHEN ((new.type IS DISTINCT FROM ''birthday_gift''::text))' in pg_get_triggerdef(oid))>0) then
    raise exception 'APPRECIATION_GIFT_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
  for v_constraint in select conname,pg_get_expr(conbin,conrelid) expression from pg_constraint
    where conrelid='public.notifications'::regclass and contype='c' loop
    execute format('select ((%s) is not false) from jsonb_populate_record(null::public.notifications,$1)',v_constraint.expression)
      into v_allowed using jsonb_build_object('id','00000000-0000-0000-0000-000000000001',
        'recipient_id','00000000-0000-0000-0000-000000000002','actor_id','00000000-0000-0000-0000-000000000003',
        'actor_name','Xelay','type','appreciation_gift','message','Community appreciation gift','is_read',false,'created_at',clock_timestamp());
    if not coalesce(v_allowed,false) then raise exception 'APPRECIATION_GIFT_NOTIFICATION_CHECK_UNSUPPORTED: %',v_constraint.conname;end if;
  end loop;
end $preflight$;

create table public.appreciation_gifts(
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null unique references public.profiles(id) on delete cascade,
  greeting_name text not null default '' check(length(greeting_name)<=80 and greeting_name=btrim(greeting_name) and greeting_name!~'[[:cntrl:]]'),
  badge_key text not null default 'community_spark' check(badge_key='community_spark'),
  badge_visible boolean not null default true,
  notification_id uuid not null unique references public.notifications(id) on delete restrict,
  offered_by uuid references public.profiles(id) on delete set null,
  offered_at timestamptz not null,
  claimed_at timestamptz,
  entitlement_id uuid unique references public.participant_entitlements(id) on delete restrict,
  check((claimed_at is null and entitlement_id is null) or(claimed_at is not null and entitlement_id is not null))
);
alter table public.appreciation_gifts enable row level security;
revoke all on public.appreciation_gifts from public,anon,authenticated,service_role;

create function public.xelay_private_appreciation_gift_clock()
returns timestamptz language sql volatile security invoker set search_path='' as $$select pg_catalog.clock_timestamp()$$;

create function public.xelay_private_appreciation_gift_json(p_gift_id uuid,p_newly_claimed boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',g.id,'notification_id',g.notification_id,'recipient_name',g.greeting_name,
    'badge_key',g.badge_key,'badge_name','Іскра Xelay','badge_earned',g.claimed_at is not null,'badge_visible',g.badge_visible,
    'offered_at',g.offered_at,'claimed_at',g.claimed_at,'valid_from',e.valid_from,'valid_until',e.valid_until,'newly_claimed',p_newly_claimed)
  from public.appreciation_gifts g left join public.participant_entitlements e on e.id=g.entitlement_id where g.id=p_gift_id;
$$;

create function public.xelay_my_appreciation_gifts()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null then raise exception 'APPRECIATION_GIFT_AUTH_REQUIRED' using errcode='42501';end if;
  return coalesce((select jsonb_agg(public.xelay_private_appreciation_gift_json(g.id,false) order by g.offered_at desc,g.id)
    from(select id,offered_at from public.appreciation_gifts where recipient_id=v_uid order by offered_at desc,id limit 20) g),'[]'::jsonb);
end $$;

create function public.xelay_admin_offer_appreciation_gift(p_user_id uuid,p_greeting_name text default '')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_now timestamptz;v_gift uuid;v_notification uuid;v_name text:=btrim(coalesce(p_greeting_name,''));
begin
  if v_actor is null or not public.xelay_is_platform_admin() or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from auth.mfa_factors f where f.user_id=v_actor and f.status='verified')
    or not exists(select 1 from auth.users u where u.id=v_actor and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_appreciation_gift_clock()) then
    raise exception 'APPRECIATION_GIFT_ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if length(v_name)>80 or v_name~'[[:cntrl:]]' then raise exception 'APPRECIATION_GIFT_GREETING_INVALID' using errcode='22023';end if;
  if p_user_id is null or not exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=p_user_id and u.deleted_at is null and u.email_confirmed_at is not null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_appreciation_gift_clock()) then
    raise exception 'APPRECIATION_GIFT_ACCOUNT_UNAVAILABLE' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:appreciation-gift:'||p_user_id::text||':community_spark',0));
  select id into v_gift from public.appreciation_gifts where recipient_id=p_user_id;
  if found then return public.xelay_private_appreciation_gift_json(v_gift,false);end if;
  v_now:=public.xelay_private_appreciation_gift_clock();
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,created_at)
    values(p_user_id,v_actor,'Xelay','appreciation_gift',
      'Дякуємо, що розповідаєте про Xelay та допомагаєте нашій спільноті зростати! Для вас — відзнака «Іскра Xelay» та місяць підписки «Учасник». Відкрийте сповіщення, щоб отримати подарунок.',false,v_now)
    returning id into v_notification;
  insert into public.appreciation_gifts(recipient_id,greeting_name,notification_id,offered_by,offered_at)
    values(p_user_id,v_name,v_notification,v_actor,v_now) returning id into v_gift;
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
    values(v_actor,'appreciation_gift_offer',p_user_id,jsonb_build_object('gift_id',v_gift,'badge_key','community_spark','months',1));
  return public.xelay_private_appreciation_gift_json(v_gift,false);
end $$;

create function public.xelay_claim_appreciation_gift(p_gift_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_gift public.appreciation_gifts%rowtype;v_now timestamptz;v_from timestamptz;v_until timestamptz;v_entitlement uuid;
begin
  if v_uid is null then raise exception 'APPRECIATION_GIFT_AUTH_REQUIRED' using errcode='42501';end if;
  select * into v_gift from public.appreciation_gifts where id=p_gift_id and recipient_id=v_uid for update;
  if not found then raise exception 'APPRECIATION_GIFT_UNAVAILABLE' using errcode='42501';end if;
  if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=v_uid
    and u.deleted_at is null and u.email_confirmed_at is not null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_appreciation_gift_clock()) then
    raise exception 'APPRECIATION_GIFT_ACCOUNT_UNAVAILABLE' using errcode='42501';
  end if;
  update public.notifications set is_read=true where id=v_gift.notification_id and recipient_id::text=v_uid::text
    and type='appreciation_gift' and not coalesce(is_read,false);
  if v_gift.claimed_at is not null then return public.xelay_private_appreciation_gift_json(v_gift.id,false);end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:premium:'||v_uid::text,0));
  perform public.xelay_reflow_participant_access(v_uid);
  v_now:=public.xelay_private_appreciation_gift_clock();
  select greatest(v_now,coalesce(max(valid_until),v_now)) into v_from from public.participant_entitlements
    where user_id=v_uid and revoked_at is null and valid_until>v_now;
  v_until:=((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv';
  insert into public.participant_entitlements(user_id,source,term_months,valid_from,valid_until)
    values(v_uid,'admin_grant',1,v_from,v_until) returning id into v_entitlement;
  update public.appreciation_gifts set claimed_at=v_now,entitlement_id=v_entitlement where id=v_gift.id;
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
    values(v_uid,'appreciation_gift_claim',v_uid,jsonb_build_object('gift_id',v_gift.id,'badge_key','community_spark','months',1,
      'entitlement_id',v_entitlement,'valid_from',v_from,'valid_until',v_until));
  return public.xelay_private_appreciation_gift_json(v_gift.id,true);
end $$;

-- This public endpoint reveals only a decorative boolean. Hidden, unearned and
-- unknown accounts are indistinguishable; no gift or subscription dates escape.
create function public.xelay_appreciation_badge(p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.appreciation_gifts where recipient_id=p_user_id and claimed_at is not null and badge_visible);
$$;
create function public.xelay_my_appreciation_badge()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_gift public.appreciation_gifts%rowtype;
begin
  if v_uid is null then raise exception 'APPRECIATION_GIFT_AUTH_REQUIRED' using errcode='42501';end if;
  select * into v_gift from public.appreciation_gifts where recipient_id=v_uid;
  return jsonb_build_object('badge_key','community_spark','badge_name','Іскра Xelay','earned',v_gift.claimed_at is not null,'visible',coalesce(v_gift.badge_visible,true));
end $$;
create function public.xelay_set_my_appreciation_badge(p_visible boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_gift public.appreciation_gifts%rowtype;
begin
  if v_uid is null then raise exception 'APPRECIATION_GIFT_AUTH_REQUIRED' using errcode='42501';end if;
  if p_visible is null then raise exception 'APPRECIATION_GIFT_VISIBILITY_INVALID' using errcode='22023';end if;
  select * into v_gift from public.appreciation_gifts where recipient_id=v_uid for update;
  if not found or v_gift.claimed_at is null then raise exception 'APPRECIATION_GIFT_BADGE_NOT_EARNED' using errcode='42501';end if;
  update public.appreciation_gifts set badge_visible=p_visible where id=v_gift.id;
  return public.xelay_my_appreciation_badge();
end $$;

create policy "Appreciation gift notifications server insert" on public.notifications as restrictive
  for insert to anon,authenticated with check(type is distinct from 'appreciation_gift');
create function public.xelay_guard_appreciation_gift_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if(old.type='appreciation_gift' and(to_jsonb(new)-'is_read') is distinct from(to_jsonb(old)-'is_read'))
    or(old.type is distinct from 'appreciation_gift' and new.type='appreciation_gift') then
    raise exception 'APPRECIATION_GIFT_NOTIFICATION_IMMUTABLE' using errcode='42501';end if;
  return new;
end $$;
create trigger appreciation_gift_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_appreciation_gift_notification_update();

-- Preserve the queue function and every other type, including the birthday
-- exclusion. This new gift has only the explicit in-app notification above.
drop trigger notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row when(new.type is distinct from 'birthday_gift' and new.type is distinct from 'appreciation_gift')
  execute function public.xelay_queue_notification_email();

revoke all on function public.xelay_private_appreciation_gift_clock(),public.xelay_private_appreciation_gift_json(uuid,boolean),
  public.xelay_my_appreciation_gifts(),public.xelay_admin_offer_appreciation_gift(uuid,text),public.xelay_claim_appreciation_gift(uuid),
  public.xelay_appreciation_badge(uuid),public.xelay_my_appreciation_badge(),public.xelay_set_my_appreciation_badge(boolean),
  public.xelay_guard_appreciation_gift_notification_update() from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_appreciation_gifts(),public.xelay_admin_offer_appreciation_gift(uuid,text),
  public.xelay_claim_appreciation_gift(uuid),public.xelay_my_appreciation_badge(),public.xelay_set_my_appreciation_badge(boolean) to authenticated;
grant execute on function public.xelay_appreciation_badge(uuid) to anon,authenticated,service_role;

comment on table public.appreciation_gifts is 'Private one-time community appreciation offer per recipient. Claim atomically earns permanent Іскра Xelay decorative badge and one calendar Participant month; no payments, renewal, email or push.';
comment on function public.xelay_appreciation_badge(uuid) is 'Boolean decorative badge visibility only; hidden/unearned/unknown all false. No exact subscription end or private gift details.';
notify pgrst,'reload schema';
commit;
