-- Installing the birthday-gift mechanism creates no offers, notifications,
-- entitlements, payments or recurring charges. A verified MFA administrator
-- offers a gift explicitly; only its recipient can claim the calendar month.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $$
declare v_constraint record; v_allowed boolean;
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.participant_entitlements') is null
    or to_regclass('public.billing_audit_log') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_reflow_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_queue_notification_email()') is null
    or not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid='public.notifications'::regclass and tgname='notification_email_queue'
        and not tgisinternal and tgfoid='public.xelay_queue_notification_email()'::regprocedure
        and tgtype=5 and tgqual is null and tgenabled='O' and tgnargs=0)
    or not exists(select 1 from information_schema.columns
      where table_schema='auth' and table_name='users' and column_name='banned_until') then
    raise exception 'BIRTHDAY_GIFT_PREREQUISITES_MISSING';
  end if;
  -- Inspect the actual CHECK constraints (including any legacy type allowlist)
  -- against a typed synthetic birthday row, without inserting or notifying.
  for v_constraint in select conname,pg_get_expr(conbin,conrelid) as expression
    from pg_catalog.pg_constraint where conrelid='public.notifications'::regclass and contype='c'
  loop
    execute format('select ((%s) is not false) from jsonb_populate_record(null::public.notifications,$1)',
      v_constraint.expression) into v_allowed using jsonb_build_object(
        'id','00000000-0000-0000-0000-000000000001',
        'recipient_id','00000000-0000-0000-0000-000000000002',
        'actor_id','00000000-0000-0000-0000-000000000003',
        'actor_name','Xelay','type','birthday_gift','message','Birthday gift',
        'is_read',false,'created_at',clock_timestamp());
    if not coalesce(v_allowed,false) then
      raise exception 'BIRTHDAY_GIFT_NOTIFICATION_CHECK_UNSUPPORTED: %',v_constraint.conname;
    end if;
  end loop;
end $$;

create table public.birthday_gifts (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  greeting_name text not null default '' check(length(greeting_name)<=80
    and greeting_name=btrim(greeting_name) and greeting_name !~ '[[:cntrl:]]'),
  gift_year integer not null check(gift_year between 2000 and 9999),
  notification_id uuid not null unique references public.notifications(id) on delete restrict,
  offered_by uuid references public.profiles(id) on delete set null,
  offered_at timestamptz not null,
  claimed_at timestamptz,
  entitlement_id uuid unique references public.participant_entitlements(id) on delete restrict,
  unique(recipient_id,gift_year),
  check((claimed_at is null and entitlement_id is null)
    or (claimed_at is not null and entitlement_id is not null))
);
alter table public.birthday_gifts enable row level security;
revoke all on public.birthday_gifts from public,anon,authenticated,service_role;

-- Private clock seam supports isolated calendar/DST tests. No browser can
-- provide a timestamp, year, month count, entitlement source or claim recipient.
create function public.xelay_private_birthday_gift_clock()
returns timestamptz language sql volatile security invoker set search_path='' as $$
  select pg_catalog.clock_timestamp();
$$;

create function public.xelay_private_birthday_gift_json(p_gift_id uuid,p_newly_claimed boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'id',g.id,'notification_id',g.notification_id,
    'recipient_name',g.greeting_name,
    'gift_year',g.gift_year,'offered_at',g.offered_at,'claimed_at',g.claimed_at,
    'valid_from',e.valid_from,'valid_until',e.valid_until,
    'newly_claimed',p_newly_claimed)
  from public.birthday_gifts g
  left join public.participant_entitlements e on e.id=g.entitlement_id
  where g.id=p_gift_id;
$$;

create function public.xelay_my_birthday_gifts()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(public.xelay_private_birthday_gift_json(g.id,false)
    order by g.offered_at desc,g.id)
    from (select id,offered_at from public.birthday_gifts where recipient_id=v_user
      order by offered_at desc,id limit 20) g),'[]'::jsonb);
end $$;

create function public.xelay_admin_offer_birthday_gift(p_user_id uuid,p_greeting_name text default '')
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid(); v_now timestamptz; v_year integer;
  v_gift_id uuid; v_notification_id uuid; v_greeting_name text:=btrim(coalesce(p_greeting_name,''));
begin
  -- Some live installations retain the original base-role administrator
  -- helper. Require verified MFA here explicitly without changing that helper.
  if v_actor is null or not public.xelay_is_platform_admin()
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from auth.mfa_factors f where f.user_id=v_actor and f.status='verified')
    or not exists(select 1 from auth.users u where u.id=v_actor and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_birthday_gift_clock()) then
    raise exception 'Admin permission required' using errcode='42501';
  end if;
  if length(v_greeting_name)>80 or v_greeting_name ~ '[[:cntrl:]]' then
    raise exception 'BIRTHDAY_GIFT_GREETING_NAME_INVALID' using errcode='22023';
  end if;
  if p_user_id is null or not exists(select 1 from public.profiles p
    join auth.users u on u.id=p.id where p.id=p_user_id and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_birthday_gift_clock()
      and u.email_confirmed_at is not null) then
    raise exception 'Active confirmed account required' using errcode='42501';
  end if;
  -- The year comes from the server in the platform's calendar timezone.
  v_now:=public.xelay_private_birthday_gift_clock();
  v_year:=extract(year from v_now at time zone 'Europe/Kyiv')::integer;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'xelay:birthday-gift:'||p_user_id::text||':'||v_year::text,0));
  select id into v_gift_id from public.birthday_gifts
    where recipient_id=p_user_id and gift_year=v_year;
  if v_gift_id is not null then
    return public.xelay_private_birthday_gift_json(v_gift_id,false);
  end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,created_at)
    values(p_user_id,v_actor,'Xelay','birthday_gift',
      'З днем народження! Даруємо вам місяць підписки «Учасник». Відкрийте це сповіщення, щоб забрати подарунок. Якщо підписка вже активна, подарунковий місяць додасться після неї.',
      false,v_now) returning id into v_notification_id;
  insert into public.birthday_gifts(recipient_id,greeting_name,gift_year,notification_id,offered_by,offered_at)
    values(p_user_id,v_greeting_name,v_year,v_notification_id,v_actor,v_now) returning id into v_gift_id;
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
    values(v_actor,'birthday_gift_offer',p_user_id,
      jsonb_build_object('gift_id',v_gift_id,'gift_year',v_year,'months',1));
  return public.xelay_private_birthday_gift_json(v_gift_id,false);
end $$;

create function public.xelay_claim_birthday_gift(p_gift_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_user uuid:=auth.uid(); v_gift public.birthday_gifts%rowtype;
  v_now timestamptz; v_from timestamptz; v_until timestamptz; v_entitlement uuid;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  -- Foreign and unknown identifiers return the same error and expose no state.
  select * into v_gift from public.birthday_gifts
    where id=p_gift_id and recipient_id=v_user for update;
  if not found then raise exception 'BIRTHDAY_GIFT_UNAVAILABLE' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=v_user and u.deleted_at is null and u.email_confirmed_at is not null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=public.xelay_private_birthday_gift_clock()) then
    raise exception 'Active confirmed account required' using errcode='42501';
  end if;
  update public.notifications set is_read=true where id=v_gift.notification_id
    and recipient_id::text=v_user::text and type='birthday_gift' and not coalesce(is_read,false);
  if v_gift.claimed_at is not null then
    return public.xelay_private_birthday_gift_json(v_gift.id,false);
  end if;
  -- Use the billing lock and reflow unchanged so a concurrent payment, grant
  -- or refund cannot overwrite/overlap access. Never create a billing order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:premium:'||v_user::text,0));
  perform public.xelay_reflow_participant_access(v_user);
  v_now:=public.xelay_private_birthday_gift_clock();
  select greatest(v_now,coalesce(max(valid_until),v_now)) into v_from
    from public.participant_entitlements
    where user_id=v_user and revoked_at is null and valid_until>v_now;
  v_until:=((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv';
  insert into public.participant_entitlements(user_id,source,term_months,valid_from,valid_until)
    values(v_user,'admin_grant',1,v_from,v_until) returning id into v_entitlement;
  update public.birthday_gifts set claimed_at=v_now,entitlement_id=v_entitlement where id=v_gift.id;
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
    values(v_user,'birthday_gift_claim',v_user,
      jsonb_build_object('gift_id',v_gift.id,'gift_year',v_gift.gift_year,'months',1,
        'entitlement_id',v_entitlement,'valid_from',v_from,'valid_until',v_until));
  return public.xelay_private_birthday_gift_json(v_gift.id,true);
end $$;

create policy "Birthday gift notifications server insert" on public.notifications as restrictive
  for insert to anon,authenticated with check(type is distinct from 'birthday_gift');
create function public.xelay_guard_birthday_gift_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (old.type='birthday_gift' and (to_jsonb(new)-'is_read') is distinct from (to_jsonb(old)-'is_read'))
    or (old.type is distinct from 'birthday_gift' and new.type='birthday_gift') then
    raise exception 'BIRTHDAY_GIFT_NOTIFICATION_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
create trigger birthday_gift_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_birthday_gift_notification_update();

-- Birthday gifts are offered inside the platform only. Keep the existing
-- generic email queue function and all other notification types unchanged.
-- No historical outbox rows are inserted, removed, or made eligible again.
drop trigger notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row when (new.type is distinct from 'birthday_gift')
  execute function public.xelay_queue_notification_email();

revoke all on function public.xelay_private_birthday_gift_clock(),
  public.xelay_private_birthday_gift_json(uuid,boolean),public.xelay_my_birthday_gifts(),
  public.xelay_admin_offer_birthday_gift(uuid,text),public.xelay_claim_birthday_gift(uuid),
  public.xelay_guard_birthday_gift_notification_update()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_birthday_gifts(),
  public.xelay_admin_offer_birthday_gift(uuid,text),public.xelay_claim_birthday_gift(uuid) to authenticated;

comment on table public.birthday_gifts is 'Private administrator-issued birthday offers, one per recipient/server Kyiv calendar year. Claim appends one non-recurring Participant calendar month; no payment or DOB is created.';
comment on column public.birthday_gifts.greeting_name is 'Explicit optional greeting name, never inferred from profile full_name or username. Immutable through re-offering the same annual gift.';
comment on function public.xelay_admin_offer_birthday_gift(uuid,text) is 'Explicit verified-MFA administrator action. Idempotent per recipient/current server Kyiv year; repeat cannot rename the existing greeting. Creates one in-app notification and no entitlement or email.';
comment on function public.xelay_claim_birthday_gift(uuid) is 'Recipient-only atomic idempotent claim. Uses existing premium billing lock/reflow and appends one calendar month; no billing order, renewal, email or claim notification.';
commit;
