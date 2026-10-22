-- Google proves identity; Xelay profile creation still requires explicit
-- current consent and the same validated academic registration as email signup.
-- New Google identities remain provisional and have no public profile/roles.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_create_registration_profile()') is null
    or to_regprocedure('public.xelay_require_signup_privacy_consent()') is null
    or to_regprocedure('public.xelay_record_signup_privacy_consent()') is null
    or to_regprocedure('public.xelay_accept_privacy_consent(text,text,boolean)') is null
    or to_regclass('auth.identities') is null
    or to_regclass('public.user_privacy_consents') is null
    or to_regclass('public.xelay_google_registrations') is not null
    or not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass
      and tgname='xelay_registration_profile' and not tgisinternal
      and tgfoid='public.xelay_create_registration_profile()'::regprocedure)
    or position('registration_study_year_contract' in pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure))=0 then
    raise exception 'GOOGLE_REGISTRATION_PREREQUISITES_OR_STATE_CHANGED';
  end if;
end $$;

create table public.xelay_google_registrations(
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  completing boolean not null default false,
  completed_at timestamptz
);
alter table public.xelay_google_registrations enable row level security;
revoke all on table public.xelay_google_registrations from public,anon,authenticated,service_role;
comment on table public.xelay_google_registrations is
  'Private lifecycle of new Google Auth identities. No inferred privacy receipt, public profile or teaching authority. Only own completion RPC may advance it.';

-- Retain all email-signup validation. The only exception is the server-issued
-- Google provider, which creates a provisional identity, never a consent receipt.
do $$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_require_signup_privacy_consent()'::regprocedure),chr(13),'') into v_body;
  v_old:='-- Hold a shared row lock until signup commits.';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'GOOGLE_PRIVACY_GUARD_DRIFT';end if;
  v_new:=$patch$-- google_provisional_registration: raw_app_meta_data is Auth-owned.
  if new.raw_app_meta_data->>'provider'='google' then
    if nullif(btrim(new.email),'') is null
      or new.raw_user_meta_data->'email_verified' is distinct from 'true'::jsonb then
      raise exception 'GOOGLE_VERIFIED_EMAIL_REQUIRED' using errcode='42501';
    end if;
    return new;
  end if;
  $patch$;
  execute replace(v_body,v_old,v_new||v_old);

  select replace(pg_get_functiondef('public.xelay_record_signup_privacy_consent()'::regprocedure),chr(13),'') into v_body;
  v_old:='-- An old form accepted during rollout did not provide consent.';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'GOOGLE_PRIVACY_RECORDER_DRIFT';end if;
  v_new:=$patch$-- Google consent is recorded exclusively by the explicit completion RPC.
  if new.raw_app_meta_data->>'provider'='google' then return new;end if;
  $patch$;
  execute replace(v_body,v_old,v_new||v_old);

  select replace(pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure),chr(13),'') into v_body;
  v_old:='-- Ignore imports and legacy accounts; this trigger only handles our signup form.';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'GOOGLE_PROFILE_CREATOR_DRIFT';end if;
  v_new:=$patch$-- google_provisional_registration: preserve the original validated creator.
  if tg_op='INSERT' and new.raw_app_meta_data->>'provider'='google' then
    insert into public.xelay_google_registrations(user_id) values(new.id);
    return new;
  elsif tg_op='UPDATE' then
    if not exists(select 1 from public.xelay_google_registrations g
      where g.user_id=new.id and g.completing and g.completed_at is null) then
      return new;
    end if;
    if exists(select 1 from public.profiles p where p.id=new.id) then
      raise exception 'GOOGLE_PROFILE_ALREADY_EXISTS' using errcode='42501';
    end if;
  end if;
  $patch$;
  execute replace(v_body,v_old,v_new||v_old);
end $$;

-- Auth metadata updates never rerun registration for existing users. The private
-- completing flag is set only inside the locked, validated completion RPC below.
create trigger xelay_google_registration_completion
  after update of raw_user_meta_data on auth.users for each row
  execute function public.xelay_create_registration_profile();

-- An authenticated provisional identity cannot bypass consent by inserting an
-- own profile directly through the existing ordinary profile INSERT permission.
create function public.xelay_guard_google_registration_profile()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.xelay_google_registrations g where g.user_id=new.id
    and g.completed_at is null and not g.completing) then
    raise exception 'GOOGLE_REGISTRATION_REQUIRED' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_google_registration_profile() from public,anon,authenticated,service_role;
create trigger xelay_google_registration_profile_guard before insert on public.profiles
  for each row execute function public.xelay_guard_google_registration_profile();

create function public.xelay_google_registration_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null then raise exception 'GOOGLE_AUTH_REQUIRED' using errcode='42501';end if;
  if not exists(select 1 from auth.users u where u.id=v_uid and u.deleted_at is null
    and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now())) then
    raise exception 'GOOGLE_AUTH_REQUIRED' using errcode='42501';
  end if;
  if exists(select 1 from public.profiles p where p.id=v_uid) then
    return jsonb_build_object('required',false);
  end if;
  if not exists(select 1 from public.xelay_google_registrations g join auth.users u on u.id=g.user_id
    where g.user_id=v_uid and g.completed_at is null and u.email_confirmed_at is not null
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'
        and i.identity_data->>'email_verified'='true')) then
    raise exception 'GOOGLE_REGISTRATION_UNAVAILABLE' using errcode='42501';
  end if;
  return jsonb_build_object('required',true);
end $$;

create function public.xelay_complete_google_registration(
  p_profile jsonb,p_policy_version text,p_consent_version text,p_consent boolean
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_user auth.users%rowtype;v_meta jsonb;v_key text;
begin
  if v_uid is null then raise exception 'GOOGLE_AUTH_REQUIRED' using errcode='42501';end if;
  if jsonb_typeof(p_profile) is distinct from 'object' or octet_length(p_profile::text)>20000
    or p_profile->>'expected_user_id' is distinct from v_uid::text then
    raise exception 'GOOGLE_REGISTRATION_SESSION_CHANGED' using errcode='42501';
  end if;
  select * into v_user from auth.users where id=v_uid for update;
  if not found or v_user.email_confirmed_at is null or v_user.deleted_at is not null or v_user.banned_until>now()
    or not exists(select 1 from auth.identities i where i.user_id=v_uid and i.provider='google'
      and i.identity_data->>'email_verified'='true') then
    raise exception 'GOOGLE_VERIFIED_EMAIL_REQUIRED' using errcode='42501';
  end if;
  -- Retries are idempotent and never overwrite an existing same-email profile.
  if exists(select 1 from public.profiles p where p.id=v_uid) then
    return jsonb_build_object('completed',true);
  end if;
  perform 1 from public.xelay_google_registrations g where g.user_id=v_uid
    and g.completed_at is null and not g.completing for update;
  if not found then raise exception 'GOOGLE_REGISTRATION_UNAVAILABLE' using errcode='42501';end if;
  if p_consent is distinct from true then raise exception 'PRIVACY_CONSENT_REQUIRED' using errcode='22023';end if;
  if p_policy_version is distinct from '2026-10-15.1' or p_consent_version is distinct from '2026-10-15.1' then
    raise exception 'PRIVACY_VERSION_OUTDATED' using errcode='22023';
  end if;
  if p_profile->>'account_type' not in('student','teacher') or p_profile->>'account_type' is null then
    raise exception 'Invalid registration profile' using errcode='22023';
  end if;
  foreach v_key in array array['full_name','username','country','city','bio','account_type','teacher_department',
    'teacher_position','experience','university_id','academic_unit_id','specialty'] loop
    if p_profile ? v_key and jsonb_typeof(p_profile->v_key) not in('string','null') then
      raise exception 'Invalid registration profile' using errcode='22023';
    end if;
  end loop;
  if p_profile->>'account_type'='student' and p_profile->>'experience' in('bachelor','master','postgraduate')
    and coalesce(p_profile->>'study_year','') !~ '^[1-6]$' then
    raise exception 'STUDY_YEAR_INVALID' using errcode='23514';
  end if;
  -- Copy only the fields used by the existing email registration validator.
  select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) into v_meta from jsonb_each(p_profile) e
    where e.key=any(array['full_name','username','country','city','bio','account_type','teacher_department',
      'teacher_position','experience','study_year','categories','university_id','academic_unit_id','specialty_id','specialty']);
  v_meta:=v_meta||jsonb_build_object('xelay_registration_version',1,
    'xelay_privacy_consent',true,'xelay_privacy_policy_version','2026-10-15.1',
    'xelay_privacy_consent_version','2026-10-15.1');
  update public.xelay_google_registrations set completing=true where user_id=v_uid;
  perform public.xelay_accept_privacy_consent(p_policy_version,p_consent_version,true);
  -- Preserve Google's subject/email identity metadata and add validated Xelay
  -- fields. The guarded UPDATE trigger invokes the unchanged academic validator
  -- and existing profile triggers create only a pending teacher application.
  update auth.users set raw_user_meta_data=coalesce(raw_user_meta_data,'{}'::jsonb)||v_meta where id=v_uid;
  if not exists(select 1 from public.profiles p where p.id=v_uid) then
    raise exception 'GOOGLE_REGISTRATION_PROFILE_MISSING';
  end if;
  update public.xelay_google_registrations set completing=false,completed_at=clock_timestamp() where user_id=v_uid;
  return jsonb_build_object('completed',true);
end $$;

revoke all on function public.xelay_google_registration_status(),
  public.xelay_complete_google_registration(jsonb,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_google_registration_status(),
  public.xelay_complete_google_registration(jsonb,text,text,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
