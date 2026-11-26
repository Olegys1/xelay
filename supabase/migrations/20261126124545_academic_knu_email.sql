-- Educational signup requires a KNU address. Existing identities keep access.
-- Business and reserved dean identities retain their separate registration flows.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.opportunities_business_accounts') is null
    or to_regprocedure('dean_private.provisioned_identity(text,jsonb)') is null
    or to_regprocedure('public.xelay_sync_profile_auth_email()') is null then
    raise exception 'ACADEMIC_EMAIL_PREREQUISITES_MISSING';
  end if;
end $$;

-- Serialize the snapshot with signup. No profile, membership, grade, subscription
-- or stored content is rewritten. IDs are the only account data stored here.
lock table auth.users in share row exclusive mode;
create schema academic_identity_private;
revoke all on schema academic_identity_private from public, anon, authenticated, service_role;
create table academic_identity_private.accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  kind text not null check (kind in ('academic', 'business', 'service')),
  legacy boolean not null default false
);
alter table academic_identity_private.accounts enable row level security;
revoke all on academic_identity_private.accounts from public, anon, authenticated, service_role;
insert into academic_identity_private.accounts(user_id,kind,legacy)
select u.id, case
  when exists(select 1 from public.opportunities_business_accounts b where b.user_id=u.id) then 'business'
  when u.raw_app_meta_data->'dean_service'='true'::jsonb
    and u.email ~ '^dean-[a-f0-9]{10}@dean[.]xelay[.]ink$' then 'service'
  else 'academic' end, true from auth.users u;

create function academic_identity_private.is_knu_email(p_email text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_email ~* '^[^[:space:]@[:cntrl:]]{1,64}@knu[.]ua$',false);
$$;

create function academic_identity_private.guard_auth_email()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_kind text;
begin
  if tg_op='INSERT' then
    -- This exception only creates a business identity. The immutable registry
    -- below prevents a client from turning its editable metadata into a student.
    if new.raw_user_meta_data->>'xelay_registration_version'='company-1'
      and new.raw_user_meta_data->>'registration_kind'='company' then return new; end if;
    if dean_private.provisioned_identity(new.email,new.raw_app_meta_data) then return new; end if;
    if not academic_identity_private.is_knu_email(new.email) then
      raise exception 'KNU_EMAIL_REQUIRED' using errcode='23514';
    end if;
  else
    select kind into v_kind from academic_identity_private.accounts where user_id=old.id;
    if v_kind is null then raise exception 'ACADEMIC_IDENTITY_REQUIRED' using errcode='42501'; end if;
    -- Auth soft-deletion anonymizes the address. A deleted identity cannot log
    -- in; the Auth-owned deleted_at field must not block that existing workflow.
    if v_kind='academic' and new.deleted_at is null then
      -- Auth owns confirmation and uniqueness. A pending request never changes
      -- the profile email, permissions or the UUID holding the student's work.
      if (new.email is distinct from old.email and not academic_identity_private.is_knu_email(new.email))
        or (new.email_change is distinct from old.email_change and nullif(new.email_change,'') is not null
          and not academic_identity_private.is_knu_email(new.email_change)) then
        raise exception 'KNU_EMAIL_REQUIRED' using errcode='23514';
      end if;
    end if;
  end if;
  return new;
end $$;

create function academic_identity_private.record_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into academic_identity_private.accounts(user_id,kind) values(new.id,
    case when new.raw_user_meta_data->>'xelay_registration_version'='company-1'
      and new.raw_user_meta_data->>'registration_kind'='company' then 'business'
    when dean_private.provisioned_identity(new.email,new.raw_app_meta_data) then 'service'
    else 'academic' end);
  return new;
end $$;

create function academic_identity_private.guard_profile()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_account academic_identity_private.accounts; v_email text;
begin
  select * into v_account from academic_identity_private.accounts where user_id=new.id;
  if not found then raise exception 'ACADEMIC_IDENTITY_REQUIRED' using errcode='42501'; end if;
  if v_account.kind='business' then raise exception 'BUSINESS_IDENTITY_SEPARATE' using errcode='42501'; end if;
  if v_account.kind='academic' and not v_account.legacy then
    select email into v_email from auth.users where id=new.id;
    if not academic_identity_private.is_knu_email(v_email) then
      raise exception 'KNU_EMAIL_REQUIRED' using errcode='23514';
    end if;
  end if;
  return new;
end $$;

-- Dean reservation binding (xelay_01_dean_provision) runs first. Registration
-- profile creation runs after the identity is recorded, including Google finish.
create trigger xelay_02_academic_email before insert or update of email,email_change on auth.users
  for each row execute function academic_identity_private.guard_auth_email();
create trigger xelay_02_academic_identity after insert on auth.users
  for each row execute function academic_identity_private.record_identity();
create trigger xelay_academic_identity_profile before insert on public.profiles
  for each row execute function academic_identity_private.guard_profile();
revoke all on all functions in schema academic_identity_private from public,anon,authenticated,service_role;
comment on table academic_identity_private.accounts is
  'Server-only immutable signup classification. Legacy academic accounts keep login; no user metadata grants an academic exception.';
commit;
