-- Private, manually reviewed profile/status reports. No automatic sanctions,
-- entitlement changes, notification producers or access to private contacts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.premium_preferences') is null
    or to_regclass('auth.mfa_factors') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_set_participant_status(text,text)') is null then
    raise exception 'Apply the existing profile, admin MFA and participant migrations first';
  end if;
end $$;

create table if not exists public.profile_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.profiles(id) on delete set null,
  target_user_id uuid references public.profiles(id) on delete set null,
  kind text not null check(kind in('profile','status')),
  reason text not null check(reason in('harassment','hate','impersonation','inappropriate','spam','privacy','other')),
  details text not null check(char_length(details) between 10 and 2000),
  reporter_snapshot jsonb not null check(jsonb_typeof(reporter_snapshot)='object'),
  target_snapshot jsonb not null check(jsonb_typeof(target_snapshot)='object'),
  status text not null default 'open' check(status in('open','in_review','resolved','dismissed')),
  version integer not null default 1 check(version>=1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  check(reporter_id is null or target_user_id is null or reporter_id<>target_user_id)
);
create unique index if not exists profile_reports_one_open_per_kind
  on public.profile_reports(reporter_id,target_user_id,kind) where status in('open','in_review');
create index if not exists profile_reports_queue_idx on public.profile_reports(status,created_at desc,id);

create table if not exists public.profile_report_requests (
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  report_id uuid not null references public.profile_reports(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(reporter_id,request_id)
);
create index if not exists profile_report_requests_daily_idx on public.profile_report_requests(reporter_id,created_at);

create table if not exists public.profile_report_history (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.profile_reports(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  from_status text check(from_status in('open','in_review')),
  to_status text not null check(to_status in('open','in_review','resolved','dismissed')),
  action text not null check(action in('submit','none','clear_status')),
  note text not null default '' check(char_length(note)<=2000),
  created_at timestamptz not null default clock_timestamp(),
  version integer not null check(version>=1),
  unique(report_id,version),
  check((action='submit' and from_status is null and to_status='open' and version=1)
    or (action<>'submit' and from_status is not null and version>1)),
  check(action<>'clear_status' or to_status='resolved')
);

alter table public.profile_reports enable row level security;
alter table public.profile_report_requests enable row level security;
alter table public.profile_report_history enable row level security;
-- No direct policies or client/service table grants. Reads and mutations below
-- expose only the narrowly checked submission or platform-admin workflow.
revoke all on public.profile_reports,public.profile_report_requests,public.profile_report_history
  from public,anon,authenticated,service_role;

create or replace function public.xelay_submit_profile_report(
  p_request_id uuid,p_target_user_id uuid,p_kind text,p_reason text,p_details text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_details text := btrim(coalesce(p_details,''),U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  v_hash text;
  v_receipt public.profile_report_requests%rowtype;
  v_report public.profile_reports%rowtype;
  v_target public.profiles%rowtype;
  v_reporter_snapshot jsonb;
  v_target_snapshot jsonb;
  v_is_premium boolean;
  v_status_text text;
  v_emoji_status text;
  v_now timestamptz := clock_timestamp();
  v_day_start timestamptz;
begin
  if v_user_id is null or not exists(select 1 from public.profiles where id=v_user_id)
    or not exists(select 1 from auth.users u where u.id=v_user_id and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp())) then
    raise exception 'AUTH_REQUIRED' using errcode='42501';
  end if;
  if p_request_id is null then raise exception 'REPORT_REQUEST_ID_REQUIRED' using errcode='22023'; end if;
  if p_target_user_id is null then raise exception 'REPORT_TARGET_NOT_FOUND' using errcode='P0002'; end if;
  if p_target_user_id=v_user_id then raise exception 'REPORT_SELF_NOT_ALLOWED' using errcode='22023'; end if;
  if p_kind is null or p_kind not in('profile','status') then raise exception 'REPORT_KIND_INVALID' using errcode='22023'; end if;
  if p_reason is null or p_reason not in('harassment','hate','impersonation','inappropriate','spam','privacy','other') then
    raise exception 'REPORT_REASON_INVALID' using errcode='22023';
  end if;
  if char_length(v_details) not between 10 and 2000 then raise exception 'REPORT_DETAILS_INVALID' using errcode='22023'; end if;
  v_hash := encode(extensions.digest(jsonb_build_object('target_user_id',p_target_user_id,
    'kind',p_kind,'reason',p_reason,'details',v_details)::text,'sha256'),'hex');

  -- Serialize each reporter's quota and request receipts. A repeated UUID is
  -- free, even after review; reusing it with a different payload is a conflict.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:profile-report:'||v_user_id::text,0));
  select * into v_receipt from public.profile_report_requests
    where reporter_id=v_user_id and request_id=p_request_id;
  if found then
    if v_receipt.payload_hash is distinct from v_hash then raise exception 'REPORT_REQUEST_CONFLICT' using errcode='22023'; end if;
    select * into v_report from public.profile_reports where id=v_receipt.report_id;
    return jsonb_build_object('id',v_report.id,'status',v_report.status,'duplicate',true);
  end if;
  v_day_start := date_trunc('day',v_now at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv';
  if (select count(*) from public.profile_report_requests where reporter_id=v_user_id and created_at>=v_day_start)>=10 then
    raise exception 'REPORT_RATE_LIMITED' using errcode='54000';
  end if;

  select * into v_report from public.profile_reports
    where reporter_id=v_user_id and target_user_id=p_target_user_id and kind=p_kind and status in('open','in_review') for update;
  if found then
    insert into public.profile_report_requests(reporter_id,request_id,payload_hash,report_id,created_at)
      values(v_user_id,p_request_id,v_hash,v_report.id,v_now);
    return jsonb_build_object('id',v_report.id,'status',v_report.status,'duplicate',true);
  end if;

  select * into v_target from public.profiles where id=p_target_user_id;
  if not found then raise exception 'REPORT_TARGET_NOT_FOUND' using errcode='P0002'; end if;
  -- Same key as the participant setter: a status snapshot cannot interleave
  -- with its two-column atomic status save or an administrative clear.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:participant-status:'||p_target_user_id::text,0));
  v_is_premium := coalesce(public.xelay_has_participant_access(p_target_user_id),false);
  if v_is_premium then
    select status_text,emoji_status into v_status_text,v_emoji_status from public.premium_preferences where user_id=p_target_user_id;
  end if;
  if p_kind='status' and coalesce(v_status_text,'')='' and coalesce(v_emoji_status,'')='' then
    raise exception 'REPORT_TARGET_STATUS_NOT_FOUND' using errcode='P0002';
  end if;
  select jsonb_build_object('user_id',p.id,'full_name',p.full_name,'username',p.username,'avatar_url',p.avatar_url)
    into v_reporter_snapshot from public.profiles p where p.id=v_user_id;
  -- Explicit allowlist: never copy the profile row, email, private chat settings,
  -- billing records, student work, grades or Auth metadata into a complaint.
  v_target_snapshot := jsonb_build_object('user_id',v_target.id,'full_name',v_target.full_name,'username',v_target.username,
    'avatar_url',v_target.avatar_url,'bio',v_target.bio,'university_id',v_target.university_id,
    'academic_unit_id',v_target.academic_unit_id,'faculty',v_target.faculty,'specialty',v_target.specialty,
    'study_year',v_target.study_year,'experience',v_target.experience,'is_premium',v_is_premium,
    'status_text',v_status_text,'emoji_status',v_emoji_status);
  insert into public.profile_reports(reporter_id,target_user_id,kind,reason,details,reporter_snapshot,target_snapshot,created_at,updated_at)
    values(v_user_id,p_target_user_id,p_kind,p_reason,v_details,v_reporter_snapshot,v_target_snapshot,v_now,v_now)
    returning * into v_report;
  insert into public.profile_report_requests(reporter_id,request_id,payload_hash,report_id,created_at)
    values(v_user_id,p_request_id,v_hash,v_report.id,v_now);
  insert into public.profile_report_history(report_id,actor_id,from_status,to_status,action,note,created_at,version)
    values(v_report.id,v_user_id,null,'open','submit','',v_now,1);
  return jsonb_build_object('id',v_report.id,'status',v_report.status,'duplicate',false);
end $$;

create or replace function public.xelay_admin_profile_reports(p_status text,p_limit integer,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb; v_total bigint; v_open_count bigint;
begin
  if auth.uid() is null or not coalesce(public.xelay_is_platform_admin(),false)
    or not exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if p_status is null or p_status not in('all','open','in_review','resolved','dismissed')
    or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception 'REPORT_LIST_INVALID' using errcode='22023';
  end if;
  select count(*) into v_total from public.profile_reports r where p_status='all' or r.status=p_status;
  select count(*) into v_open_count from public.profile_reports r where r.status in('open','in_review');
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id),'[]'::jsonb) into v_items
    from (select r.* from public.profile_reports r where p_status='all' or r.status=p_status
      order by r.created_at desc,r.id limit p_limit offset p_offset) q;
  return jsonb_build_object('items',v_items,'total',v_total,'open_count',v_open_count);
end $$;

create or replace function public.xelay_admin_profile_report(p_report_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_report public.profile_reports%rowtype; v_history jsonb; v_current jsonb;
  v_is_premium boolean; v_status_text text; v_emoji_status text;
begin
  if auth.uid() is null or not coalesce(public.xelay_is_platform_admin(),false)
    or not exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  select * into v_report from public.profile_reports where id=p_report_id;
  if not found then raise exception 'REPORT_NOT_FOUND' using errcode='P0002'; end if;
  select coalesce(jsonb_agg(to_jsonb(h) order by h.version,h.id),'[]'::jsonb) into v_history
    from public.profile_report_history h where h.report_id=p_report_id;
  if v_report.target_user_id is not null and exists(select 1 from public.profiles where id=v_report.target_user_id) then
    v_is_premium := coalesce(public.xelay_has_participant_access(v_report.target_user_id),false);
    if v_is_premium then
      select status_text,emoji_status into v_status_text,v_emoji_status from public.premium_preferences where user_id=v_report.target_user_id;
    end if;
    v_current := jsonb_build_object('is_premium',v_is_premium,'status_text',v_status_text,'emoji_status',v_emoji_status);
  end if;
  return jsonb_build_object('report',to_jsonb(v_report),'history',v_history,'current_status',v_current);
end $$;

create or replace function public.xelay_admin_review_profile_report(
  p_report_id uuid,p_expected_version integer,p_status text,p_note text,p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_report public.profile_reports%rowtype;
  v_note text := btrim(coalesce(p_note,''),U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  v_status_text text; v_emoji_status text; v_from_status text; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not coalesce(public.xelay_is_platform_admin(),false)
    or not exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=clock_timestamp()))
    or coalesce(auth.jwt()->>'aal','')<>'aal2'
    or not exists(select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='ADMIN')
    or not exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode='42501';
  end if;
  if p_status is null or p_status not in('in_review','resolved','dismissed') then
    raise exception 'REPORT_TRANSITION_INVALID' using errcode='22023';
  end if;
  if p_action is null or p_action not in('none','clear_status') then raise exception 'REPORT_ACTION_INVALID' using errcode='22023'; end if;
  if char_length(v_note)>2000 or (p_status in('resolved','dismissed') and char_length(v_note)<10) then
    raise exception 'REPORT_REVIEW_NOTE_INVALID' using errcode='22023';
  end if;
  select * into v_report from public.profile_reports where id=p_report_id for update;
  if not found then raise exception 'REPORT_NOT_FOUND' using errcode='P0002'; end if;
  if p_expected_version is null or p_expected_version is distinct from v_report.version then
    raise exception 'REPORT_CONFLICT' using errcode='40001';
  end if;
  if v_report.status in('resolved','dismissed') then raise exception 'REPORT_FINALIZED' using errcode='22023'; end if;
  if v_report.status='in_review' and p_status='in_review' then raise exception 'REPORT_TRANSITION_INVALID' using errcode='22023'; end if;
  if p_action='clear_status' then
    if v_report.kind<>'status' or p_status<>'resolved' then raise exception 'REPORT_ACTION_INVALID' using errcode='22023'; end if;
    if v_report.target_user_id is null then raise exception 'REPORT_STATUS_CHANGED' using errcode='40001'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:participant-status:'||v_report.target_user_id::text,0));
    select status_text,emoji_status into v_status_text,v_emoji_status from public.premium_preferences
      where user_id=v_report.target_user_id for update;
    if not found or v_status_text is distinct from (v_report.target_snapshot->>'status_text')
      or v_emoji_status is distinct from (v_report.target_snapshot->>'emoji_status')
      or (coalesce(v_status_text,'')='' and coalesce(v_emoji_status,'')='') then
      raise exception 'REPORT_STATUS_CHANGED' using errcode='40001';
    end if;
    -- Only the two reported status fields are cleared. Appearance, access,
    -- profile/Auth rows, payments and subscriptions are never changed.
    update public.premium_preferences set status_text=null,emoji_status=null,updated_at=v_now
      where user_id=v_report.target_user_id;
  end if;
  v_from_status := v_report.status;
  update public.profile_reports set status=p_status,version=version+1,updated_at=v_now,reviewed_at=v_now,reviewed_by=auth.uid()
    where id=p_report_id returning * into v_report;
  insert into public.profile_report_history(report_id,actor_id,from_status,to_status,action,note,created_at,version)
    values(p_report_id,auth.uid(),v_from_status,p_status,p_action,v_note,v_now,v_report.version);
  return public.xelay_admin_profile_report(p_report_id)-'current_status';
end $$;

revoke all on function public.xelay_submit_profile_report(uuid,uuid,text,text,text),
  public.xelay_admin_profile_reports(text,integer,integer),public.xelay_admin_profile_report(uuid),
  public.xelay_admin_review_profile_report(uuid,integer,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_submit_profile_report(uuid,uuid,text,text,text),
  public.xelay_admin_profile_reports(text,integer,integer),public.xelay_admin_profile_report(uuid),
  public.xelay_admin_review_profile_report(uuid,integer,text,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
