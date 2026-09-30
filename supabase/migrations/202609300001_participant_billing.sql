-- Participant access and group licenses. Apply after 202609290001.
-- No existing profile, chat, group, schedule or homework rows are deleted.
begin;

-- All referenced models and staff permission helpers belong to earlier steps.
-- Fail the entire transaction before changing anything if a prerequisite is absent.
do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.conversations') is null
    or to_regclass('public.messages') is null
    or to_regclass('public.message_reactions') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_schedule') is null
    or to_regclass('public.study_group_homework') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_can_view_study_group(uuid)') is null
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null then
    raise exception 'Apply the profile, news, message and study-group migrations before participant billing';
  end if;
end;
$$;

create table if not exists public.billing_settings (
  singleton boolean primary key default true check (singleton),
  enforce_group_payment boolean not null default false,
  first_free_group_claimed boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings(singleton) values(true) on conflict do nothing;

create table if not exists public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  product text not null check(product in ('participant','group')),
  group_id uuid references public.study_groups(id) on delete restrict,
  order_reference text not null unique,
  amount numeric(12,2) not null,
  currency text not null default 'UAH' check(currency = 'UAH'),
  mode text not null check(mode in ('test','live')),
  status text not null default 'pending' check(status in ('pending','approved','declined','expired','refunded','voided')),
  provider_status text,
  provider_fee numeric(12,2),
  last_status_check_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_order_product_price check (
    (product = 'participant' and amount = 100 and group_id is null)
    or (product = 'group' and amount = 750 and group_id is not null)
  )
);
alter table public.billing_orders add column if not exists last_status_check_at timestamptz;
alter table public.billing_orders drop constraint if exists billing_orders_provider_fee_check;
alter table public.billing_orders add constraint billing_orders_provider_fee_check check(provider_fee is null or provider_fee >= 0);
create index if not exists billing_orders_user_created_idx on public.billing_orders(user_id,created_at desc);
create index if not exists billing_orders_pending_group_idx on public.billing_orders(group_id) where product='group' and status='pending';

create table if not exists public.billing_payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.billing_orders(id) on delete restrict,
  fingerprint text not null unique,
  provider_status text not null,
  amount numeric(12,2) not null,
  mode text not null check(mode in ('test','live')),
  created_at timestamptz not null default now()
);
create table if not exists public.participant_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid unique references public.billing_orders(id) on delete restrict,
  source text not null check(source in ('payment','admin_grant')),
  term_months integer not null default 1 check(term_months between 1 and 12),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check(valid_until > valid_from),
  check((source='payment' and order_id is not null) or (source='admin_grant' and order_id is null))
);
alter table public.participant_entitlements add column if not exists term_months integer not null default 1;
alter table public.participant_entitlements drop constraint if exists participant_entitlements_term_months_check;
alter table public.participant_entitlements add constraint participant_entitlements_term_months_check check(term_months between 1 and 12);
-- Preserve multi-month admin grants if an earlier draft was applied before
-- term_months existed. Paid orders have always represented exactly one month.
with imported_terms as (
  select id,
    (extract(year from valid_until at time zone 'Europe/Kyiv')::integer - extract(year from valid_from at time zone 'Europe/Kyiv')::integer) * 12
    + extract(month from valid_until at time zone 'Europe/Kyiv')::integer - extract(month from valid_from at time zone 'Europe/Kyiv')::integer as months
  from public.participant_entitlements where source='admin_grant' and term_months=1
)
update public.participant_entitlements e set term_months=t.months
from imported_terms t where e.id=t.id and t.months between 2 and 12;
create index if not exists participant_entitlements_user_period_idx on public.participant_entitlements(user_id,valid_until) where revoked_at is null;
create table if not exists public.group_entitlements (
  group_id uuid primary key references public.study_groups(id) on delete cascade,
  source text not null check(source in ('free','payment','admin_grant')),
  order_id uuid unique references public.billing_orders(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check((source='payment' and order_id is not null) or source in ('free','admin_grant'))
);
create table if not exists public.billing_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_user_id uuid references public.profiles(id) on delete set null,
  group_id uuid references public.study_groups(id) on delete set null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists public.premium_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  emoji_status text,
  updated_at timestamptz not null default now()
);
create table if not exists public.user_search_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null,
  used integer not null default 0 check(used >= 0),
  primary key(user_id,usage_date)
);

create or replace function public.xelay_has_participant_access(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp
as $$
  select exists(select 1 from public.participant_entitlements e
    where e.user_id=p_user_id and e.revoked_at is null
      and e.valid_from <= now() and e.valid_until > now());
$$;
create or replace function public.xelay_group_has_access(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public,pg_temp
as $$ select exists(select 1 from public.group_entitlements where group_id=p_group_id and revoked_at is null); $$;
revoke all on function public.xelay_has_participant_access(uuid),public.xelay_group_has_access(uuid) from public,anon,authenticated;
grant execute on function public.xelay_has_participant_access(uuid),public.xelay_group_has_access(uuid) to authenticated;

-- Queue unused purchased months directly after the remaining active period.
-- Refunding a queued/current order must not strand other paid months behind it.
-- Consumed time in a still-active grant is never reset or gifted again.
create or replace function public.xelay_reflow_participant_access(p_user_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_entitlement record; v_cursor timestamptz := now(); v_until timestamptz;
begin
  if p_user_id is null then raise exception 'User required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:premium:' || p_user_id::text,0));
  for v_entitlement in
    select id,valid_from,valid_until,term_months from public.participant_entitlements
    where user_id=p_user_id and revoked_at is null and valid_until>now()
    order by valid_from,created_at,id for update
  loop
    if v_entitlement.valid_from<=now() then
      v_cursor := greatest(v_cursor,v_entitlement.valid_until);
    else
      v_until := ((v_cursor at time zone 'Europe/Kyiv') + make_interval(months=>v_entitlement.term_months)) at time zone 'Europe/Kyiv';
      update public.participant_entitlements set valid_from=v_cursor,valid_until=v_until where id=v_entitlement.id;
      v_cursor := v_until;
    end if;
  end loop;
end;
$$;
revoke all on function public.xelay_reflow_participant_access(uuid) from public,anon,authenticated;
grant execute on function public.xelay_reflow_participant_access(uuid) to service_role;

-- Claim the sole promotional license under a singleton row lock. The flag is
-- intentionally permanent even when the first group is eventually deleted.
do $$
declare v_group_id uuid; v_claimed boolean;
begin
  select first_free_group_claimed into v_claimed from public.billing_settings where singleton for update;
  if not v_claimed then
    select id into v_group_id from public.study_groups order by created_at,id limit 1;
    if v_group_id is not null then
      insert into public.group_entitlements(group_id,source) values(v_group_id,'free') on conflict do nothing;
      update public.billing_settings set first_free_group_claimed=true,updated_at=now() where singleton;
    end if;
  end if;
end;
$$;
create or replace function public.xelay_claim_first_group_license()
returns trigger language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_claimed boolean;
begin
  select first_free_group_claimed into v_claimed from public.billing_settings where singleton for update;
  if not v_claimed then
    insert into public.group_entitlements(group_id,source) values(new.id,'free');
    update public.billing_settings set first_free_group_claimed=true,updated_at=now() where singleton;
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_first_license on public.study_groups;
create trigger study_group_first_license after insert on public.study_groups
for each row execute function public.xelay_claim_first_group_license();

-- Keep legacy groups readable while payment setup is incomplete. The explicit
-- audited activation switch later gates writes at the database layer too.
create or replace function public.xelay_validate_group_license_write()
returns trigger language plpgsql security definer set search_path = public,pg_temp
as $$
begin
  if (select enforce_group_payment from public.billing_settings where singleton)
    and not public.xelay_group_has_access(new.group_id) then
    if tg_table_name='study_group_members' then
      if new.user_id=auth.uid() and new.status='accepted' and public.xelay_is_study_group_representative(new.group_id) then return new; end if;
      if tg_op='UPDATE' and new.status in ('rejected','removed') then return new; end if;
    end if;
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_schedule_license on public.study_group_schedule;
create trigger study_group_schedule_license before insert or update on public.study_group_schedule
for each row execute function public.xelay_validate_group_license_write();
drop trigger if exists study_group_homework_license on public.study_group_homework;
create trigger study_group_homework_license before insert or update on public.study_group_homework
for each row execute function public.xelay_validate_group_license_write();
drop trigger if exists study_group_members_license on public.study_group_members;
create trigger study_group_members_license before insert or update on public.study_group_members
for each row execute function public.xelay_validate_group_license_write();

create or replace function public.xelay_group_billing_status(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
declare v_active boolean; v_enforced boolean; v_source text; v_rep boolean;
begin
  if auth.uid() is null or not public.xelay_can_view_study_group(p_group_id) then raise exception 'Permission denied' using errcode='42501'; end if;
  select source into v_source from public.group_entitlements where group_id=p_group_id and revoked_at is null;
  v_active := v_source is not null;
  select enforce_group_payment into v_enforced from public.billing_settings where singleton;
  v_rep := public.xelay_is_study_group_representative(p_group_id);
  return jsonb_build_object('is_active',v_active,'source',v_source,'price',750,'is_representative',v_rep,
    'enforcement_enabled',v_enforced,'payment_required',v_enforced and not v_active,
    'can_edit',v_rep and (v_active or not v_enforced));
end;
$$;

-- Private organizer. Expired participants can still read/export/delete their
-- own data; creating or modifying tasks requires current participant access.
create table if not exists public.organizer_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null check(length(btrim(title)) between 1 and 200),
  notes text not null default '' check(length(notes)<=10000),
  due_at timestamptz,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists organizer_tasks_user_due_idx on public.organizer_tasks(user_id,completed,due_at);
create table if not exists public.conversation_pins (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,conversation_id)
);
create table if not exists public.direct_message_pins (
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,message_id)
);
create index if not exists direct_message_pins_user_conversation_idx on public.direct_message_pins(user_id,conversation_id,created_at);

create or replace function public.xelay_validate_premium_pin()
returns trigger language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_count integer;
begin
  if auth.uid() is null or new.user_id<>auth.uid() or not public.xelay_has_participant_access(auth.uid()) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if not exists(select 1 from public.conversations c where c.id=new.conversation_id and auth.uid() in (c.user_one_id,c.user_two_id)) then
    raise exception 'Conversation permission required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:pin:' || new.user_id::text,0));
  if tg_table_name='conversation_pins' then
    select count(*) into v_count from public.conversation_pins where user_id=new.user_id;
    if v_count>=10 and not exists(select 1 from public.conversation_pins where user_id=new.user_id and conversation_id=new.conversation_id) then
      raise exception 'PIN_LIMIT_REACHED';
    end if;
  else
    if not exists(select 1 from public.messages m where m.id=new.message_id and m.conversation_id=new.conversation_id and m.deleted_at is null) then
      raise exception 'Message not found in this conversation';
    end if;
    select count(*) into v_count from public.direct_message_pins where user_id=new.user_id and conversation_id=new.conversation_id;
    if v_count>=20 and not exists(select 1 from public.direct_message_pins where user_id=new.user_id and message_id=new.message_id) then
      raise exception 'MESSAGE_PIN_LIMIT_REACHED';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists premium_conversation_pin on public.conversation_pins;
create trigger premium_conversation_pin before insert on public.conversation_pins for each row execute function public.xelay_validate_premium_pin();
drop trigger if exists premium_message_pin on public.direct_message_pins;
create trigger premium_message_pin before insert on public.direct_message_pins for each row execute function public.xelay_validate_premium_pin();
create or replace function public.xelay_cleanup_deleted_message_pins()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if new.deleted_at is not null then delete from public.direct_message_pins where message_id=new.id; end if;
  return new;
end;
$$;
drop trigger if exists message_pin_cleanup on public.messages;
create trigger message_pin_cleanup after update of deleted_at on public.messages
for each row execute function public.xelay_cleanup_deleted_message_pins();

alter table public.message_reactions drop constraint if exists message_reactions_emoji_check;
alter table public.message_reactions add constraint message_reactions_emoji_check check(
  emoji in ('👍','❤️','😂','😮','🙌','🔥','🥰','🎉','🤩','💯','👏','🤝','🫶','🤔','😢','😎','⚡','📚'));
create or replace function public.xelay_validate_premium_reaction()
returns trigger language plpgsql security definer set search_path = public,pg_temp
as $$
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'Reaction owner permission required' using errcode='42501';
  end if;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.message_id is distinct from old.message_id
      or new.user_id is distinct from old.user_id then
      raise exception 'Reaction identity cannot be changed' using errcode='42501';
    end if;
    new.created_at := old.created_at;
  end if;
  if new.emoji not in ('👍','❤️','😂','😮','🙌','🔥') and not public.xelay_has_participant_access(auth.uid()) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;
drop trigger if exists premium_message_reaction on public.message_reactions;
create trigger premium_message_reaction before insert or update on public.message_reactions
for each row execute function public.xelay_validate_premium_reaction();

-- Profiles keep normal owner writes and owner SELECT. Public identity reads
-- use explicit known UUIDs; unrestricted username enumeration would bypass
-- the atomic search quota. Split existing ALL policies to preserve writes.
do $$
declare v_policy record; v_roles text; v_prefix text;
begin
  for v_policy in select * from pg_policies where schemaname='public' and tablename='profiles' and cmd in ('ALL','SELECT') loop
    if v_policy.cmd='ALL' then
      select string_agg(quote_ident(r),',') into v_roles from unnest(v_policy.roles) r;
      v_prefix := left(v_policy.policyname,20) || '_' || left(md5(v_policy.policyname),12) || '_billing';
      execute format('drop policy if exists %I on public.profiles',v_prefix || '_insert');
      execute format('drop policy if exists %I on public.profiles',v_prefix || '_update');
      execute format('drop policy if exists %I on public.profiles',v_prefix || '_delete');
      execute format('create policy %I on public.profiles as %s for insert to %s with check (%s)',
        v_prefix || '_insert',v_policy.permissive,v_roles,coalesce(v_policy.with_check,v_policy.qual,'true'));
      execute format('create policy %I on public.profiles as %s for update to %s using (%s) with check (%s)',
        v_prefix || '_update',v_policy.permissive,v_roles,coalesce(v_policy.qual,'true'),coalesce(v_policy.with_check,v_policy.qual,'true'));
      execute format('create policy %I on public.profiles as %s for delete to %s using (%s)',
        v_prefix || '_delete',v_policy.permissive,v_roles,coalesce(v_policy.qual,'true'));
    end if;
    execute format('drop policy %I on public.profiles',v_policy.policyname);
  end loop;
end;
$$;
alter table public.profiles enable row level security;
create policy "Profiles select own row" on public.profiles for select to authenticated using(id=auth.uid());
revoke select on public.profiles from anon;
grant select on public.profiles to authenticated;

create or replace function public.xelay_profiles_by_ids(p_user_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
declare v_rows jsonb;
begin
  if coalesce(cardinality(p_user_ids),0)>100 then raise exception 'Maximum 100 profile IDs'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) - array['email','has_seen_onboarding','updated_at']::text[]),'[]'::jsonb)
  into v_rows from (
    select id,full_name,username,avatar_url,faculty,specialty,study_year,country,city,bio,
      skills,help_with,want_to_learn,categories,experience,created_at,university_id,academic_unit_id
    from public.profiles where id=any(coalesce(p_user_ids,'{}'::uuid[]))
  ) p;
  return v_rows;
end;
$$;
create or replace function public.xelay_member_count()
returns bigint language sql stable security definer set search_path = public,pg_temp
as $$ select count(*) from public.profiles; $$;

create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
declare v_premium boolean; v_used integer; v_expiry timestamptz; v_emoji text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  select coalesce(used,0) into v_used from public.user_search_usage where user_id=auth.uid() and usage_date=(now() at time zone 'Europe/Kyiv')::date;
  v_used := coalesce(v_used,0);
  if v_premium then
    -- Report only uninterrupted coverage, even if a manual database change
    -- has left a future gap. A distant future grant is not active access.
    with recursive coverage(until_at) as (
      select max(valid_until) from public.participant_entitlements
      where user_id=auth.uid() and revoked_at is null and valid_from<=now() and valid_until>now()
      union
      select e.valid_until from coverage c join public.participant_entitlements e
        on e.user_id=auth.uid() and e.revoked_at is null
          and e.valid_from<=c.until_at and e.valid_until>c.until_at
    ) select max(until_at) into v_expiry from coverage;
    select emoji_status into v_emoji from public.premium_preferences where user_id=auth.uid();
  end if;
  return jsonb_build_object('is_premium',v_premium,'expires_at',v_expiry,'emoji_status',v_emoji,
    'search_used',v_used,'search_remaining',case when v_premium then null else greatest(5-v_used,0) end,
    'search_limit',5,'search_unlimited',v_premium);
end;
$$;
create or replace function public.xelay_public_premium(p_user_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
begin
  if coalesce(cardinality(p_user_ids),0)>100 then raise exception 'Maximum 100 profile IDs'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id',p.id,
    'is_premium',public.xelay_has_participant_access(p.id),
    'emoji_status',case when public.xelay_has_participant_access(p.id) then pref.emoji_status else null end)),'[]'::jsonb)
    from public.profiles p left join public.premium_preferences pref on pref.user_id=p.id
    where p.id=any(coalesce(p_user_ids,'{}'::uuid[])));
end;
$$;
create or replace function public.xelay_set_emoji_status(p_emoji text)
returns void language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_emoji text := nullif(btrim(p_emoji),'');
begin
  if auth.uid() is null or not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if v_emoji is not null and v_emoji not in ('🎓','📚','💻','☕','🔥','✨','💡','🎯','🌱','🌿','💼','😴','🚀','🎨','💤','❤️','🧠','🏆','🌍','📝','🫶') then
    raise exception 'Unsupported emoji status';
  end if;
  insert into public.premium_preferences(user_id,emoji_status) values(auth.uid(),v_emoji)
  on conflict(user_id) do update set emoji_status=excluded.emoji_status,updated_at=now();
end;
$$;
create or replace function public.xelay_search_users(p_query text)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_query text; v_pattern text; v_premium boolean; v_used integer; v_profiles jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_query := lower(regexp_replace(btrim(p_query),'^@+',''));
  if v_query is null or length(v_query)<2 or length(v_query)>30 or v_query !~ '^[[:alnum:]_.-]+$' then raise exception 'INVALID_SEARCH_QUERY'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  insert into public.user_search_usage(user_id,usage_date,used) values(auth.uid(),(now() at time zone 'Europe/Kyiv')::date,1)
    on conflict(user_id,usage_date) do update set used=user_search_usage.used+1
    where v_premium or user_search_usage.used<5 returning used into v_used;
  if v_used is null then
    return jsonb_build_object('profiles','[]'::jsonb,'used',5,'remaining',0,'limit',5,'unlimited',false,'limit_reached',true);
  end if;
  v_pattern := '%' || replace(replace(replace(v_query,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%';
  select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) into v_profiles from (
    select id,username,full_name,avatar_url,faculty,specialty,study_year from public.profiles
      where id<>auth.uid() and username ilike v_pattern escape E'\\' order by username limit 30
  ) p;
  return jsonb_build_object('profiles',v_profiles,'used',v_used,'remaining',case when v_premium then null else greatest(5-v_used,0) end,'limit',5,'unlimited',v_premium);
end;
$$;

alter table public.billing_settings enable row level security;
alter table public.billing_orders enable row level security;
alter table public.billing_payment_events enable row level security;
alter table public.participant_entitlements enable row level security;
alter table public.group_entitlements enable row level security;
alter table public.billing_audit_log enable row level security;
alter table public.premium_preferences enable row level security;
alter table public.user_search_usage enable row level security;
alter table public.organizer_tasks enable row level security;
alter table public.conversation_pins enable row level security;
alter table public.direct_message_pins enable row level security;
-- Replace only policies owned by this migration when it is re-applied.
drop policy if exists "Owners view billing orders" on public.billing_orders;
drop policy if exists "Owners view participant entitlements" on public.participant_entitlements;
drop policy if exists "Admins view billing audit" on public.billing_audit_log;
drop policy if exists "Owner reads organizer" on public.organizer_tasks;
drop policy if exists "Participant creates organizer" on public.organizer_tasks;
drop policy if exists "Participant updates organizer" on public.organizer_tasks;
drop policy if exists "Owner deletes organizer" on public.organizer_tasks;
drop policy if exists "Owner reads conversation pins" on public.conversation_pins;
drop policy if exists "Participant adds conversation pins" on public.conversation_pins;
drop policy if exists "Owner removes conversation pins" on public.conversation_pins;
drop policy if exists "Owner reads message pins" on public.direct_message_pins;
drop policy if exists "Participant adds message pins" on public.direct_message_pins;
drop policy if exists "Owner removes message pins" on public.direct_message_pins;
create policy "Owners view billing orders" on public.billing_orders for select to authenticated using(user_id=auth.uid() or public.xelay_is_platform_admin());
create policy "Owners view participant entitlements" on public.participant_entitlements for select to authenticated using(user_id=auth.uid() or public.xelay_is_platform_admin());
create policy "Admins view billing audit" on public.billing_audit_log for select to authenticated using(public.xelay_is_platform_admin());
create policy "Owner reads organizer" on public.organizer_tasks for select to authenticated using(user_id=auth.uid());
create policy "Participant creates organizer" on public.organizer_tasks for insert to authenticated with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Participant updates organizer" on public.organizer_tasks for update to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid())) with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Owner deletes organizer" on public.organizer_tasks for delete to authenticated using(user_id=auth.uid());
create policy "Owner reads conversation pins" on public.conversation_pins for select to authenticated using(user_id=auth.uid() and exists(select 1 from public.conversations c where c.id=conversation_id and auth.uid() in(c.user_one_id,c.user_two_id)));
create policy "Participant adds conversation pins" on public.conversation_pins for insert to authenticated with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Owner removes conversation pins" on public.conversation_pins for delete to authenticated using(user_id=auth.uid());
create policy "Owner reads message pins" on public.direct_message_pins for select to authenticated using(user_id=auth.uid() and exists(select 1 from public.conversations c where c.id=conversation_id and auth.uid() in(c.user_one_id,c.user_two_id)));
create policy "Participant adds message pins" on public.direct_message_pins for insert to authenticated with check(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create policy "Owner removes message pins" on public.direct_message_pins for delete to authenticated using(user_id=auth.uid());
revoke all on public.billing_settings,public.billing_orders,public.billing_payment_events,public.participant_entitlements,
  public.group_entitlements,public.billing_audit_log,public.premium_preferences,public.user_search_usage,
  public.organizer_tasks,public.conversation_pins,public.direct_message_pins from public,anon,authenticated;
grant select on public.billing_orders,public.participant_entitlements,public.billing_audit_log to authenticated;
grant select,insert,update,delete on public.organizer_tasks to authenticated;
grant select,insert,delete on public.conversation_pins,public.direct_message_pins to authenticated;
grant all on public.billing_settings,public.billing_orders,public.billing_payment_events,public.participant_entitlements,
  public.group_entitlements,public.billing_audit_log,public.premium_preferences,public.user_search_usage,
  public.organizer_tasks,public.conversation_pins,public.direct_message_pins to service_role;

-- Only the server service role may create/apply payment orders. The callback
-- signature is verified in the Vercel endpoint before calling this function.
create or replace function public.xelay_claim_billing_reconciliation(p_user_id uuid,p_reference text,p_mode text)
returns boolean language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_order public.billing_orders%rowtype;
begin
  if p_user_id is null or p_reference is null or p_mode is null or p_mode not in('test','live') then
    raise exception 'Order owner and mode required';
  end if;
  select * into v_order from public.billing_orders
    where order_reference=p_reference and user_id=p_user_id and mode=p_mode for update;
  if not found then raise exception 'Payment order mismatch'; end if;
  if v_order.last_status_check_at is not null and v_order.last_status_check_at>now()-interval '1 minute' then return false; end if;
  update public.billing_orders set last_status_check_at=now() where id=v_order.id;
  return true;
end;
$$;
create or replace function public.xelay_create_billing_order(p_user_id uuid,p_product text,p_mode text,p_order_reference text,p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_order public.billing_orders%rowtype; v_count integer;
begin
  if p_user_id is null or p_mode is null or p_product is null
    or p_mode not in('test','live') or p_product not in('participant','group') then raise exception 'Invalid billing product/mode'; end if;
  if p_order_reference is null or length(p_order_reference)>100 then raise exception 'Order reference required'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Profile required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));
  if p_product='group' then
    if not exists(select 1 from public.study_groups where id=p_group_id and representative_id=p_user_id) then raise exception 'Group representative required'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || p_group_id::text,0));
    if public.xelay_group_has_access(p_group_id) then raise exception 'GROUP_ALREADY_ACTIVE'; end if;
  elsif p_group_id is not null then raise exception 'Participant order cannot include group'; end if;
  -- Double clicks and returning from an abandoned checkout reuse its reference.
  -- The provider still sees the original orderDate/timeout, not a fresh charge.
  select * into v_order from public.billing_orders
    where user_id=p_user_id and product=p_product and mode=p_mode
      and group_id is not distinct from p_group_id
      and status='pending' and created_at>now()-interval '1 hour'
    order by created_at desc limit 1;
  if found then return to_jsonb(v_order); end if;
  select count(*) into v_count from public.billing_orders where user_id=p_user_id and created_at>now()-interval '1 hour';
  if v_count>=10 then raise exception 'CHECKOUT_RATE_LIMIT'; end if;
  insert into public.billing_orders(user_id,product,group_id,order_reference,amount,mode)
    values(p_user_id,p_product,p_group_id,p_order_reference,case when p_product='participant' then 100 else 750 end,p_mode)
    returning * into v_order;
  return to_jsonb(v_order);
end;
$$;
create or replace function public.xelay_apply_billing_event(p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_order public.billing_orders%rowtype; v_from timestamptz; v_rows integer; v_duplicate_group boolean := false;
begin
  select * into v_order from public.billing_orders where order_reference=p_reference for update;
  if not found or v_order.mode is distinct from p_mode
    or v_order.amount is distinct from p_amount or p_currency is distinct from 'UAH' then raise exception 'Payment order mismatch'; end if;
  if p_fingerprint is null or length(p_fingerprint)<>64 or p_status is null then raise exception 'Payment event required'; end if;
  -- Every write to the same access balance uses the same lock, including refunds.
  if v_order.product='participant' then
    perform pg_advisory_xact_lock(hashtextextended('xelay:premium:' || v_order.user_id::text,0));
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || v_order.group_id::text,0));
  end if;
  insert into public.billing_payment_events(order_id,fingerprint,provider_status,amount,mode)
    values(v_order.id,p_fingerprint,p_status,p_amount,p_mode) on conflict(fingerprint) do nothing;
  get diagnostics v_rows=row_count;
  if v_rows=0 then return jsonb_build_object('duplicate',true,'status',v_order.status); end if;
  -- Test orders are recorded, never converted to production rights.
  if p_status='Approved' and v_order.status not in('approved','refunded','voided') then
    update public.billing_orders set status='approved',provider_status=p_status,provider_fee=p_fee,approved_at=now(),updated_at=now() where id=v_order.id;
    if p_mode='live' then
      if v_order.product='participant' then
        perform public.xelay_reflow_participant_access(v_order.user_id);
        select greatest(now(),coalesce(max(valid_until),now())) into v_from from public.participant_entitlements where user_id=v_order.user_id and revoked_at is null and valid_until>now();
        insert into public.participant_entitlements(user_id,order_id,source,term_months,valid_from,valid_until)
          values(v_order.user_id,v_order.id,'payment',1,v_from,
            ((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') on conflict(order_id) do nothing;
      else
        if public.xelay_group_has_access(v_order.group_id) then
          v_duplicate_group := true;
          insert into public.billing_audit_log(action,target_user_id,group_id,detail)
            values('duplicate_group_payment',v_order.user_id,v_order.group_id,
              jsonb_build_object('order_id',v_order.id,'order_reference',p_reference,
                'reason','Групу вже активовано. Перевірте повторну оплату та повернення коштів.'));
        else
          insert into public.group_entitlements(group_id,source,order_id) values(v_order.group_id,'payment',v_order.id)
            on conflict(group_id) do update set source='payment',order_id=excluded.order_id,revoked_at=null,created_at=now()
            where group_entitlements.revoked_at is not null;
        end if;
      end if;
    end if;
  elsif p_status in('Refunded','Voided') then
    update public.billing_orders set status=case when p_status='Refunded' or v_order.status='refunded' then 'refunded' else 'voided' end,
      provider_status=case when v_order.status='refunded' then 'Refunded' else p_status end,updated_at=now() where id=v_order.id;
    update public.participant_entitlements set revoked_at=now() where order_id=v_order.id and revoked_at is null;
    update public.group_entitlements set revoked_at=now() where order_id=v_order.id and source='payment' and revoked_at is null;
    if p_mode='live' and v_order.product='participant' then
      perform public.xelay_reflow_participant_access(v_order.user_id);
    end if;
  elsif p_status in('Declined','Expired') and v_order.status<>'approved' and v_order.status not in('refunded','voided') then
    update public.billing_orders set status=case when p_status='Expired' then 'expired' else 'declined' end,provider_status=p_status,updated_at=now() where id=v_order.id;
  else
    update public.billing_orders set provider_status=p_status,updated_at=now() where id=v_order.id;
  end if;
  return jsonb_build_object('duplicate',false,'mode',p_mode,'duplicate_group_payment',v_duplicate_group);
end;
$$;

create or replace function public.xelay_admin_grant_participant(p_user_id uuid,p_months integer,p_reason text)
returns void language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_from timestamptz;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then raise exception 'Admin permission required' using errcode='42501'; end if;
  if p_user_id is null or p_months is null or p_months not between 1 and 12 or length(btrim(coalesce(p_reason,''))) not between 5 and 500 then raise exception 'Specify 1..12 months and a reason'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Profile required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:premium:' || p_user_id::text,0));
  perform public.xelay_reflow_participant_access(p_user_id);
  select greatest(now(),coalesce(max(valid_until),now())) into v_from from public.participant_entitlements where user_id=p_user_id and revoked_at is null and valid_until>now();
  insert into public.participant_entitlements(user_id,source,term_months,valid_from,valid_until)
    values(p_user_id,'admin_grant',p_months,v_from,
      ((v_from at time zone 'Europe/Kyiv')+make_interval(months=>p_months)) at time zone 'Europe/Kyiv');
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail) values(auth.uid(),'grant_participant',p_user_id,jsonb_build_object('months',p_months,'reason',btrim(p_reason)));
end;
$$;
create or replace function public.xelay_admin_set_group_enforcement(p_enabled boolean,p_reason text)
returns void language plpgsql security definer set search_path = public,pg_temp
as $$
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then raise exception 'Admin permission required' using errcode='42501'; end if;
  if p_enabled is null or length(btrim(coalesce(p_reason,''))) not between 5 and 500 then raise exception 'Provide an audit reason'; end if;
  update public.billing_settings set enforce_group_payment=p_enabled,updated_at=now() where singleton;
  insert into public.billing_audit_log(actor_id,action,detail) values(auth.uid(),'set_group_enforcement',jsonb_build_object('enabled',p_enabled,'reason',btrim(p_reason)));
end;
$$;
create or replace function public.xelay_admin_billing_overview()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then raise exception 'Admin permission required' using errcode='42501'; end if;
  return jsonb_build_object(
    'active_participants',(select count(distinct user_id) from public.participant_entitlements where revoked_at is null and valid_from<=now() and valid_until>now()),
    'active_groups',(select count(*) from public.group_entitlements where revoked_at is null),
    'paid_groups',(select count(*) from public.group_entitlements where source='payment' and revoked_at is null),
    'live_revenue',(select coalesce(sum(amount),0) from public.billing_orders where mode='live' and status='approved'),
    'refunds',(select coalesce(sum(amount),0) from public.billing_orders where mode='live' and status='refunded'),
    'fees',(select coalesce(sum(provider_fee),0) from public.billing_orders where mode='live' and status='approved'),
    'fees_pending',(select count(*) from public.billing_orders where mode='live' and status='approved' and provider_fee is null),
    'fees_known',not exists(select 1 from public.billing_orders where mode='live' and status='approved' and provider_fee is null),
    'enforcement_enabled',(select enforce_group_payment from public.billing_settings where singleton),
    'orders',(select coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) from(select id,user_id,product,group_id,order_reference,amount,currency,mode,status,provider_fee,created_at,approved_at from public.billing_orders order by created_at desc limit 50)o),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from(select * from public.billing_audit_log order by created_at desc limit 30)a)
  );
end;
$$;

-- Never leave SECURITY DEFINER entry points executable by PUBLIC.
revoke all on function public.xelay_claim_first_group_license(),public.xelay_validate_group_license_write(),
  public.xelay_validate_premium_pin(),public.xelay_validate_premium_reaction(),public.xelay_cleanup_deleted_message_pins(),
  public.xelay_group_billing_status(uuid),public.xelay_profiles_by_ids(uuid[]),public.xelay_member_count(),
  public.xelay_billing_status(),public.xelay_public_premium(uuid[]),public.xelay_set_emoji_status(text),public.xelay_search_users(text),
  public.xelay_create_billing_order(uuid,text,text,text,uuid),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric),
  public.xelay_claim_billing_reconciliation(uuid,text,text),
  public.xelay_admin_grant_participant(uuid,integer,text),public.xelay_admin_set_group_enforcement(boolean,text),public.xelay_admin_billing_overview() from public,anon,authenticated;
grant execute on function public.xelay_profiles_by_ids(uuid[]),public.xelay_member_count(),public.xelay_public_premium(uuid[]) to anon,authenticated;
grant execute on function public.xelay_billing_status(),public.xelay_group_billing_status(uuid),public.xelay_set_emoji_status(text),public.xelay_search_users(text),
  public.xelay_admin_grant_participant(uuid,integer,text),public.xelay_admin_set_group_enforcement(boolean,text),public.xelay_admin_billing_overview() to authenticated;
grant execute on function public.xelay_create_billing_order(uuid,text,text,text,uuid),public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric),public.xelay_claim_billing_reconciliation(uuid,text,text) to service_role;

commit;
