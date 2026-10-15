-- Install the receipt recorder before publishing the matching signup form.
-- During rollout, entirely legacy requests may finish without a receipt. Once
-- the frontend is Ready, enable enforce_new_signups in the private singleton.
-- New manual Auth creation/imports then use the same explicit consent contract.
-- Existing accounts, Auth updates and their current platform access are intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('auth.users') is null
    or to_regprocedure('auth.uid()') is null
    or to_regprocedure('public.xelay_create_registration_profile()') is null then
    raise exception 'PRIVACY_CONSENT_PREREQUISITES_MISSING';
  end if;
end;
$$;

create table if not exists public.xelay_privacy_consent_settings (
  singleton boolean primary key default true check (singleton),
  enforce_new_signups boolean not null default false
);
alter table public.xelay_privacy_consent_settings enable row level security;
revoke all on table public.xelay_privacy_consent_settings from public,anon,authenticated,service_role;
insert into public.xelay_privacy_consent_settings(singleton,enforce_new_signups)
  values(true,false) on conflict(singleton) do nothing;
comment on table public.xelay_privacy_consent_settings is
  'Private rollout switch. After the consent form is Ready, an operator enables strict new-signup consent. No client grants or RPC; reruns preserve activation.';

create table if not exists public.user_privacy_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  privacy_policy_version text not null check (
    length(privacy_policy_version) between 1 and 80 and privacy_policy_version !~ '[[:cntrl:]]'),
  consent_version text not null check (
    length(consent_version) between 1 and 80 and consent_version !~ '[[:cntrl:]]'),
  accepted_at timestamptz not null default clock_timestamp(),
  source text not null,
  primary key(user_id,privacy_policy_version,consent_version)
);
alter table public.user_privacy_consents
  drop constraint if exists user_privacy_consents_source_check;
alter table public.user_privacy_consents
  add constraint user_privacy_consents_source_check check (source in('signup','account'));

comment on table public.user_privacy_consents is
  'Private immutable evidence of explicit signup or own-account consent, recorded with server versions and time. Existing accounts are not backfilled. Not payment, marketing or application-sharing consent.';
comment on column public.user_privacy_consents.accepted_at is
  'Server clock when explicit consent is recorded, not a user-provided date or editable Auth metadata.';

alter table public.user_privacy_consents enable row level security;
revoke all on table public.user_privacy_consents from public,anon,authenticated,service_role;
grant select on table public.user_privacy_consents to authenticated;
drop policy if exists "Users read own privacy receipts" on public.user_privacy_consents;
create policy "Users read own privacy receipts" on public.user_privacy_consents
  for select to authenticated using (user_id=auth.uid());
drop policy if exists "Privacy receipt owner read guard" on public.user_privacy_consents;
create policy "Privacy receipt owner read guard" on public.user_privacy_consents as restrictive
  for select to anon,authenticated using (user_id=auth.uid());

-- The registration marker and database role never exempt a signup: regular
-- GoTrue uses auth-admin too. Grace permits only complete absence of all three
-- privacy keys; any supplied privacy data is validated strictly from day one.
create or replace function public.xelay_require_signup_privacy_consent()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_meta jsonb:=coalesce(new.raw_user_meta_data,'{}'::jsonb);
  v_enforce boolean;
begin
  -- Hold a shared row lock until signup commits. Activation waits for in-flight
  -- legacy requests, and later signups observe the enabled strict guard.
  select enforce_new_signups into v_enforce from public.xelay_privacy_consent_settings
    where singleton for share;
  if not found or v_enforce is null then
    raise exception 'PRIVACY_CONSENT_CONFIGURATION_MISSING' using errcode='22023';
  end if;
  if not v_enforce and not (v_meta ?| array[
    'xelay_privacy_consent','xelay_privacy_policy_version','xelay_privacy_consent_version'
  ]) then return new; end if;
  if v_meta->'xelay_privacy_consent' is distinct from 'true'::jsonb then
    raise exception 'PRIVACY_CONSENT_REQUIRED' using errcode='22023';
  end if;
  if v_meta->>'xelay_privacy_policy_version' is distinct from '2026-10-15.1'
    or v_meta->>'xelay_privacy_consent_version' is distinct from '2026-10-15.1' then
    raise exception 'PRIVACY_VERSION_OUTDATED' using errcode='22023';
  end if;
  return new;
end;
$$;

-- Versions and acceptance time are generated here. Future metadata/profile
-- edits cannot change a receipt; all signup triggers share one transaction.
create or replace function public.xelay_record_signup_privacy_consent()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_meta jsonb:=coalesce(new.raw_user_meta_data,'{}'::jsonb);
begin
  -- An old form accepted during rollout did not provide consent. Never turn
  -- that absence into an acceptance record or infer it from account creation.
  if v_meta->'xelay_privacy_consent' is distinct from 'true'::jsonb
    or v_meta->>'xelay_privacy_policy_version' is distinct from '2026-10-15.1'
    or v_meta->>'xelay_privacy_consent_version' is distinct from '2026-10-15.1' then
    return new;
  end if;
  insert into public.user_privacy_consents(
    user_id,privacy_policy_version,consent_version,accepted_at,source
  ) values(new.id,'2026-10-15.1','2026-10-15.1',clock_timestamp(),'signup');
  return new;
end;
$$;

-- Preserve evidence against ordinary updates/deletes. Auth account deletion
-- may cascade its own receipts after the parent row has been removed.
create or replace function public.xelay_guard_privacy_consent_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' and not exists(select 1 from auth.users where id=old.user_id) then
    return old;
  end if;
  raise exception 'PRIVACY_CONSENT_RECEIPT_IMMUTABLE' using errcode='42501';
end;
$$;

-- Existing users can explicitly acknowledge the current documents themselves.
-- Identity, time and source are fixed server-side; replaying the same acceptance
-- preserves the original receipt, including a receipt recorded during signup.
create or replace function public.xelay_accept_privacy_consent(
  p_policy_version text,p_consent_version text,p_consent boolean
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_receipt jsonb;
begin
  if v_uid is null then raise exception 'PRIVACY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_consent is distinct from true then
    raise exception 'PRIVACY_CONSENT_REQUIRED' using errcode='22023';
  end if;
  if p_policy_version is distinct from '2026-10-15.1'
    or p_consent_version is distinct from '2026-10-15.1' then
    raise exception 'PRIVACY_VERSION_OUTDATED' using errcode='22023';
  end if;
  insert into public.user_privacy_consents(
    user_id,privacy_policy_version,consent_version,accepted_at,source
  ) values(v_uid,'2026-10-15.1','2026-10-15.1',clock_timestamp(),'account')
    on conflict(user_id,privacy_policy_version,consent_version) do nothing;
  select jsonb_build_object('privacy_policy_version',r.privacy_policy_version,
    'consent_version',r.consent_version,'accepted_at',r.accepted_at,'source',r.source)
    into v_receipt from public.user_privacy_consents r
    where r.user_id=v_uid and r.privacy_policy_version='2026-10-15.1'
      and r.consent_version='2026-10-15.1';
  return v_receipt;
end;
$$;

revoke all on function public.xelay_require_signup_privacy_consent(),
  public.xelay_record_signup_privacy_consent(),public.xelay_guard_privacy_consent_receipt(),
  public.xelay_accept_privacy_consent(text,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_accept_privacy_consent(text,text,boolean) to authenticated;

drop trigger if exists xelay_auth_privacy_consent_guard on auth.users;
create trigger xelay_auth_privacy_consent_guard before insert on auth.users
  for each row execute function public.xelay_require_signup_privacy_consent();
drop trigger if exists xelay_0_privacy_consent_receipt on auth.users;
create trigger xelay_0_privacy_consent_receipt after insert on auth.users
  for each row execute function public.xelay_record_signup_privacy_consent();
drop trigger if exists privacy_consent_receipt_immutable on public.user_privacy_consents;
create trigger privacy_consent_receipt_immutable before update or delete on public.user_privacy_consents
  for each row execute function public.xelay_guard_privacy_consent_receipt();

notify pgrst,'reload schema';
commit;
