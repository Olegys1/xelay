-- Optional month/day only. No birth year, age, public profile column or email.
-- Installing creates no birthday offers or group announcements. Existing claim
-- and billing reflow functions remain unchanged; access starts only on claim.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
declare v_constraint record;v_allowed boolean;v_trigger record;
begin
  if to_regclass('public.birthday_gifts') is null
    or to_regclass('public.study_groups') is null or to_regclass('public.study_group_members') is null
    or to_regclass('public.notification_preferences') is null
    or to_regprocedure('public.xelay_private_birthday_gift_clock()') is null
    or to_regprocedure('public.xelay_my_birthday_gifts()') is null
    or to_regprocedure('public.xelay_claim_birthday_gift(uuid)') is null
    or to_regprocedure('public.xelay_queue_notification_email()') is null
    or to_regprocedure('public.xelay_queue_participant_push()') is null then
    raise exception 'PROFILE_BIRTHDAY_PREREQUISITES_MISSING';end if;
  for v_trigger in select t.tgname,t.tgtype,t.tgfoid,t.tgenabled,t.tgnargs,pg_get_triggerdef(t.oid) definition
    from pg_trigger t where t.tgrelid='public.notifications'::regclass and not t.tgisinternal
      and t.tgname in('notification_email_queue','xelay_participant_push_queue') loop
    if v_trigger.tgtype<>5 or v_trigger.tgenabled<>'O' or v_trigger.tgnargs<>0
      or(v_trigger.tgname='notification_email_queue' and(v_trigger.tgfoid<>'public.xelay_queue_notification_email()'::regprocedure
        or position('birthday_gift' in v_trigger.definition)=0 or position('appreciation_gift' in v_trigger.definition)=0))
      or(v_trigger.tgname='xelay_participant_push_queue' and v_trigger.tgfoid<>'public.xelay_queue_participant_push()'::regprocedure) then
      raise exception 'PROFILE_BIRTHDAY_DELIVERY_TRIGGER_DRIFT';end if;
  end loop;
  if (select count(*) from pg_trigger where tgrelid='public.notifications'::regclass and not tgisinternal
    and tgname in('notification_email_queue','xelay_participant_push_queue'))<>2 then
    raise exception 'PROFILE_BIRTHDAY_DELIVERY_TRIGGER_MISSING';end if;
  for v_constraint in select conname,pg_get_expr(conbin,conrelid) expression from pg_constraint
    where conrelid='public.notifications'::regclass and contype='c' loop
    execute format('select ((%s) is not false) from jsonb_populate_record(null::public.notifications,$1)',v_constraint.expression)
      into v_allowed using jsonb_build_object('id','00000000-0000-4000-8000-000000000001',
        'recipient_id','00000000-0000-4000-8000-000000000002','actor_id','00000000-0000-4000-8000-000000000003',
        'actor_name','Synthetic','type','group_birthday','message','Synthetic birthday','is_read',false,
        'study_group_id','00000000-0000-4000-8000-000000000004','created_at',clock_timestamp());
    if not coalesce(v_allowed,false) then raise exception 'PROFILE_BIRTHDAY_NOTIFICATION_CHECK_UNSUPPORTED: %',v_constraint.conname;end if;
  end loop;
end $preflight$;

create table public.profile_birthdays (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  day smallint,month smallint,
  share_with_groups boolean not null default false,
  disclosure_revision bigint not null default 1 check(disclosure_revision>0),
  notice_version text not null default '2026-10-29.1' check(notice_version='2026-10-29.1'),
  consent_updated_at timestamptz not null,
  updated_at timestamptz not null,
  check((day is null and month is null and not share_with_groups) or
    (day is not null and month is not null and month between 1 and 12 and day between 1 and
      case when month=2 then 29 when month in(4,6,9,11) then 30 else 31 end))
);
create index profile_birthdays_calendar on public.profile_birthdays(month,day) where month is not null;
create table public.birthday_profile_anniversaries (
  user_id uuid not null references public.profiles(id) on delete cascade,
  event_year integer not null check(event_year between 2000 and 9999),
  observed_on date not null,
  disclosure_revision bigint not null,
  completed boolean not null default false,
  primary key(user_id,event_year)
);
create table public.birthday_profile_dispatches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  event_year integer not null check(event_year between 2000 and 9999),
  observed_on date not null,disclosure_revision bigint not null,
  unique(user_id,recipient_id,event_year),check(user_id<>recipient_id)
);
alter table public.profile_birthdays enable row level security;
alter table public.birthday_profile_anniversaries enable row level security;
alter table public.birthday_profile_dispatches enable row level security;
revoke all on public.profile_birthdays,public.birthday_profile_anniversaries,public.birthday_profile_dispatches
  from public,anon,authenticated,service_role;

alter table public.notifications add column birthday_event_id uuid references public.birthday_profile_dispatches(id) on delete cascade;
create unique index notifications_birthday_event_unique on public.notifications(birthday_event_id) where birthday_event_id is not null;
alter table public.notifications add constraint notifications_birthday_event_shape check(
  (type is not distinct from 'group_birthday' and birthday_event_id is not null and study_group_id is not null
    and actor_id is not null and recipient_id is not null and academic_event_key is null and academic_tab is null)
  or(type is distinct from 'group_birthday' and birthday_event_id is null)
);

-- These private helpers never accept a caller-supplied clock at a public RPC.
-- In non-leap years February 29 is observed on February 28.
create function public.xelay_private_birthday_observed_date(p_day integer,p_month integer,p_year integer)
returns date language sql immutable security invoker set search_path='' as $$
  select make_date(p_year,p_month,case when p_month=2 and p_day=29
    and not(p_year%400=0 or(p_year%4=0 and p_year%100<>0)) then 28 else p_day end);
$$;
create function public.xelay_private_birthday_active(p_user uuid,p_now timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select p_user is not null and exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=p_user and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=p_now);
$$;
create function public.xelay_private_birthday_group_member(p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_user is not null and exists(select 1 from public.study_groups g where g.id=p_group
    and(g.representative_id=p_user or exists(select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=p_user and m.status='accepted')));
$$;
create function public.xelay_private_birthday_notification_recipient(p_user uuid,p_now timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_birthday_active(p_user,p_now) and coalesce((
    select p.notifications_enabled from public.notification_preferences p where p.user_id::text=p_user::text),true);
$$;

create function public.xelay_my_birthday_profile()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_profile public.profile_birthdays%rowtype;
begin
  if not public.xelay_private_birthday_active(v_user,v_now) then raise exception 'PROFILE_BIRTHDAY_AUTH_REQUIRED' using errcode='42501';end if;
  select * into v_profile from public.profile_birthdays where user_id=v_user;
  return jsonb_build_object('day',v_profile.day,'month',v_profile.month,'share_with_groups',coalesce(v_profile.share_with_groups,false));
end $$;
create function public.xelay_save_my_birthday_profile(p_day integer,p_month integer,p_share_with_groups boolean default false)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_now timestamptz:=public.xelay_private_birthday_gift_clock();
begin
  if not public.xelay_private_birthday_active(v_user,v_now) then raise exception 'PROFILE_BIRTHDAY_AUTH_REQUIRED' using errcode='42501';end if;
  if p_share_with_groups is null or(p_day is null)<>(p_month is null)
    or(p_day is null and p_share_with_groups)
    or(p_month is not null and(p_month not between 1 and 12 or p_day not between 1 and
      case when p_month=2 then 29 when p_month in(4,6,9,11) then 30 else 31 end)) then
    raise exception 'PROFILE_BIRTHDAY_INVALID_DATE' using errcode='22023';end if;
  insert into public.profile_birthdays as b(user_id,day,month,share_with_groups,updated_at,consent_updated_at)
    values(v_user,p_day,p_month,p_share_with_groups,v_now,v_now)
    on conflict(user_id) do update set day=excluded.day,month=excluded.month,share_with_groups=excluded.share_with_groups,
      disclosure_revision=b.disclosure_revision+case when row(b.day,b.month,b.share_with_groups)
        is distinct from row(excluded.day,excluded.month,excluded.share_with_groups) then 1 else 0 end,
      notice_version='2026-10-29.1',consent_updated_at=case when b.share_with_groups is distinct from excluded.share_with_groups
        then v_now else b.consent_updated_at end,
      updated_at=case when row(b.day,b.month,b.share_with_groups)
        is distinct from row(excluded.day,excluded.month,excluded.share_with_groups) then v_now else b.updated_at end;
  return jsonb_build_object('day',p_day,'month',p_month,'share_with_groups',p_share_with_groups);
end $$;

create function public.xelay_group_birthdays(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_today date;v_year integer;v_result jsonb;
begin
  if not public.xelay_private_birthday_active(v_user,v_now) or not public.xelay_private_birthday_group_member(p_group_id,v_user) then
    raise exception 'PROFILE_BIRTHDAY_GROUP_UNAVAILABLE' using errcode='42501';end if;
  v_today:=(v_now at time zone 'Europe/Kyiv')::date;v_year:=extract(year from v_today)::integer;
  with members as(select g.representative_id user_id from public.study_groups g where g.id=p_group_id
    union select m.user_id from public.study_group_members m where m.group_id=p_group_id and m.status='accepted'),
  upcoming as(select b.user_id,coalesce(nullif(p.full_name,''),'Учасник Xelay') full_name,nullif(p.avatar_url,'') avatar_url,b.day,b.month,
      case when public.xelay_private_birthday_observed_date(b.day,b.month,v_year)>=v_today
        then public.xelay_private_birthday_observed_date(b.day,b.month,v_year)
        else public.xelay_private_birthday_observed_date(b.day,b.month,v_year+1) end observed_on
    from members m join public.profile_birthdays b on b.user_id=m.user_id join public.profiles p on p.id=b.user_id
    where b.share_with_groups and b.month is not null and public.xelay_private_birthday_active(b.user_id,v_now)),
  visible as(select user_id,full_name,avatar_url,day,month,(observed_on-v_today)::integer days_until,observed_on=v_today is_today
    from upcoming where observed_on between v_today and v_today+7 order by observed_on,full_name,user_id limit 200)
  select coalesce(jsonb_agg(to_jsonb(v) order by v.days_until,v.full_name,v.user_id),'[]'::jsonb) into v_result from visible v;
  return v_result;
end $$;

create function public.xelay_can_read_group_birthday(p_event uuid,p_recipient uuid,p_actor uuid,p_group uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and p_recipient=auth.uid() and exists(
    select 1 from public.birthday_profile_dispatches d join public.profile_birthdays b on b.user_id=d.user_id
    where d.id=p_event and d.recipient_id=p_recipient and d.user_id=p_actor and d.group_id=p_group
      and d.observed_on=(public.xelay_private_birthday_gift_clock() at time zone 'Europe/Kyiv')::date
      and b.share_with_groups and b.month is not null and b.disclosure_revision=d.disclosure_revision
      and public.xelay_private_birthday_group_member(d.group_id,d.user_id)
      and public.xelay_private_birthday_group_member(d.group_id,d.recipient_id)
      and public.xelay_private_birthday_active(d.user_id,public.xelay_private_birthday_gift_clock())
      and public.xelay_private_birthday_notification_recipient(d.recipient_id,public.xelay_private_birthday_gift_clock()));
$$;
create policy "Group birthday notifications live privacy" on public.notifications as restrictive for select to anon,authenticated
  using(type is distinct from 'group_birthday' or public.xelay_can_read_group_birthday(birthday_event_id,recipient_id::uuid,actor_id::uuid,study_group_id));
create policy "Group birthday notifications server insert" on public.notifications as restrictive for insert to anon,authenticated
  with check(type is distinct from 'group_birthday' and birthday_event_id is null);
create function public.xelay_guard_group_birthday_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if(old.type='group_birthday' and(to_jsonb(new)-'is_read') is distinct from(to_jsonb(old)-'is_read'))
    or(old.type is distinct from 'group_birthday' and(new.type='group_birthday' or new.birthday_event_id is not null)) then
    raise exception 'PROFILE_BIRTHDAY_NOTIFICATION_IMMUTABLE' using errcode='42501';end if;
  return new;
end $$;
create trigger group_birthday_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_group_birthday_notification_update();

create function public.xelay_private_ensure_profile_birthday_gift(p_user uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_today date;v_year integer;
  v_profile public.profile_birthdays%rowtype;v_notification uuid;v_gift uuid;
begin
  v_today:=(v_now at time zone 'Europe/Kyiv')::date;v_year:=extract(year from v_today)::integer;
  select * into v_profile from public.profile_birthdays where user_id=p_user;
  if not found or v_profile.month is null or public.xelay_private_birthday_observed_date(v_profile.day,v_profile.month,v_year)<>v_today
    or not public.xelay_private_birthday_active(p_user,v_now)
    or not exists(select 1 from auth.users u where u.id=p_user and u.email_confirmed_at is not null) then return false;end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:birthday-gift:'||p_user::text||':'||v_year::text,0));
  if exists(select 1 from public.birthday_gifts where recipient_id=p_user and gift_year=v_year) then return false;end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,created_at)
    values(p_user,p_user,'Xelay','birthday_gift','З днем народження! Даруємо вам місяць «Учасника». Відкрийте подарунок і натисніть «Забрати». Без оплати та автопродовження.',false,v_now)
    returning id into v_notification;
  insert into public.birthday_gifts(recipient_id,greeting_name,gift_year,notification_id,offered_by,offered_at)
    values(p_user,'',v_year,v_notification,null,v_now) returning id into v_gift;
  insert into public.billing_audit_log(actor_id,action,target_user_id,detail)
    values(null,'birthday_gift_automatic_offer',p_user,jsonb_build_object('gift_id',v_gift,'gift_year',v_year,'months',1));
  return true;
end $$;

-- Preserve the existing list, claim/reflow implementation and recipient ACL.
-- One current list request ensures only the caller's eligible birthday offer.
do $own_inbox$
declare v_definition text;v_source text;v_expected text;v_after text;
  v_metadata_before jsonb;v_metadata_after jsonb;v_match text[];v_matches integer;v_insert text;
  v_auth text:=$auth$if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;$auth$;
  v_pattern text;
begin
  select pg_get_functiondef(p.oid),p.prosrc,to_jsonb(p)-'prosrc'
    into v_definition,v_source,v_metadata_before from pg_proc p where p.oid='public.xelay_my_birthday_gifts()'::regprocedure;
  -- Only whitespace before the exact existing authentication statement is
  -- flexible. Preserve every original source byte, including CRLF, elsewhere.
  v_pattern:=E'((^|\\n)([ \\t]*)'||v_auth||E'(\\r?\\n))';
  select count(*) into v_matches from regexp_matches(v_source,v_pattern,'g');
  if v_matches<>1 or(length(v_source)-length(replace(v_source,v_auth,'')))/length(v_auth)<>1
    or(length(v_definition)-length(replace(v_definition,v_source,'')))/length(v_source)<>1 then
    raise exception 'PROFILE_BIRTHDAY_INBOX_SOURCE_DRIFT';end if;
  select hit into v_match from regexp_matches(v_source,v_pattern,'g') hit;
  v_insert:=v_match[1]||v_match[3]||'perform public.xelay_private_ensure_profile_birthday_gift(v_user);'||v_match[4];
  v_expected:=replace(v_source,v_match[1],v_insert);
  execute replace(v_definition,v_source,v_expected);
  select p.prosrc,to_jsonb(p)-'prosrc' into v_after,v_metadata_after from pg_proc p
    where p.oid='public.xelay_my_birthday_gifts()'::regprocedure;
  if v_after is distinct from v_expected or replace(v_after,v_insert,v_match[1]) is distinct from v_source
    or v_metadata_after is distinct from v_metadata_before then
    raise exception 'PROFILE_BIRTHDAY_INBOX_UNEXPECTED_CHANGE';end if;
end $own_inbox$;
alter function public.xelay_my_birthday_gifts() volatile;

create function public.xelay_process_due_birthdays(p_limit integer default 100)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='1s' as $$
declare v_now timestamptz:=public.xelay_private_birthday_gift_clock();v_today date;v_year integer;
  v_profile record;v_person record;v_state public.birthday_profile_anniversaries%rowtype;v_event uuid;
  v_processed integer:=0;v_gifts integer:=0;v_notices integer:=0;v_remaining integer;v_more boolean:=false;
  v_deadline timestamptz:=clock_timestamp()+interval '8 seconds';
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'PROFILE_BIRTHDAY_WORKER_FORBIDDEN' using errcode='42501';end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'PROFILE_BIRTHDAY_INVALID_LIMIT' using errcode='22023';end if;
  v_today:=(v_now at time zone 'Europe/Kyiv')::date;v_year:=extract(year from v_today)::integer;v_remaining:=p_limit;
  for v_profile in select b.* from public.profile_birthdays b
    where b.month=extract(month from v_today)::integer
      and(b.day=extract(day from v_today)::integer or(b.month=2 and b.day=29 and extract(day from v_today)=28))
      and public.xelay_private_birthday_observed_date(b.day,b.month,v_year)=v_today
      and public.xelay_private_birthday_active(b.user_id,v_now)
      and exists(select 1 from auth.users u where u.id=b.user_id and u.email_confirmed_at is not null)
      and(not exists(select 1 from public.birthday_gifts g where g.recipient_id=b.user_id and g.gift_year=v_year)
        or(b.share_with_groups and not exists(select 1 from public.birthday_profile_anniversaries a
          where a.user_id=b.user_id and a.event_year=v_year and a.completed)))
    order by b.user_id limit p_limit for update of b skip locked loop
    if clock_timestamp()>v_deadline then v_more:=true;exit;end if;
    v_processed:=v_processed+1;
    if public.xelay_private_ensure_profile_birthday_gift(v_profile.user_id) then v_gifts:=v_gifts+1;end if;
    if not v_profile.share_with_groups or v_remaining=0 then continue;end if;
    insert into public.birthday_profile_anniversaries(user_id,event_year,observed_on,disclosure_revision)
      values(v_profile.user_id,v_year,v_today,v_profile.disclosure_revision) on conflict do nothing;
    select * into v_state from public.birthday_profile_anniversaries where user_id=v_profile.user_id and event_year=v_year for update;
    if v_state.observed_on<>v_today or v_state.disclosure_revision<>v_profile.disclosure_revision then
      update public.birthday_profile_anniversaries set completed=true where user_id=v_profile.user_id and event_year=v_year;continue;end if;
    for v_person in with shared_groups as(select g.id from public.study_groups g where g.representative_id=v_profile.user_id
        union select m.group_id from public.study_group_members m where m.user_id=v_profile.user_id and m.status='accepted'),
      audience as(select g.representative_id user_id,g.id group_id from public.study_groups g join shared_groups s on s.id=g.id
        union select m.user_id,m.group_id from public.study_group_members m join shared_groups s on s.id=m.group_id where m.status='accepted'),
      people as(select distinct on(a.user_id) a.user_id,a.group_id from audience a
        where a.user_id<>v_profile.user_id and public.xelay_private_birthday_notification_recipient(a.user_id,v_now)
          and not exists(select 1 from public.birthday_profile_dispatches d where d.user_id=v_profile.user_id and d.recipient_id=a.user_id and d.event_year=v_year)
        order by a.user_id,a.group_id)
      select * from people order by user_id limit v_remaining loop
      if clock_timestamp()>v_deadline then v_more:=true;exit;end if;
      insert into public.birthday_profile_dispatches(user_id,recipient_id,group_id,event_year,observed_on,disclosure_revision)
        values(v_profile.user_id,v_person.user_id,v_person.group_id,v_year,v_today,v_profile.disclosure_revision)
        returning id into v_event;
      insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,created_at,study_group_id,birthday_event_id)
        select v_person.user_id,v_profile.user_id,coalesce(nullif(p.full_name,''),'Учасник Xelay'),'group_birthday',
          'Сьогодні день народження у вашого одногрупника чи одногрупниці. Привітайте, якщо маєте бажання!',false,v_now,v_person.group_id,v_event
        from public.profiles p where p.id=v_profile.user_id;
      v_notices:=v_notices+1;v_remaining:=v_remaining-1;
    end loop;
    update public.birthday_profile_anniversaries a set completed=not exists(
      select 1 from(select g.id,g.representative_id from public.study_groups g where g.representative_id=v_profile.user_id
        union select g.id,g.representative_id from public.study_groups g join public.study_group_members self on self.group_id=g.id
          where self.user_id=v_profile.user_id and self.status='accepted') g
      where exists(select 1 from(select g.representative_id user_id union select m.user_id from public.study_group_members m
        where m.group_id=g.id and m.status='accepted') person where person.user_id<>v_profile.user_id
        and public.xelay_private_birthday_notification_recipient(person.user_id,v_now)
        and not exists(select 1 from public.birthday_profile_dispatches d where d.user_id=v_profile.user_id
          and d.recipient_id=person.user_id and d.event_year=v_year)))
      where a.user_id=v_profile.user_id and a.event_year=v_year;
  end loop;
  v_more:=v_more or exists(select 1 from public.profile_birthdays b where b.month=extract(month from v_today)::integer
    and(b.day=extract(day from v_today)::integer or(b.month=2 and b.day=29 and extract(day from v_today)=28))
    and public.xelay_private_birthday_observed_date(b.day,b.month,v_year)=v_today
    and public.xelay_private_birthday_active(b.user_id,v_now)
    and exists(select 1 from auth.users u where u.id=b.user_id and u.email_confirmed_at is not null)
    and(not exists(select 1 from public.birthday_gifts g where g.recipient_id=b.user_id and g.gift_year=v_year)
      or(b.share_with_groups and not exists(select 1 from public.birthday_profile_anniversaries a where a.user_id=b.user_id and a.event_year=v_year and a.completed))));
  return jsonb_build_object('today',v_today,'processed',v_processed,'gifts_offered',v_gifts,'group_notifications',v_notices,'has_more',v_more);
end $$;

-- Preserve each inspected delivery trigger's prior predicate and function. Only
-- add the new birthday type exclusion; do not alter queue/delivery bodies/jobs.
do $delivery_boundary$
declare v_name text;v_definition text;v_qual text;v_function text;
begin
  foreach v_name in array array['notification_email_queue','xelay_participant_push_queue'] loop
    select pg_get_triggerdef(oid) into v_definition from pg_trigger where tgrelid='public.notifications'::regclass and tgname=v_name and not tgisinternal;
    v_qual:=substring(v_definition from ' FOR EACH ROW WHEN \((.*)\) EXECUTE FUNCTION ');
    if v_name='notification_email_queue' and v_qual is null then raise exception 'PROFILE_BIRTHDAY_EMAIL_PREDICATE_MISSING';end if;
    v_function:=case when v_name='notification_email_queue' then 'public.xelay_queue_notification_email()' else 'public.xelay_queue_participant_push()' end;
    execute format('drop trigger %I on public.notifications',v_name);
    execute format('create trigger %I after insert on public.notifications for each row when (%s) execute function %s',v_name,
      case when v_qual is null then 'new.type is distinct from ''group_birthday''' else '('||v_qual||') and new.type is distinct from ''group_birthday''' end,v_function);
  end loop;
end $delivery_boundary$;

revoke all on function public.xelay_private_birthday_observed_date(integer,integer,integer),
  public.xelay_private_birthday_active(uuid,timestamptz),public.xelay_private_birthday_group_member(uuid,uuid),
  public.xelay_private_birthday_notification_recipient(uuid,timestamptz),
  public.xelay_my_birthday_profile(),public.xelay_save_my_birthday_profile(integer,integer,boolean),public.xelay_group_birthdays(uuid),
  public.xelay_can_read_group_birthday(uuid,uuid,uuid,uuid),public.xelay_guard_group_birthday_notification_update(),
  public.xelay_private_ensure_profile_birthday_gift(uuid),public.xelay_process_due_birthdays(integer)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_birthday_profile(),public.xelay_save_my_birthday_profile(integer,integer,boolean),
  public.xelay_group_birthdays(uuid),public.xelay_can_read_group_birthday(uuid,uuid,uuid,uuid) to authenticated;
grant execute on function public.xelay_process_due_birthdays(integer) to service_role;

comment on table public.profile_birthdays is 'Optional private day/month only, no year/age. Sharing with current accepted academic group members is off by default; revisions invalidate existing group notices after any actual date/consent change.';
comment on column public.profile_birthdays.notice_version is 'Fixed server-owned feature notice version, not a caller-supplied consent or a base account consent replacement.';
comment on column public.profile_birthdays.consent_updated_at is 'Server timestamp of the initial saved feature choice or an actual group-sharing preference change.';
comment on table public.birthday_profile_anniversaries is 'Private server calendar-year fanout state, not a birth year. Separate from gifts so opting in later on the birthday can still announce once.';
comment on function public.xelay_group_birthdays(uuid) is 'Current representative/accepted academic members only; upcoming 7 days, max200. No admin or teacher-only grant. Server Europe/Kyiv clock; February29 observed February28 in non-leap years.';
comment on function public.xelay_process_due_birthdays(integer) is 'Service-only bounded existing-worker hook. Up to100 profiles and100 group notices per invocation, 8-second loop deadline. No emails/push/newcron/entitlement until existing recipient claim.';
notify pgrst,'reload schema';
commit;
