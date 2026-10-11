-- Dormant foundation: DO NOT apply to Production until the local workspace is accepted.
-- Existing billing, student profiles and authentication triggers are untouched.
begin;
do $$ begin
  if to_regclass('auth.users') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regclass('storage.objects') is null or to_regclass('public.notification_preferences') is null
    or to_regclass('public.profiles') is null or to_regclass('public.user_roles') is null
    or to_regclass('public.universities') is null then
    raise exception 'Opportunities prerequisites missing';
  end if;
end $$;

create table if not exists public.opportunities_settings (
  id boolean primary key default true check(id),
  data jsonb not null default '{"enabled":false,"advertisingEnabled":false,"entryEnabled":false,"entryFrequencyDays":7,"promotedEvery":8,"minimumSegmentSize":30}'::jsonb
);
insert into public.opportunities_settings(id) values(true) on conflict do nothing;
create table if not exists public.opportunities_companies (
  id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
  revision integer not null default 1 check(revision>=1),
  status text not null check(status in ('draft','pending','approved','changes','rejected','paused','closed')),
  data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now()
);
create table if not exists public.opportunities_members (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.opportunities_companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, email text not null,
  role text not null check(role in ('owner','editor','recruiter')),
  status text not null check(status in ('pending','accepted','revoked')),
  created_at timestamptz not null default now(), unique(company_id,user_id)
);
create table if not exists public.opportunities_items (
  id uuid primary key, company_id uuid not null references public.opportunities_companies(id) on delete cascade,
  revision integer not null default 1 check(revision>=1),
  status text not null check(status in ('draft','pending','approved','changes','rejected','paused','closed')),
  deadline date, data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now(), published_at timestamptz
);
create table if not exists public.opportunities_resumes (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  id uuid unique not null, version integer not null check(version>0),
  visibility text not null check(visibility in ('private','employers')),
  data jsonb not null check(jsonb_typeof(data)='object'), updated_at timestamptz not null default now()
);
create table if not exists public.opportunities_applications (
  id uuid primary key default gen_random_uuid(), opportunity_id uuid not null references public.opportunities_items(id) on delete cascade,
  company_id uuid not null references public.opportunities_companies(id) on delete cascade,
  student_id uuid not null references auth.users(id) on delete cascade,
  status text not null check(status in ('sent','reviewing','invited','completed','withdrawn')),
  data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique(opportunity_id,student_id)
);
create table if not exists public.opportunities_campaigns (
  id uuid primary key, company_id uuid not null references public.opportunities_companies(id) on delete cascade,
  revision integer not null default 1 check(revision>=1),
  opportunity_id uuid not null references public.opportunities_items(id) on delete cascade,
  status text not null check(status in ('draft','pending','approved','changes','rejected','paused','closed')),
  starts_at timestamptz not null, ends_at timestamptz not null check(ends_at>starts_at),
  data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now()
);
create table if not exists public.opportunities_orders (
  id uuid primary key, campaign_id uuid not null references public.opportunities_campaigns(id) on delete cascade,
  company_id uuid not null references public.opportunities_companies(id) on delete cascade,
  status text not null check(status in ('draft','awaiting_payment','paid','cancelled','refunded')),
  amount numeric(12,2) not null check(amount>=1 and amount<=149999),
  data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now()
);
create table if not exists public.opportunities_personal (
  user_id uuid primary key references auth.users(id) on delete cascade,
  saved_ids uuid[] not null default '{}', hidden_ids uuid[] not null default '{}',
  preferences jsonb not null default '{"digest":false,"directions":[],"hiddenCompanyIds":[],"lastEntryAt":null}'::jsonb
);
create table if not exists public.opportunities_events (
  id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.opportunities_campaigns(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  type text not null check(type in ('impression','click','save','hide')),
  placement text not null check(placement in ('catalog','home','news','entry')),
  created_at timestamptz not null default now()
);
create table if not exists public.opportunities_entry_reservations (
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id uuid not null references public.opportunities_campaigns(id) on delete cascade,
  reserved_at timestamptz not null default now(), expires_at timestamptz not null,
  impression_recorded boolean not null default false, primary key(user_id,campaign_id)
);
create table if not exists public.opportunities_reports (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null references auth.users(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities_items(id) on delete cascade,
  reason text not null check(length(reason) between 3 and 2000), status text not null default 'open' check(status in ('open','resolved')),
  created_at timestamptz not null default now()
);
create table if not exists public.opportunities_notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  title text not null, body text not null, read boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.opportunities_audit (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null, entity_id text not null default '', note text not null default '', created_at timestamptz not null default now()
);
create table if not exists public.opportunities_files (
  id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
  path text unique not null, kind text not null check(kind in ('resume','company','opportunity')),
  data jsonb not null check(jsonb_typeof(data)='object'), created_at timestamptz not null default now()
);
create table if not exists public.opportunities_verified_uploads (
  path text primary key, object_id uuid unique not null, owner_id uuid not null references auth.users(id) on delete cascade,
  object_updated_at timestamptz not null, size bigint not null check(size between 5 and 10485760),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), verified_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '2 minutes'
);
create table if not exists public.opportunities_file_validation_budget (
  day date not null, owner_id uuid not null references auth.users(id) on delete cascade,
  attempts integer not null check(attempts between 1 and 60), primary key(day,owner_id)
);
create table if not exists public.opportunities_business_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check(length(full_name) between 2 and 120),
  company_name text not null check(length(company_name) between 2 and 180),
  terms_version text not null, created_at timestamptz not null default now()
);
create table if not exists public.opportunities_digest_outbox (
  id uuid primary key default gen_random_uuid(), recipient_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null, opportunity_ids uuid[] not null,
  status text not null default 'pending' check(status in ('pending','processing','sent','skipped','failed')),
  attempts integer not null default 0, available_at timestamptz not null default now(),
  claim_token uuid, locked_at timestamptz, delivery_started_at timestamptz, provider_message_id text, completed_at timestamptz,
  error_code text, created_at timestamptz not null default now(), unique(recipient_id,week_start)
);
alter table public.opportunities_items add column if not exists published_at timestamptz;
alter table public.opportunities_companies add column if not exists revision integer not null default 1 check(revision>=1);
alter table public.opportunities_items add column if not exists revision integer not null default 1 check(revision>=1);
alter table public.opportunities_campaigns add column if not exists revision integer not null default 1 check(revision>=1);
alter table public.opportunities_digest_outbox add column if not exists delivery_started_at timestamptz;
create index if not exists opportunities_members_user_idx on public.opportunities_members(user_id,status);
create index if not exists opportunities_items_catalog_idx on public.opportunities_items(status,deadline);
create index if not exists opportunities_items_published_idx on public.opportunities_items(published_at desc) where status='approved';
create index if not exists opportunities_apps_company_idx on public.opportunities_applications(company_id,created_at desc);
create index if not exists opportunities_events_frequency_idx on public.opportunities_events(actor_id,placement,type,created_at desc);
create index if not exists opportunities_events_campaign_idx on public.opportunities_events(campaign_id,created_at desc);

do $$ declare v_table text; begin
  foreach v_table in array array['opportunities_settings','opportunities_companies','opportunities_members','opportunities_items',
    'opportunities_resumes','opportunities_applications','opportunities_campaigns','opportunities_orders','opportunities_personal',
    'opportunities_events','opportunities_entry_reservations','opportunities_reports','opportunities_notifications','opportunities_audit','opportunities_files','opportunities_verified_uploads','opportunities_file_validation_budget','opportunities_business_accounts','opportunities_digest_outbox'] loop
    execute format('alter table public.%I enable row level security',v_table);
    execute format('revoke all on table public.%I from public,anon,authenticated,service_role',v_table);
  end loop;
end $$;

create or replace function public.xelay_opportunities_company_role(p_company_id uuid)
returns text language sql stable security definer set search_path=public,pg_temp as $$
  select case when c.owner_id=auth.uid() then 'owner' else
    (select m.role from public.opportunities_members m where m.company_id=c.id and m.user_id=auth.uid() and m.status='accepted') end
  from public.opportunities_companies c where c.id=p_company_id and auth.uid() is not null;
$$;
create or replace function public.xelay_opportunities_enabled()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce((data->>'enabled')::boolean,false) from public.opportunities_settings where id;
$$;
create or replace function public.xelay_opportunities_name(p_user_id uuid)
returns text language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(nullif(p.full_name,''),nullif(u.raw_user_meta_data->>'full_name',''),'Користувач')
  from auth.users u left join public.profiles p on p.id=u.id where u.id=p_user_id;
$$;
create or replace function public.xelay_opportunities_pick(p_data jsonb,p_keys text[])
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(p_data) where key=any(p_keys);
$$;
create or replace function public.xelay_opportunities_validate(p_data jsonb)
returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare v record; begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>65536 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  for v in select key,value from jsonb_each(p_data) loop
    if v.key in ('fullName','headline','about','education','languages','experience','projects','city','format','availability','salary','portfolioUrl','contact',
      'name','tagline','description','industry','website','contactEmail','contactName','legalName','registrationCode','logo','color','kind','title','summary','requirements',
      'benefits','employment','compensation','paid','direction','deadline','startsAt','endsAt','applicationMode','externalUrl','body','image','cta','url','label','terms')
      and jsonb_typeof(v.value) is distinct from 'string' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if jsonb_typeof(v.value)='string' and (length(v.value#>>'{}')>10000
      or regexp_replace(v.value#>>'{}','[\t\n\r]','','g')~'[[:cntrl:]]') then
      raise exception 'OPPORTUNITIES_INVALID_INPUT';
    end if;
    if v.key in ('website','portfolioUrl','externalUrl','url','logo','image') and coalesce(v.value#>>'{}','')<>''
      and ((v.value#>>'{}')!~'^https://[[:alnum:]][[:alnum:].:-]*(/[^[:space:]]*)?([?#][^[:space:]]*)?$'
        or strpos(v.value#>>'{}',chr(92))>0 or length(v.value#>>'{}')>2000) then
      raise exception 'OPPORTUNITIES_INVALID_INPUT';
    end if;
    if jsonb_typeof(v.value)='array' and jsonb_array_length(v.value)>50 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  end loop;
end $$;

create or replace function public.xelay_opportunities_strings(p_data jsonb,p_keys text[])
returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare v_key text; begin
  foreach v_key in array p_keys loop
    if jsonb_typeof(p_data->v_key) is distinct from 'string' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  end loop;
end $$;

create or replace function public.xelay_opportunities_file(p_file jsonb,p_kind text)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_file jsonb; begin
  if p_file is null or p_file='null'::jsonb then return 'null'::jsonb; end if;
  select f.data into v_file from public.opportunities_files f where f.id=(p_file->>'id')::uuid
    and f.owner_id=auth.uid() and f.kind=p_kind;
  if not found then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  return v_file;
end $$;

create or replace function public.xelay_opportunities_business_registration()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_meta jsonb:=coalesce(new.raw_user_meta_data,'{}'::jsonb); begin
  if v_meta->>'xelay_registration_version' is distinct from 'company-1' then return new; end if;
  if not public.xelay_opportunities_enabled() then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  if v_meta->>'registration_kind' is distinct from 'company'
    or length(btrim(coalesce(v_meta->>'full_name',''))) not between 2 and 120
    or length(btrim(coalesce(v_meta->>'company_name',''))) not between 2 and 180
    or new.email is null or v_meta->>'company_terms_version' is distinct from 'opportunities-v1'
    then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  insert into public.opportunities_business_accounts(user_id,full_name,company_name,terms_version)
    values(new.id,btrim(v_meta->>'full_name'),btrim(v_meta->>'company_name'),'opportunities-v1');
  return new;
end $$;
drop trigger if exists xelay_opportunities_business_signup on auth.users;
create trigger xelay_opportunities_business_signup after insert on auth.users for each row
  execute function public.xelay_opportunities_business_registration();

create or replace function public.xelay_opportunities_notify_company(p_company_id uuid,p_title text,p_body text)
returns void language sql security definer set search_path=public,pg_temp as $$
  insert into public.opportunities_notifications(user_id,title,body)
    select owner_id,p_title,p_body from public.opportunities_companies where id=p_company_id
    union select user_id,p_title,p_body from public.opportunities_members
      where company_id=p_company_id and status='accepted' and role in ('editor','recruiter');
$$;

create or replace function public.xelay_opportunities_notify_admins(p_title text,p_body text)
returns void language sql security definer set search_path=public,pg_temp as $$
  insert into public.opportunities_notifications(user_id,title,body)
    select distinct user_id,p_title,p_body from public.user_roles where role='ADMIN';
$$;

create or replace function public.xelay_opportunities_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_uid uuid:=auth.uid(); v_admin boolean; v_type text; v_id uuid; v_company_id uuid; v_target uuid;
  v_role text; v_status text; v_data jsonb; v_old jsonb; v_file jsonb; v_files jsonb; v_settings jsonb;
  v_name text; v_email text; v_note text; v_count integer; v_version integer; v_revision integer; v_preferences jsonb;
  v_resume jsonb; v_item public.opportunities_items%rowtype; v_application public.opportunities_applications%rowtype;
  v_member public.opportunities_members%rowtype; v_campaign public.opportunities_campaigns%rowtype;
  v_order public.opportunities_orders%rowtype; v_start timestamptz; v_end timestamptz; v_key text;
begin
  if v_uid is null then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=v_uid and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then
    raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>100000 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  v_admin:=public.xelay_is_platform_admin(); v_type:=p_command->>'type';
  if not public.xelay_opportunities_enabled() and not v_admin then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  -- Serializes edits/invites/applications/payments in the first release; use per-company locks if scale warrants it.
  perform pg_advisory_xact_lock(hashtextextended('xelay:opportunities:commands',0));
  select data into v_settings from public.opportunities_settings where id;
  if exists(select 1 from public.opportunities_audit where actor_id=v_uid and created_at>now()-interval '1 minute'
    group by actor_id having count(*)>=100) then raise exception 'OPPORTUNITIES_LIMIT'; end if;
  if p_command ? 'id' then v_id:=(p_command->>'id')::uuid; end if;
  case v_type
  when 'resume.save' then
    v_data:=p_command->'resume'; perform public.xelay_opportunities_validate(v_data);
    perform public.xelay_opportunities_strings(v_data,array['fullName','headline','about','education','languages','experience','projects','city','format','availability','salary','portfolioUrl','contact','visibility']);
    if length(btrim(coalesce(v_data->>'fullName',''))) not between 2 and 120
      or v_data->>'visibility' not in ('private','employers') or jsonb_typeof(v_data->'skills') is distinct from 'array'
      or jsonb_typeof(v_data->'seeking') is distinct from 'array' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if exists(select 1 from jsonb_array_elements(v_data->'skills') s where jsonb_typeof(s)<>'string' or length(s#>>'{}')>120)
      or exists(select 1 from jsonb_array_elements_text(v_data->'seeking') s where s not in ('job','internship','course','event','scholarship','offer')) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_file:=public.xelay_opportunities_file(v_data->'file','resume');
    select data,version,id into v_old,v_version,v_id from public.opportunities_resumes where owner_id=v_uid;
    v_id:=coalesce(v_id,gen_random_uuid()); v_version:=coalesce(v_version,0)+1;
    v_data:=public.xelay_opportunities_pick(v_data,array['fullName','headline','about','education','skills','languages','experience','projects','city','format','availability','salary','portfolioUrl','contact','seeking','visibility'])
      ||jsonb_build_object('id',v_id,'ownerId',v_uid,'file',v_file,'version',v_version,'updatedAt',now());
    insert into public.opportunities_resumes(owner_id,id,version,visibility,data) values(v_uid,v_id,v_version,v_data->>'visibility',v_data)
      on conflict(owner_id) do update set version=excluded.version,visibility=excluded.visibility,data=excluded.data,updated_at=now();
  when 'company.save' then
    v_data:=p_command->'company'; perform public.xelay_opportunities_validate(v_data); v_id:=(v_data->>'id')::uuid;
    perform public.xelay_opportunities_strings(v_data,array['name','tagline','description','industry','city','website','contactEmail','contactName','legalName','registrationCode','logo','color']);
    if v_data->>'color'!~'^#[a-fA-F0-9]{6}$' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if length(btrim(coalesce(v_data->>'name',''))) not between 2 and 180 or length(coalesce(v_data->>'tagline',''))>240 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select data,revision into v_old,v_revision from public.opportunities_companies where id=v_id;
    if found then
      if public.xelay_opportunities_company_role(v_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    else
      if (select count(*) from public.opportunities_companies where owner_id=v_uid)>=3 then raise exception 'OPPORTUNITIES_LIMIT'; end if;
      v_old:=jsonb_build_object('ownerId',v_uid,'partner',false,'createdAt',now());
    end if;
    v_revision:=coalesce(v_revision,0)+1;
    v_data:=public.xelay_opportunities_pick(v_data,array['name','tagline','description','industry','city','website','contactEmail','contactName','legalName','registrationCode','logo','color'])
      ||jsonb_build_object('id',v_id,'ownerId',v_old->>'ownerId','partner',coalesce((v_old->>'partner')::boolean,false),'createdAt',v_old->'createdAt','status','draft','reviewNote','','revision',v_revision);
    insert into public.opportunities_companies(id,owner_id,status,data,revision) values(v_id,(v_old->>'ownerId')::uuid,'draft',v_data,v_revision)
      on conflict(id) do update set status='draft',data=excluded.data,revision=excluded.revision;
  when 'company.submit' then
    if public.xelay_opportunities_company_role(v_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select data into v_data from public.opportunities_companies where id=v_id;
    if length(btrim(coalesce(v_data->>'legalName',''))) not between 2 and 180
      or length(btrim(coalesce(v_data->>'registrationCode',''))) not between 2 and 40
      or coalesce(v_data->>'contactEmail','')!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    update public.opportunities_companies set status='pending',revision=revision+1,data=data||jsonb_build_object('status','pending','reviewNote','','revision',revision+1) where id=v_id and status in ('draft','changes','rejected');
    if not found then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    perform public.xelay_opportunities_notify_admins('Перевірка компанії','Компанія подала заявку на перевірку.');
  when 'company.review' then
    if not v_admin then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    v_status:=p_command->>'status'; v_note:=left(coalesce(p_command->>'note',''),2000);
    if v_status not in ('approved','changes','rejected') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select revision into v_revision from public.opportunities_companies where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if coalesce((p_command->>'expectedRevision')::int,0)<>v_revision then raise exception 'OPPORTUNITIES_STALE'; end if;
    update public.opportunities_companies set status=v_status,revision=revision+1,data=data||jsonb_build_object('status',v_status,'reviewNote',v_note,'partner',coalesce((p_command->>'partner')::boolean,(data->>'partner')::boolean,false),'revision',revision+1) where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    perform public.xelay_opportunities_notify_company(v_id,'Перевірка компанії',coalesce(nullif(v_note,''),'Статус компанії оновлено.'));
  when 'company.invite' then
    v_company_id:=(p_command->>'companyId')::uuid; v_role:=p_command->>'role'; v_email:=lower(btrim(p_command->>'email'));
    if public.xelay_opportunities_company_role(v_company_id) is distinct from 'owner' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if v_role not in ('editor','recruiter') or length(v_email)>254 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if (select count(*) from public.opportunities_members where company_id=v_company_id and status in ('pending','accepted'))>=20 then raise exception 'OPPORTUNITIES_LIMIT'; end if;
    select id into v_target from auth.users where lower(email)=v_email and email_confirmed_at is not null
      and deleted_at is null and (banned_until is null or banned_until<=now());
    if not found or v_target=v_uid then raise exception 'OPPORTUNITIES_INVITATION_UNAVAILABLE'; end if;
    insert into public.opportunities_members(company_id,user_id,email,role,status) values(v_company_id,v_target,v_email,v_role,'pending')
      on conflict(company_id,user_id) do update set role=excluded.role,status='pending',email=excluded.email;
    insert into public.opportunities_notifications(user_id,title,body) values(v_target,'Запрошення до компанії','Відкрийте «Для компаній», щоб прийняти запрошення або відхилити його.');
  when 'company.member' then
    select * into v_member from public.opportunities_members where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    v_status:=p_command->>'status';
    if v_status='accepted' then
      if v_member.user_id<>v_uid or v_member.status<>'pending' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    elsif v_status='revoked' then
      if v_member.user_id<>v_uid and public.xelay_opportunities_company_role(v_member.company_id) is distinct from 'owner' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    else raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    update public.opportunities_members set status=v_status where id=v_id and role<>'owner';
  when 'opportunity.save' then
    v_data:=p_command->'opportunity'; perform public.xelay_opportunities_validate(v_data);
    perform public.xelay_opportunities_strings(v_data,array['kind','title','summary','description','requirements','benefits','city','format','employment','experience','compensation','paid','direction','deadline','startsAt','applicationMode','externalUrl']);
    v_id:=(v_data->>'id')::uuid; v_company_id:=(v_data->>'companyId')::uuid;
    if public.xelay_opportunities_company_role(v_company_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_company_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select data,revision into v_old,v_revision from public.opportunities_items where id=v_id;
    if found and (v_old->>'companyId')::uuid<>v_company_id then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if v_data->>'kind' not in ('job','internship','course','event','scholarship','offer') or length(btrim(coalesce(v_data->>'title',''))) not between 3 and 180
      or v_data->>'format' not in ('remote','office','hybrid') or v_data->>'paid' not in ('yes','no','unspecified')
      or v_data->>'applicationMode' not in ('internal','external') or (v_data->>'applicationMode'='external' and coalesce(v_data->>'externalUrl','')='')
      or jsonb_typeof(v_data->'files') is distinct from 'array' or jsonb_array_length(v_data->'files')>5 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_files:='[]'::jsonb;
    for v_file in select value from jsonb_array_elements(v_data->'files') loop
      -- Existing files can remain attached when a different editor updates text.
      if v_old->'files' @> jsonb_build_array(jsonb_build_object('id',v_file->>'id')) then
        select f.data into v_file from public.opportunities_files f where f.id=(v_file->>'id')::uuid and f.kind='opportunity';
        if not found then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
        v_files:=v_files||jsonb_build_array(v_file);
      else v_files:=v_files||jsonb_build_array(public.xelay_opportunities_file(v_file,'opportunity')); end if;
    end loop;
    v_revision:=coalesce(v_revision,0)+1;
    v_data:=public.xelay_opportunities_pick(v_data,array['kind','title','summary','description','requirements','benefits','city','format','employment','experience','compensation','paid','direction','deadline','startsAt','applicationMode','externalUrl'])
      ||jsonb_build_object('id',v_id,'companyId',v_company_id,'files',v_files,'status','draft','reviewNote','','createdAt',coalesce(v_old->'createdAt',to_jsonb(now())),'revision',v_revision);
    insert into public.opportunities_items(id,company_id,status,deadline,data,revision) values(v_id,v_company_id,'draft',nullif(v_data->>'deadline','')::date,v_data,v_revision)
      on conflict(id) do update set status='draft',deadline=excluded.deadline,data=excluded.data,revision=excluded.revision;
  when 'opportunity.submit' then
    select * into v_item from public.opportunities_items where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if public.xelay_opportunities_company_role(v_item.company_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_item.company_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if not exists(select 1 from public.opportunities_companies where id=v_item.company_id and status='approved') then raise exception 'OPPORTUNITIES_VERIFICATION_REQUIRED'; end if;
    if length(btrim(coalesce(v_item.data->>'description','')))<20 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    update public.opportunities_items set status='pending',revision=revision+1,data=data||jsonb_build_object('status','pending','reviewNote','','revision',revision+1) where id=v_id and status in ('draft','changes','rejected');
    if not found then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    perform public.xelay_opportunities_notify_admins('Нова пропозиція','Пропозиція очікує модерації.');
  when 'opportunity.review' then
    v_status:=p_command->>'status'; v_note:=left(coalesce(p_command->>'note',''),2000);
    if v_status not in ('approved','changes','rejected','paused','closed') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select company_id,revision into v_company_id,v_revision from public.opportunities_items where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if not v_admin and (v_status not in ('paused','closed') or coalesce(public.xelay_opportunities_company_role(v_company_id),'') not in ('owner','editor')) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if coalesce((p_command->>'expectedRevision')::int,0)<>v_revision then raise exception 'OPPORTUNITIES_STALE'; end if;
    if v_status='approved' and not exists(select 1 from public.opportunities_companies where id=v_company_id and status='approved') then raise exception 'OPPORTUNITIES_VERIFICATION_REQUIRED'; end if;
    update public.opportunities_items set status=v_status,revision=revision+1,published_at=case when v_status='approved' then coalesce(published_at,now()) else published_at end,
      data=data||jsonb_build_object('status',v_status,'reviewNote',v_note,'revision',revision+1) where id=v_id;
    perform public.xelay_opportunities_notify_company(v_company_id,'Перевірка пропозиції',coalesce(nullif(v_note,''),'Статус пропозиції оновлено.'));
  when 'saved.toggle','hidden.toggle' then
    insert into public.opportunities_personal(user_id) values(v_uid) on conflict do nothing;
    -- Removing a personal bookmark/hide remains possible after moderation or expiry.
    if v_type='saved.toggle' and exists(select 1 from public.opportunities_personal where user_id=v_uid and v_id=any(saved_ids)) then
      update public.opportunities_personal set saved_ids=array_remove(saved_ids,v_id) where user_id=v_uid;
    elsif v_type='hidden.toggle' and exists(select 1 from public.opportunities_personal where user_id=v_uid and v_id=any(hidden_ids)) then
      update public.opportunities_personal set hidden_ids=array_remove(hidden_ids,v_id) where user_id=v_uid;
    else
    select * into v_item from public.opportunities_items where id=v_id;
    if not found or v_item.status<>'approved' or not exists(select 1 from public.opportunities_companies where id=v_item.company_id and status='approved') then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if v_type='saved.toggle' then update public.opportunities_personal set saved_ids=array_append(saved_ids,v_id) where user_id=v_uid;
    else update public.opportunities_personal set hidden_ids=array_append(hidden_ids,v_id) where user_id=v_uid; end if;
    end if;
  when 'application.submit' then
    if p_command->'consent' is distinct from 'true'::jsonb then raise exception 'OPPORTUNITIES_CONSENT_REQUIRED'; end if;
    v_id:=(p_command->>'opportunityId')::uuid;
    select * into v_item from public.opportunities_items where id=v_id;
    if not found or v_item.status<>'approved' or v_item.data->>'applicationMode'<>'internal'
      or not exists(select 1 from public.opportunities_companies where id=v_item.company_id and status='approved') then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if v_item.deadline<(now() at time zone 'Europe/Kyiv')::date then raise exception 'OPPORTUNITIES_CLOSED'; end if;
    if exists(select 1 from public.opportunities_applications where student_id=v_uid and opportunity_id=v_id) then raise exception 'OPPORTUNITIES_ALREADY_APPLIED'; end if;
    if (select count(*) from public.opportunities_applications where student_id=v_uid and created_at>now()-interval '1 day')>=30 then raise exception 'OPPORTUNITIES_LIMIT'; end if;
    select data into v_resume from public.opportunities_resumes where owner_id=v_uid;
    if not found then raise exception 'OPPORTUNITIES_RESUME_REQUIRED'; end if;
    if length(btrim(coalesce(p_command->>'contact',''))) not between 3 and 300 or length(coalesce(p_command->>'message',''))>3000 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_target:=gen_random_uuid();
    v_data:=jsonb_build_object('id',v_target,'opportunityId',v_id,'companyId',v_item.company_id,'studentId',v_uid,
      'studentName',v_resume->>'fullName','message',coalesce(p_command->>'message',''),'contact',p_command->>'contact',
      'resumeSnapshot',v_resume||jsonb_build_object('contact',p_command->>'contact'),'status','sent','messages','[]'::jsonb,'createdAt',now(),'updatedAt',now());
    insert into public.opportunities_applications(id,opportunity_id,company_id,student_id,status,data) values(v_target,v_id,v_item.company_id,v_uid,'sent',v_data);
    perform public.xelay_opportunities_notify_company(v_item.company_id,'Новий відгук','Новий кандидат відгукнувся на вашу пропозицію.');
    v_id:=v_target;
  when 'application.status' then
    select * into v_application from public.opportunities_applications where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    v_status:=p_command->>'status';
    if v_application.student_id=v_uid then
      if v_status<>'withdrawn' or v_application.status='withdrawn' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    elsif public.xelay_opportunities_company_role(v_application.company_id) in ('owner','recruiter') then
      if v_status not in ('reviewing','invited','completed') or v_application.status in ('withdrawn','completed') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    else raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    update public.opportunities_applications set status=v_status,updated_at=now(),data=data||jsonb_build_object('status',v_status,'updatedAt',now()) where id=v_id;
    insert into public.opportunities_notifications(user_id,title,body) values(v_application.student_id,'Статус відгуку','Перевірте оновлення в «Мої відгуки».');
  when 'application.message' then
    select * into v_application from public.opportunities_applications where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if v_application.student_id<>v_uid and coalesce(public.xelay_opportunities_company_role(v_application.company_id),'') not in ('owner','recruiter') then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if v_application.status in ('withdrawn','completed') then raise exception 'OPPORTUNITIES_CLOSED'; end if;
    if length(btrim(coalesce(p_command->>'body',''))) not between 1 and 3000 or jsonb_array_length(v_application.data->'messages')>=500 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_data:=jsonb_build_object('id',gen_random_uuid(),'authorId',v_uid,'authorName',public.xelay_opportunities_name(v_uid),'body',btrim(p_command->>'body'),'createdAt',now());
    update public.opportunities_applications set updated_at=now(),data=data||jsonb_build_object('messages',(data->'messages')||jsonb_build_array(v_data),'updatedAt',now()) where id=v_id;
    if v_application.student_id=v_uid then perform public.xelay_opportunities_notify_company(v_application.company_id,'Повідомлення кандидата','Перевірте листування у відгуку.');
    else insert into public.opportunities_notifications(user_id,title,body) values(v_application.student_id,'Відповідь компанії','Компанія відповіла на ваш відгук.'); end if;
  when 'report.submit' then
    v_id:=(p_command->>'opportunityId')::uuid;
    if not exists(select 1 from public.opportunities_items where id=v_id and status='approved') then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if (select count(*) from public.opportunities_reports where actor_id=v_uid and created_at>now()-interval '1 day')>=10 then raise exception 'OPPORTUNITIES_LIMIT'; end if;
    insert into public.opportunities_reports(actor_id,opportunity_id,reason) values(v_uid,v_id,btrim(p_command->>'reason'));
    perform public.xelay_opportunities_notify_admins('Скарга на пропозицію','Перевірте нову скаргу в кабінеті модерації.');
  when 'report.resolve' then
    if not v_admin then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    update public.opportunities_reports set status='resolved' where id=v_id;
  when 'campaign.save' then
    v_data:=p_command->'campaign'; perform public.xelay_opportunities_validate(v_data); v_id:=(v_data->>'id')::uuid; v_company_id:=(v_data->>'companyId')::uuid;
    perform public.xelay_opportunities_strings(v_data,array['title','body','image','cta','url','startsAt','endsAt']);
    if public.xelay_opportunities_company_role(v_company_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_company_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select data,revision into v_old,v_revision from public.opportunities_campaigns where id=v_id;
    if found and (v_old->>'companyId')::uuid<>v_company_id then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if not exists(select 1 from public.opportunities_items where id=(v_data->>'opportunityId')::uuid and company_id=v_company_id)
      or length(btrim(coalesce(v_data->>'title',''))) not between 3 and 180 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_start:=(v_data->>'startsAt')::timestamptz; v_end:=(v_data->>'endsAt')::timestamptz;
    if v_start is null or v_end is null or v_end<=v_start or v_end>v_start+interval '1 year'
      or jsonb_typeof(v_data->'placements') is distinct from 'array' or jsonb_array_length(v_data->'placements') not between 1 and 4
      or exists(select 1 from jsonb_array_elements_text(v_data->'placements') p where p not in ('catalog','home','news','entry')) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    foreach v_key in array array['universities','faculties','years','directions'] loop
      if jsonb_typeof(v_data->v_key) is distinct from 'array' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    end loop;
    foreach v_key in array array['universities','faculties','directions'] loop
      if exists(select 1 from jsonb_array_elements(v_data->v_key) s where jsonb_typeof(s)<>'string' or length(s#>>'{}') not between 1 and 180) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(v_data->'years') y where jsonb_typeof(y)<>'number' or (y#>>'{}')::numeric not between 1 and 6) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_revision:=coalesce(v_revision,0)+1;
    v_data:=public.xelay_opportunities_pick(v_data,array['opportunityId','title','body','image','cta','url','placements','universities','faculties','years','directions','startsAt','endsAt'])
      ||jsonb_build_object('id',v_id,'companyId',v_company_id,'frequencyDays',greatest(7,least(365,coalesce((v_data->>'frequencyDays')::int,7))),
        'status','draft','reviewNote','','createdAt',coalesce(v_old->'createdAt',to_jsonb(now())),'revision',v_revision);
    insert into public.opportunities_campaigns(id,company_id,opportunity_id,status,starts_at,ends_at,data,revision)
      values(v_id,v_company_id,(v_data->>'opportunityId')::uuid,'draft',v_start,v_end,v_data,v_revision)
      on conflict(id) do update set opportunity_id=excluded.opportunity_id,status='draft',starts_at=excluded.starts_at,ends_at=excluded.ends_at,data=excluded.data,revision=excluded.revision;
  when 'campaign.submit' then
    select * into v_campaign from public.opportunities_campaigns where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if public.xelay_opportunities_company_role(v_campaign.company_id) not in ('owner','editor') or public.xelay_opportunities_company_role(v_campaign.company_id) is null then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if not exists(select 1 from public.opportunities_companies where id=v_campaign.company_id and status='approved') then raise exception 'OPPORTUNITIES_VERIFICATION_REQUIRED'; end if;
    update public.opportunities_campaigns set status='pending',revision=revision+1,data=data||jsonb_build_object('status','pending','reviewNote','','revision',revision+1) where id=v_id and status in ('draft','changes','rejected','paused');
    if not found then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    perform public.xelay_opportunities_notify_admins('Нова рекламна кампанія','Кампанія очікує модерації.');
  when 'campaign.review' then
    v_status:=p_command->>'status'; v_note:=left(coalesce(p_command->>'note',''),2000);
    if v_status not in ('approved','changes','rejected','paused','closed') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select * into v_campaign from public.opportunities_campaigns where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if not v_admin and (v_status not in ('paused','closed') or coalesce(public.xelay_opportunities_company_role(v_campaign.company_id),'') not in ('owner','editor')) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if coalesce((p_command->>'expectedRevision')::int,0)<>v_campaign.revision then raise exception 'OPPORTUNITIES_STALE'; end if;
    if v_status='approved' and not exists(select 1 from public.opportunities_companies c join public.opportunities_items i on i.company_id=c.id
      where c.id=v_campaign.company_id and c.status='approved' and i.id=v_campaign.opportunity_id and i.status='approved') then raise exception 'OPPORTUNITIES_VERIFICATION_REQUIRED'; end if;
    update public.opportunities_campaigns set status=v_status,revision=revision+1,data=data||jsonb_build_object('status',v_status,'reviewNote',v_note,'revision',revision+1) where id=v_id;
    perform public.xelay_opportunities_notify_company(v_campaign.company_id,'Перевірка кампанії',coalesce(nullif(v_note,''),'Статус кампанії оновлено.'));
  when 'order.save' then
    if not v_admin then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    v_data:=p_command->'order'; perform public.xelay_opportunities_validate(v_data); v_id:=(v_data->>'id')::uuid;
    perform public.xelay_opportunities_strings(v_data,array['label','terms','startsAt','endsAt','currency','paymentMethod']);
    if jsonb_typeof(v_data->'amount') is distinct from 'number' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select * into v_campaign from public.opportunities_campaigns where id=(v_data->>'campaignId')::uuid;
    if not found or v_campaign.company_id<>(v_data->>'companyId')::uuid then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if v_data->>'paymentMethod' is distinct from 'invoice' then raise exception 'OPPORTUNITIES_MANUAL_INVOICE_ONLY'; end if;
    if v_data->>'currency' is distinct from 'UAH' or length(btrim(coalesce(v_data->>'label',''))) not between 3 and 180
      or length(btrim(coalesce(v_data->>'terms','')))<10 or (v_data->>'amount')::numeric<>round((v_data->>'amount')::numeric,2) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_start:=(v_data->>'startsAt')::timestamptz; v_end:=(v_data->>'endsAt')::timestamptz;
    if v_start is null or v_end is null or v_end<=v_start then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    select * into v_order from public.opportunities_orders where id=v_id;
    if found and (v_order.status in ('paid','refunded') or v_order.campaign_id<>v_campaign.id) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    v_data:=public.xelay_opportunities_pick(v_data,array['label','amount','terms','startsAt','endsAt'])
      ||jsonb_build_object('id',v_id,'campaignId',v_campaign.id,'companyId',v_campaign.company_id,'currency','UAH','paymentMethod','invoice',
        'reference',left(coalesce(p_command->'order'->>'reference',''),200),'status','draft','createdAt',coalesce(v_order.data->'createdAt',to_jsonb(now())),'paidAt',null);
    insert into public.opportunities_orders(id,campaign_id,company_id,status,amount,data) values(v_id,v_campaign.id,v_campaign.company_id,'draft',(v_data->>'amount')::numeric,v_data)
      on conflict(id) do update set status='draft',amount=excluded.amount,data=excluded.data;
  when 'order.status' then
    if not v_admin then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select * into v_order from public.opportunities_orders where id=v_id;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    v_status:=p_command->>'status'; v_note:=btrim(coalesce(p_command->>'reference',''));
    if (v_status='paid' and (v_order.status<>'awaiting_payment' or length(v_note) not between 3 and 200))
      or (v_status='refunded' and (v_order.status<>'paid' or length(v_note) not between 3 and 200))
      or (v_status='cancelled' and v_order.status not in ('draft','awaiting_payment'))
      or (v_status='awaiting_payment' and v_order.status<>'draft')
      or v_status not in ('paid','refunded','cancelled','awaiting_payment') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    update public.opportunities_orders set status=v_status,data=data||jsonb_build_object('status',v_status,'reference',v_note,
      'paidAt',case when v_status='paid' then to_jsonb(now()) else data->'paidAt' end) where id=v_id;
    perform public.xelay_opportunities_notify_company(v_order.company_id,
      case when v_status='awaiting_payment' then 'Погоджено розміщення' else 'Оплату оновлено' end,'Перевірте стан погодженого замовлення.');
  when 'entry.reserve' then
    v_id:=(p_command->>'campaignId')::uuid;
    if not coalesce((v_settings->>'entryEnabled')::boolean,false) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if not public.xelay_opportunities_campaign_live(v_id) then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if not public.xelay_opportunities_campaign_matches(v_id) or public.xelay_has_participant_access(v_uid) then
      raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select * into v_campaign from public.opportunities_campaigns where id=v_id;
    if not v_campaign.data->'placements' ? 'entry' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    insert into public.opportunities_personal(user_id) values(v_uid) on conflict do nothing;
    select preferences into v_preferences from public.opportunities_personal where user_id=v_uid for update;
    if coalesce(v_preferences->'hiddenCompanyIds','[]'::jsonb) ? v_campaign.company_id::text then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if (v_preferences->>'lastEntryAt')::timestamptz>now()-make_interval(days=>greatest(7,(v_settings->>'entryFrequencyDays')::int))
      or exists(select 1 from public.opportunities_entry_reservations where user_id=v_uid and campaign_id=v_id
        and reserved_at>now()-make_interval(days=>greatest(7,(v_campaign.data->>'frequencyDays')::int))) then raise exception 'OPPORTUNITIES_LIMIT'; end if;
    -- Frequency is reserved before the card opens. Closing it immediately or
    -- reloading does not erase this private frequency boundary.
    update public.opportunities_personal set preferences=preferences||jsonb_build_object('lastEntryAt',now()) where user_id=v_uid;
    insert into public.opportunities_entry_reservations(user_id,campaign_id,reserved_at,expires_at,impression_recorded)
      values(v_uid,v_id,now(),now()+interval '10 minutes',false)
      on conflict(user_id,campaign_id) do update set reserved_at=excluded.reserved_at,expires_at=excluded.expires_at,impression_recorded=false;
  when 'event.record' then
    v_id:=(p_command->>'campaignId')::uuid; v_type:=p_command->>'event'; v_role:=p_command->>'placement';
    if v_type not in ('impression','click','save','hide') or v_role not in ('catalog','home','news','entry') then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if not public.xelay_opportunities_campaign_live(v_id) then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
    if not public.xelay_opportunities_campaign_matches(v_id) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select * into v_campaign from public.opportunities_campaigns where id=v_id;
    if not v_campaign.data->'placements' ? v_role then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if public.xelay_has_participant_access(v_uid) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    select preferences into v_preferences from public.opportunities_personal where user_id=v_uid;
    if coalesce(v_preferences->'hiddenCompanyIds','[]'::jsonb) ? v_campaign.company_id::text then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    if v_role='entry' then
      if not coalesce((v_settings->>'entryEnabled')::boolean,false) then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
      if not exists(select 1 from public.opportunities_entry_reservations where user_id=v_uid and campaign_id=v_id and expires_at>now()) then
        raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
      if v_type='impression' then
        if exists(select 1 from public.opportunities_entry_reservations where user_id=v_uid and campaign_id=v_id and impression_recorded) then
          return public.xelay_opportunities_workspace(); end if;
        update public.opportunities_entry_reservations set impression_recorded=true where user_id=v_uid and campaign_id=v_id;
      end if;
    end if;
    if not exists(select 1 from public.opportunities_events where actor_id=v_uid and campaign_id=v_id and type=v_type and placement=v_role and created_at>now()-interval '1 minute') then
      insert into public.opportunities_events(actor_id,campaign_id,type,placement) values(v_uid,v_id,v_type,v_role);
    end if;
  when 'notification.read' then
    update public.opportunities_notifications set read=true where id=v_id and user_id=v_uid;
    if not found then raise exception 'OPPORTUNITIES_NOT_FOUND'; end if;
  when 'preferences.save' then
    v_data:=p_command->'preferences'; perform public.xelay_opportunities_validate(v_data);
    if jsonb_typeof(v_data->'digest') is distinct from 'boolean' or jsonb_typeof(v_data->'directions') is distinct from 'array'
      or jsonb_typeof(v_data->'hiddenCompanyIds') is distinct from 'array' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if exists(select 1 from jsonb_array_elements(v_data->'directions') s where jsonb_typeof(s)<>'string' or length(s#>>'{}') not between 1 and 120) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    if exists(select 1 from jsonb_array_elements_text(v_data->'hiddenCompanyIds') c where not exists(select 1 from public.opportunities_companies where id=c::uuid)) then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    insert into public.opportunities_personal(user_id,preferences) values(v_uid,public.xelay_opportunities_pick(v_data,array['digest','directions','hiddenCompanyIds'])||'{"lastEntryAt":null}'::jsonb)
      on conflict(user_id) do update set preferences=excluded.preferences||jsonb_build_object('lastEntryAt',opportunities_personal.preferences->'lastEntryAt');
  when 'settings.save' then
    if not v_admin then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
    v_data:=p_command->'settings'; perform public.xelay_opportunities_validate(v_data);
    foreach v_key in array array['enabled','advertisingEnabled','entryEnabled'] loop
      if jsonb_typeof(v_data->v_key) is distinct from 'boolean' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    end loop;
    foreach v_key in array array['entryFrequencyDays','promotedEvery','minimumSegmentSize'] loop
      if jsonb_typeof(v_data->v_key) is distinct from 'number' then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    end loop;
    if (v_data->>'entryFrequencyDays')::int not between 7 and 365 or (v_data->>'promotedEvery')::int not between 8 and 50
      or (v_data->>'minimumSegmentSize')::int not between 30 and 1000 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
    update public.opportunities_settings set data=public.xelay_opportunities_pick(v_data,array['enabled','advertisingEnabled','entryEnabled','entryFrequencyDays','promotedEvery','minimumSegmentSize']) where id;
  else raise exception 'OPPORTUNITIES_INVALID_INPUT';
  end case;
  if p_command->>'type'<>'event.record' then
    insert into public.opportunities_audit(actor_id,action,entity_id,note) values(v_uid,p_command->>'type',coalesce(v_id::text,''),
      case when p_command->>'type'='order.status' then left(coalesce(p_command->>'reference',''),200) else '' end);
  end if;
  return public.xelay_opportunities_workspace();
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range or check_violation or not_null_violation then
  raise exception 'OPPORTUNITIES_INVALID_INPUT';
end $$;

create or replace function public.xelay_opportunities_campaign_live(p_campaign_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.opportunities_campaigns a
    join public.opportunities_companies c on c.id=a.company_id
    join public.opportunities_items i on i.id=a.opportunity_id
    cross join public.opportunities_settings s
    where a.id=p_campaign_id and a.status='approved' and c.status='approved' and i.status='approved'
    and (i.deadline is null or i.deadline>=(now() at time zone 'Europe/Kyiv')::date)
    and a.starts_at<=now() and a.ends_at>now()
    and coalesce((s.data->>'enabled')::boolean,false) and coalesce((s.data->>'advertisingEnabled')::boolean,false)
    and exists(select 1 from public.opportunities_orders o where o.campaign_id=a.id and o.status='paid'
      and coalesce((o.data->>'startsAt')::timestamptz,a.starts_at)<=now()
      and coalesce((o.data->>'endsAt')::timestamptz,a.ends_at)>now()));
$$;

create or replace function public.xelay_opportunities_campaign_matches(p_campaign_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.opportunities_campaigns a
    left join public.profiles p on p.id=auth.uid()
    left join public.universities u on u.id=p.university_id
    left join public.opportunities_personal pref on pref.user_id=auth.uid()
    where a.id=p_campaign_id and auth.uid() is not null
    and (jsonb_array_length(a.data->'universities')=0 or a.data->'universities' ? p.university_id::text or a.data->'universities' ? u.name)
    and (jsonb_array_length(a.data->'faculties')=0 or a.data->'faculties' ? p.academic_unit_id::text or a.data->'faculties' ? p.faculty)
    and (jsonb_array_length(a.data->'years')=0 or a.data->'years' @> jsonb_build_array(p.study_year))
    and (jsonb_array_length(a.data->'directions')=0 or a.data->'directions' ? p.specialty
      or exists(select 1 from jsonb_array_elements_text(coalesce(pref.preferences->'directions','[]'::jsonb)) d where a.data->'directions' ? d))
    and not coalesce(pref.preferences->'hiddenCompanyIds','[]'::jsonb) ? a.company_id::text);
$$;

create or replace function public.xelay_opportunities_can_read_file(p_path text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select auth.uid() is not null and (public.xelay_opportunities_enabled() or public.xelay_is_platform_admin())
    and exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now()))
    and exists(select 1 from public.opportunities_files f where f.path=p_path and (
      f.owner_id=auth.uid()
      or (f.kind='company' and public.xelay_is_platform_admin())
      or (f.kind='opportunity' and exists(select 1 from public.opportunities_items i
        join public.opportunities_companies c on c.id=i.company_id
        where i.data->'files' @> jsonb_build_array(jsonb_build_object('id',f.id::text)) and (
          public.xelay_opportunities_company_role(c.id) is not null or public.xelay_is_platform_admin()
          or (i.status='approved' and c.status='approved'))))
      or (f.kind='resume' and exists(select 1 from public.opportunities_applications a
        where a.data->'resumeSnapshot'->'file'->>'id'=f.id::text
          and a.status<>'withdrawn' and public.xelay_opportunities_company_role(a.company_id) in ('owner','recruiter')))));
$$;
create or replace function public.xelay_opportunities_file_unreferenced(p_path text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select auth.uid() is not null and p_path like auth.uid()::text||'/%'
    and not exists(select 1 from public.opportunities_applications where data->'resumeSnapshot'->'file'->>'path'=p_path)
    and not exists(select 1 from public.opportunities_resumes where data->'file'->>'path'=p_path)
    and not exists(select 1 from public.opportunities_items i cross join lateral jsonb_array_elements(coalesce(i.data->'files','[]'::jsonb)) f
      where f->>'path'=p_path);
$$;

create or replace function public.xelay_opportunities_can_upload(p_path text)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_count int; v_size bigint; v_daily int; begin
  if auth.uid() is null or (not public.xelay_opportunities_enabled() and not public.xelay_is_platform_admin())
    or p_path!~('^'||auth.uid()::text||'/(resume|company|opportunity)/[a-f0-9-]{36}\.pdf$') then return false; end if;
  if not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:career:uploads:'||auth.uid()::text,0));
  select count(*),coalesce(sum(coalesce((metadata->>'size')::bigint,(metadata->>'contentLength')::bigint,10485760)),0),
    count(*) filter(where created_at>now()-interval '1 day') into v_count,v_size,v_daily
    from storage.objects where bucket_id='opportunities-private' and name like auth.uid()::text||'/%';
  return v_count<150 and v_daily<30 and v_size+10485760<=209715200;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('opportunities-private','opportunities-private',false,10485760,array['application/pdf'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf'];
drop policy if exists "Opportunities private PDF upload" on storage.objects;
create policy "Opportunities private PDF upload" on storage.objects for insert to authenticated with check(
  bucket_id='opportunities-private' and public.xelay_opportunities_can_upload(name));
drop policy if exists "Opportunities authorized PDF read" on storage.objects;
create policy "Opportunities authorized PDF read" on storage.objects for select to authenticated using(
  bucket_id='opportunities-private' and public.xelay_opportunities_can_read_file(name));
drop policy if exists "Opportunities unattached PDF cleanup" on storage.objects;
create policy "Opportunities unattached PDF cleanup" on storage.objects for delete to authenticated using(
  bucket_id='opportunities-private' and public.xelay_opportunities_file_unreferenced(name));
-- Restrictive policies also constrain pre-existing broad Storage grants.
drop policy if exists "Opportunities PDF upload guard" on storage.objects;
create policy "Opportunities PDF upload guard" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'opportunities-private' or public.xelay_opportunities_can_upload(name));
drop policy if exists "Opportunities PDF read guard" on storage.objects;
create policy "Opportunities PDF read guard" on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id<>'opportunities-private' or public.xelay_opportunities_can_read_file(name));
drop policy if exists "Opportunities PDF delete guard" on storage.objects;
create policy "Opportunities PDF delete guard" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'opportunities-private' or public.xelay_opportunities_file_unreferenced(name));
drop policy if exists "Opportunities PDF overwrite guard" on storage.objects;
create policy "Opportunities PDF overwrite guard" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'opportunities-private') with check(bucket_id<>'opportunities-private');

create or replace function public.xelay_opportunities_register_file(p_file jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_path text; v_size bigint; v_kind text; v_data jsonb; v_count integer; v_object storage.objects%rowtype; begin
  if auth.uid() is null then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() and not public.xelay_is_platform_admin() then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  v_id:=(p_file->>'id')::uuid; v_kind:=p_file->>'kind'; v_path:=p_file->>'path';
  if v_kind not in ('resume','company','opportunity') or v_path<>auth.uid()::text||'/'||v_kind||'/'||v_id::text||'.pdf'
    or length(coalesce(p_file->>'name','')) not between 1 and 180 then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  select * into v_object from storage.objects where bucket_id='opportunities-private' and name=v_path for update;
  if not found then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  v_size:=coalesce((v_object.metadata->>'size')::bigint,(v_object.metadata->>'contentLength')::bigint);
  if coalesce(v_object.metadata->>'mimetype',v_object.metadata->>'contentType','')<>'application/pdf'
    or v_size is null or v_size not between 5 and 10485760 or v_size<>(p_file->>'size')::bigint
    or not exists(select 1 from public.opportunities_verified_uploads marker where marker.path=v_path and marker.owner_id=auth.uid()
      and marker.object_id=v_object.id and marker.object_updated_at=v_object.updated_at and marker.size=v_size and marker.expires_at>now())
    then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:career:files:'||auth.uid()::text,0));
  select count(*) into v_count from public.opportunities_files where owner_id=auth.uid() and created_at>now()-interval '1 day';
  if v_count>=30 then raise exception 'OPPORTUNITIES_LIMIT'; end if;
  v_data:=jsonb_build_object('id',v_id,'ownerId',auth.uid(),'path',v_path,'kind',v_kind,
    'name',p_file->>'name','size',v_size,'mime','application/pdf');
  insert into public.opportunities_files(id,owner_id,path,kind,data) values(v_id,auth.uid(),v_path,v_kind,v_data);
  return v_data;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'OPPORTUNITIES_FILE_INVALID';
end $$;

create or replace function public.xelay_opportunities_file_probe(p_path text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_object storage.objects%rowtype; v_size bigint; v_owner uuid; v_day date:=(now() at time zone 'Europe/Kyiv')::date; v_attempts integer; begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  if p_path!~'^[a-f0-9-]{36}/(resume|company|opportunity)/[a-f0-9-]{36}\.pdf$' then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  select * into v_object from storage.objects where bucket_id='opportunities-private' and name=p_path;
  if not found then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  if exists(select 1 from public.opportunities_files where path=p_path) then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  v_size:=coalesce((v_object.metadata->>'size')::bigint,(v_object.metadata->>'contentLength')::bigint);
  if v_size is null or v_size not between 5 and 10485760 or coalesce(v_object.metadata->>'mimetype',v_object.metadata->>'contentType','')<>'application/pdf' then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  v_owner:=split_part(p_path,'/',1)::uuid;
  if not exists(select 1 from auth.users where id=v_owner and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.opportunities_file_validation_budget(day,owner_id,attempts) values(v_day,v_owner,1)
    on conflict(day,owner_id) do update set attempts=opportunities_file_validation_budget.attempts+1
      where opportunities_file_validation_budget.attempts<60 returning attempts into v_attempts;
  if not found then raise exception 'OPPORTUNITIES_LIMIT'; end if;
  delete from public.opportunities_file_validation_budget where day<v_day-90;
  return jsonb_build_object('object_id',v_object.id,'updated_at',v_object.updated_at,'size',v_size,'mime','application/pdf');
end $$;

create or replace function public.xelay_opportunities_verify_file(p_path text,p_size bigint,p_sha256 text,p_object_id uuid,p_updated_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_object storage.objects%rowtype; v_size bigint; begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  if p_path!~'^[a-f0-9-]{36}/(resume|company|opportunity)/[a-f0-9-]{36}\.pdf$'
    or p_sha256!~'^[a-f0-9]{64}$' or p_size not between 5 and 10485760 then raise exception 'OPPORTUNITIES_FILE_INVALID'; end if;
  if not exists(select 1 from auth.users where id=split_part(p_path,'/',1)::uuid and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_object from storage.objects where bucket_id='opportunities-private' and name=p_path for update;
  if not found then return false; end if;
  v_size:=coalesce((v_object.metadata->>'size')::bigint,(v_object.metadata->>'contentLength')::bigint);
  if v_object.id is distinct from p_object_id or v_object.updated_at is distinct from p_updated_at or v_size is distinct from p_size
    or coalesce(v_object.metadata->>'mimetype',v_object.metadata->>'contentType','')<>'application/pdf' then return false; end if;
  insert into public.opportunities_verified_uploads(path,object_id,owner_id,object_updated_at,size,sha256)
    values(p_path,v_object.id,split_part(p_path,'/',1)::uuid,v_object.updated_at,v_size,p_sha256)
    on conflict(path) do update set object_id=excluded.object_id,owner_id=excluded.owner_id,object_updated_at=excluded.object_updated_at,
      size=excluded.size,sha256=excluded.sha256,verified_at=now(),expires_at=now()+interval '2 minutes';
  return true;
end $$;

create or replace function public.xelay_opportunities_workspace()
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_admin boolean; v_companies uuid[]; v_settings jsonb; v_personal public.opportunities_personal%rowtype; begin
  if v_uid is null then raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=v_uid and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then
    raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501'; end if;
  v_admin:=public.xelay_is_platform_admin();
  select data into v_settings from public.opportunities_settings where id;
  if not coalesce((v_settings->>'enabled')::boolean,false) and not v_admin then raise exception 'OPPORTUNITIES_DEVELOPMENT'; end if;
  select coalesce(array_agg(c.id),'{}'::uuid[]) into v_companies from public.opportunities_companies c
    where public.xelay_opportunities_company_role(c.id) is not null;
  select * into v_personal from public.opportunities_personal where user_id=v_uid;
  return jsonb_build_object(
    'actor',jsonb_build_object('id',v_uid,'name',public.xelay_opportunities_name(v_uid),
      'role',case when v_admin then 'admin'
        when exists(select 1 from public.opportunities_business_accounts where user_id=v_uid)
          or (cardinality(v_companies)>0 and not exists(select 1 from public.profiles where id=v_uid)) then 'company' else 'student' end,
      'companyIds',to_jsonb(v_companies),'premium',public.xelay_has_participant_access(v_uid)),
    'companies',coalesce((select jsonb_agg(case when v_admin or c.id=any(v_companies) then c.data
      else c.data||'{"ownerId":"","contactEmail":"","contactName":"","registrationCode":"","reviewNote":""}'::jsonb end order by c.created_at desc)
      from public.opportunities_companies c where v_admin or c.id=any(v_companies) or c.status='approved'),'[]'::jsonb),
    'opportunities',coalesce((select jsonb_agg(case when v_admin or i.company_id=any(v_companies) then i.data
      else i.data||'{"reviewNote":""}'::jsonb end order by i.created_at desc)
      from public.opportunities_items i join public.opportunities_companies c on c.id=i.company_id
      where v_admin or i.company_id=any(v_companies) or (i.status in ('approved','closed') and c.status='approved')
        or exists(select 1 from public.opportunities_applications a where a.opportunity_id=i.id and a.student_id=v_uid)),'[]'::jsonb),
    'resume',(select data from public.opportunities_resumes where owner_id=v_uid),
    'candidateResumes',case when exists(select 1 from public.opportunities_companies c where c.status='approved'
      and public.xelay_opportunities_company_role(c.id) in ('owner','recruiter')) then
      coalesce((select jsonb_agg(r.data||'{"contact":"","file":null}'::jsonb) from public.opportunities_resumes r join auth.users u on u.id=r.owner_id
        where r.visibility='employers' and r.owner_id<>v_uid and u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())),'[]'::jsonb)
      else '[]'::jsonb end,
    'applications',coalesce((select jsonb_agg(case when a.status='withdrawn' and a.student_id<>v_uid
      then a.data||jsonb_build_object('resumeSnapshot',(a.data->'resumeSnapshot')||'{"file":null,"contact":""}'::jsonb,'contact','')
      else a.data end order by a.created_at desc) from public.opportunities_applications a
      where a.student_id=v_uid or public.xelay_opportunities_company_role(a.company_id) in ('owner','recruiter')),'[]'::jsonb),
    'savedIds',to_jsonb(coalesce(v_personal.saved_ids,'{}'::uuid[])),
    'hiddenIds',to_jsonb(coalesce(v_personal.hidden_ids,'{}'::uuid[])),
    'campaigns',coalesce((select jsonb_agg(a.data||case when v_admin or a.company_id=any(v_companies) then '{}'::jsonb else '{"reviewNote":""}'::jsonb end)
      from public.opportunities_campaigns a where v_admin or a.company_id=any(v_companies)
        or (public.xelay_opportunities_campaign_live(a.id) and public.xelay_opportunities_campaign_matches(a.id)
          and not public.xelay_has_participant_access(v_uid))),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(o.data order by o.created_at desc) from public.opportunities_orders o
      where v_admin or public.xelay_opportunities_company_role(o.company_id)='owner'),'[]'::jsonb),
    'events','[]'::jsonb,
    'metrics',coalesce((select jsonb_agg(jsonb_build_object('campaignId',a.id,
      'impressions',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then counts.impressions else null end,
      'clicks',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then counts.clicks else null end,
      'saves',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then counts.saves else null end,
      'hides',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then counts.hides else null end,
      'reach',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then counts.reach else null end,
      'applications',case when counts.reach>=coalesce((v_settings->>'minimumSegmentSize')::int,30) then
        (select count(*) from public.opportunities_applications p where p.opportunity_id=a.opportunity_id and p.status<>'withdrawn') else null end,
      'suppressed',counts.reach<coalesce((v_settings->>'minimumSegmentSize')::int,30)))
      from public.opportunities_campaigns a cross join lateral (
        select count(distinct e.actor_id) reach,count(*) filter(where type='impression') impressions,
          count(*) filter(where type='click') clicks,count(*) filter(where type='save') saves,count(*) filter(where type='hide') hides
        from public.opportunities_events e where e.campaign_id=a.id and e.created_at>now()-interval '90 days') counts
      where v_admin or public.xelay_opportunities_company_role(a.company_id) in ('owner','editor')),'[]'::jsonb),
    'members',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'companyId',m.company_id,'userId',m.user_id,'email',m.email,'role',m.role,'status',m.status))
      from public.opportunities_members m where m.user_id=v_uid or public.xelay_opportunities_company_role(m.company_id)='owner'),'[]'::jsonb),
    'reports',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'actorId',r.actor_id,'opportunityId',r.opportunity_id,
      'reason',r.reason,'status',r.status,'createdAt',r.created_at)) from public.opportunities_reports r where v_admin or r.actor_id=v_uid),'[]'::jsonb),
    'notifications',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'userId',n.user_id,'title',n.title,'body',n.body,'read',n.read,'createdAt',n.created_at))
      from (select * from public.opportunities_notifications where user_id=v_uid order by created_at desc limit 100) n),'[]'::jsonb),
    'audit',case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'actorId',a.actor_id,'action',a.action,'entityId',a.entity_id,'note',a.note,'createdAt',a.created_at))
      from (select * from public.opportunities_audit order by created_at desc limit 200) a),'[]'::jsonb) else '[]'::jsonb end,
    'settings',v_settings,
    'preferences',coalesce(v_personal.preferences,'{"digest":false,"directions":[],"hiddenCompanyIds":[],"lastEntryAt":null}'::jsonb));
end $$;

-- SECURITY DEFINER helpers must not be directly callable except policy predicates.
create or replace function public.xelay_prepare_opportunities_digest()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now timestamp:=now() at time zone 'Europe/Kyiv'; v_week date; v_count integer; begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() or extract(isodow from v_now)<>1 or extract(hour from v_now)<9 then return 0; end if;
  v_week:=date_trunc('week',v_now)::date;
  perform pg_advisory_xact_lock(hashtextextended('xelay:opportunities:digest',0));
  insert into public.opportunities_digest_outbox(recipient_id,week_start,opportunity_ids)
    select pref.user_id,v_week,offers.ids
    from public.opportunities_personal pref join auth.users u on u.id=pref.user_id
    left join public.notification_preferences n on n.user_id=pref.user_id
    cross join lateral (select array_agg(candidate.id) ids from (
      select i.id from public.opportunities_items i join public.opportunities_companies c on c.id=i.company_id
      where i.status='approved' and c.status='approved' and i.published_at>now()-interval '7 days'
        and (i.deadline is null or i.deadline>=(now() at time zone 'Europe/Kyiv')::date)
        and (jsonb_array_length(coalesce(pref.preferences->'directions','[]'::jsonb))=0
          or pref.preferences->'directions' ? (i.data->>'direction'))
        and not coalesce(pref.preferences->'hiddenCompanyIds','[]'::jsonb) ? c.id::text
        and not i.id=any(pref.hidden_ids)
      order by i.published_at desc limit 8) candidate) offers
    where pref.preferences->'digest'='true'::jsonb and u.email_confirmed_at is not null
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()) and u.email is not null and coalesce(n.notifications_enabled,true)
      and coalesce(n.email_notifications_enabled,true) and cardinality(offers.ids)>0
      and not exists(select 1 from public.opportunities_digest_outbox prior where prior.recipient_id=pref.user_id and prior.week_start=v_week)
    on conflict(recipient_id,week_start) do nothing;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.xelay_claim_opportunities_digest()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.opportunities_digest_outbox%rowtype; begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() then return null; end if;
  update public.opportunities_digest_outbox set status='skipped',completed_at=now(),error_code='expired'
    where status in ('pending','processing') and (created_at<now()-interval '7 days' or delivery_started_at<now()-interval '23 hours');
  update public.opportunities_digest_outbox set status='failed',completed_at=now(),error_code='attempt_limit'
    where attempts>=5 and status in ('pending','processing') and (locked_at is null or locked_at<now()-interval '2 minutes');
  select * into v_job from public.opportunities_digest_outbox
    where attempts<5 and available_at<=now() and (status='pending' or (status='processing' and locked_at<now()-interval '2 minutes'))
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.opportunities_digest_outbox set status='processing',attempts=attempts+1,claim_token=gen_random_uuid(),locked_at=now(),delivery_started_at=coalesce(delivery_started_at,now())
    where id=v_job.id returning * into v_job;
  -- Provider idempotency is valid for 24h from the first attempt, not enqueue time.
  return jsonb_build_object('id',v_job.id,'lock_token',v_job.claim_token,'attempts',v_job.attempts,'created_at',v_job.delivery_started_at);
end $$;

create or replace function public.xelay_opportunities_digest_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.opportunities_digest_outbox%rowtype; v_pref public.opportunities_personal%rowtype; v_email text; v_items jsonb; begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if not public.xelay_opportunities_enabled() then return jsonb_build_object('eligible',false); end if;
  select * into v_job from public.opportunities_digest_outbox where id=p_job_id and claim_token=p_lock_token and status='processing'
    and locked_at>now()-interval '2 minutes' and created_at>now()-interval '7 days' and delivery_started_at>now()-interval '23 hours';
  if not found then return jsonb_build_object('eligible',false); end if;
  select * into v_pref from public.opportunities_personal where user_id=v_job.recipient_id;
  if not found or v_pref.preferences->'digest' is distinct from 'true'::jsonb then return jsonb_build_object('eligible',false); end if;
  select u.email into v_email from auth.users u left join public.notification_preferences n on n.user_id=u.id
    where u.id=v_job.recipient_id and u.email_confirmed_at is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
      and coalesce(n.notifications_enabled,true) and coalesce(n.email_notifications_enabled,true);
  if v_email is null then return jsonb_build_object('eligible',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'title',left(i.data->>'title',180),'company',left(c.data->>'name',180),
    'kind',i.data->>'kind','city',left(i.data->>'city',120),'deadline',i.data->>'deadline')),'[]'::jsonb) into v_items
    from public.opportunities_items i join public.opportunities_companies c on c.id=i.company_id
    where i.id=any(v_job.opportunity_ids) and i.status='approved' and c.status='approved'
      and (i.deadline is null or i.deadline>=(now() at time zone 'Europe/Kyiv')::date)
      and (jsonb_array_length(coalesce(v_pref.preferences->'directions','[]'::jsonb))=0 or v_pref.preferences->'directions' ? (i.data->>'direction'))
      and not coalesce(v_pref.preferences->'hiddenCompanyIds','[]'::jsonb) ? c.id::text and not i.id=any(v_pref.hidden_ids);
  return jsonb_build_object('eligible',jsonb_array_length(v_items)>0,'email',v_email,'items',v_items);
end $$;

create or replace function public.xelay_finish_opportunities_digest(p_job_id uuid,p_lock_token uuid,p_status text,p_error_code text default null,p_provider_message_id text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'OPPORTUNITIES_FORBIDDEN' using errcode='42501'; end if;
  if p_status not in ('sent','skipped','pending','failed') or length(coalesce(p_error_code,''))>100 or length(coalesce(p_provider_message_id,''))>256 then raise exception 'OPPORTUNITIES_INVALID_INPUT'; end if;
  update public.opportunities_digest_outbox set status=case when p_status='pending' and attempts>=5 then 'failed' else p_status end,
    error_code=p_error_code,provider_message_id=p_provider_message_id,
    completed_at=case when p_status='pending' and attempts<5 then null else now() end,
    available_at=case when p_status='pending' then now()+make_interval(mins=>least(60,5*attempts)) else available_at end,
    claim_token=null,locked_at=null
    where id=p_job_id and claim_token=p_lock_token and status='processing' and locked_at>now()-interval '2 minutes';
  return found;
end $$;

revoke all on function public.xelay_prepare_opportunities_digest(),public.xelay_claim_opportunities_digest(),
  public.xelay_opportunities_digest_context(uuid,uuid),public.xelay_finish_opportunities_digest(uuid,uuid,text,text,text),
  public.xelay_opportunities_file_probe(text),public.xelay_opportunities_verify_file(text,bigint,text,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.xelay_prepare_opportunities_digest(),public.xelay_claim_opportunities_digest(),
  public.xelay_opportunities_digest_context(uuid,uuid),public.xelay_finish_opportunities_digest(uuid,uuid,text,text,text),
  public.xelay_opportunities_file_probe(text),public.xelay_opportunities_verify_file(text,bigint,text,uuid,timestamptz) to service_role;

revoke all on function public.xelay_opportunities_company_role(uuid),public.xelay_opportunities_enabled(),public.xelay_opportunities_name(uuid),
  public.xelay_opportunities_pick(jsonb,text[]),public.xelay_opportunities_validate(jsonb),public.xelay_opportunities_file(jsonb,text),
  public.xelay_opportunities_strings(jsonb,text[]),public.xelay_opportunities_campaign_live(uuid),public.xelay_opportunities_campaign_matches(uuid),
  public.xelay_opportunities_can_upload(text),public.xelay_opportunities_can_read_file(text),public.xelay_opportunities_file_unreferenced(text),
  public.xelay_opportunities_register_file(jsonb),public.xelay_opportunities_workspace(),public.xelay_opportunities_business_registration(),
  public.xelay_opportunities_notify_company(uuid,text,text),public.xelay_opportunities_notify_admins(text,text),public.xelay_opportunities_command(jsonb) from public,anon,authenticated,service_role;
-- These boolean predicates are also used by restrictive Storage policies for
-- anon. They return false without auth.uid(); granting their execution avoids
-- breaking unrelated public buckets during policy expression initialization.
grant execute on function public.xelay_opportunities_can_upload(text),public.xelay_opportunities_can_read_file(text),public.xelay_opportunities_file_unreferenced(text) to anon,authenticated;
grant execute on function public.xelay_opportunities_enabled(),public.xelay_opportunities_register_file(jsonb),public.xelay_opportunities_workspace(),public.xelay_opportunities_command(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
