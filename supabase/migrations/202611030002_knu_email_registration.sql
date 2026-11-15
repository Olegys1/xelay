-- Prepared locally only. Activation requires a checked GoTrue Confirm email ON
-- setting and the Before User Created hook configured by an administrator.
-- Existing Auth UUIDs/emails and all roles remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if not exists(select 1 from pg_roles where rolname='supabase_auth_admin')
    or to_regclass('auth.users') is null
    or to_regclass('public.xelay_knu_email_legacy_users') is not null then
    raise exception 'KNU_EMAIL_DEPLOYMENT_PREREQUISITE';
  end if;
end $$;
-- The snapshot and signup guard must have no concurrent-insert gap.
lock table auth.users in share row exclusive mode;

create function public.xelay_normalize_knu_email(p_email text)
returns text language plpgsql immutable set search_path='' as $$
declare v_email text:=btrim(p_email,E' \t\n\r\f'||chr(11));v_local text;
begin
  if v_email is null or length(v_email)>254 or v_email collate "C" !~ '^[!-~]+$' then return null;end if;
  v_email:=lower(v_email collate "C");
  if length(v_email)-length(replace(v_email,'@',''))<>1
    or split_part(v_email,'@',2)<>'knu.ua' then return null;end if;
  v_local:=split_part(v_email,'@',1);
  if length(v_local) not between 1 and 64 or v_local !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+$'
    or left(v_local,1)='.' or right(v_local,1)='.' or strpos(v_local,'..')>0 then return null;end if;
  return v_email;
end $$;
revoke all on function public.xelay_normalize_knu_email(text) from public,anon,authenticated,service_role;

create table public.xelay_knu_email_legacy_users(
  user_id uuid primary key references auth.users(id) on delete cascade,
  captured_at timestamptz not null default clock_timestamp()
);
-- Include every existing Auth identity, including unfinished Google profiles.
insert into public.xelay_knu_email_legacy_users(user_id) select id from auth.users;
create table public.xelay_knu_email_affiliations(
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check(public.xelay_normalize_knu_email(email) is not null and email=public.xelay_normalize_knu_email(email)),
  verified_at timestamptz not null,
  source text not null check(source in('auth','secondary'))
);
do $$ begin
  if exists(select 1 from auth.users where public.xelay_normalize_knu_email(email) is not null
    group by public.xelay_normalize_knu_email(email) having count(*)>1) then
    raise exception 'KNU_EMAIL_EXISTING_IDENTITY_CONFLICT';
  end if;
end $$;
insert into public.xelay_knu_email_affiliations(user_id,email,verified_at,source)
  select id,public.xelay_normalize_knu_email(email),email_confirmed_at,'auth' from auth.users
  where public.xelay_normalize_knu_email(email) is not null and email_confirmed_at is not null and deleted_at is null;

create table public.xelay_knu_email_challenges(
  id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check(public.xelay_normalize_knu_email(email) is not null and email=public.xelay_normalize_knu_email(email)),
  code_digest text not null check(code_digest ~ '^[a-f0-9]{64}$'),
  state text not null check(state in('pending','sent','failed','invalidated','consumed','expired')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null,
  resend_at timestamptz not null,consumed_at timestamptz,
  check(expires_at>created_at and expires_at<=created_at+interval '10 minutes'),
  check(resend_at>=created_at+interval '60 seconds')
);
create index xelay_knu_challenge_actor on public.xelay_knu_email_challenges(user_id,created_at desc);
create index xelay_knu_challenge_email on public.xelay_knu_email_challenges(email,created_at desc);
create index xelay_knu_challenge_created on public.xelay_knu_email_challenges(created_at);
alter table public.xelay_knu_email_legacy_users enable row level security;
alter table public.xelay_knu_email_affiliations enable row level security;
alter table public.xelay_knu_email_challenges enable row level security;
revoke all on public.xelay_knu_email_legacy_users,public.xelay_knu_email_affiliations,public.xelay_knu_email_challenges
  from public,anon,authenticated,service_role;

create function public.xelay_knu_auth_email_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_email text:=public.xelay_normalize_knu_email(new.email);
begin
  -- A server-owned deletion can anonymize an inactive Auth row. Restoration
  -- also fires this trigger and must pass the normal new-account policy.
  if tg_op='UPDATE' and new.deleted_at is not null then return new;end if;
  if tg_op='INSERT' or not exists(select 1 from public.xelay_knu_email_legacy_users where user_id=new.id) then
    if v_email is null then raise exception 'KNU_EMAIL_REQUIRED' using errcode='42501';end if;
  end if;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||new.id::text,0));
    perform pg_advisory_xact_lock(hashtextextended('xelay:knu-email:'||v_email,0));
    -- Do not disclose a private secondary binding via an unconfirmed signup.
    -- Confirmation or an initially confirmed OAuth signup must check it.
    if (new.email_confirmed_at is not null and exists(select 1 from public.xelay_knu_email_affiliations where email=v_email and user_id<>new.id))
      or exists(select 1 from auth.users where id<>new.id and deleted_at is null and public.xelay_normalize_knu_email(email)=v_email) then
      raise exception 'KNU_EMAIL_IN_USE' using errcode='23505';
    end if;
  end if;
  return new;
end $$;
create trigger xelay_knu_auth_email_guard before insert or update of email,email_confirmed_at,deleted_at on auth.users
  for each row execute function public.xelay_knu_auth_email_guard();

create function public.xelay_knu_auth_email_confirmed()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_email text:=public.xelay_normalize_knu_email(new.email);
begin
  if new.deleted_at is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||new.id::text,0));
    delete from public.xelay_knu_email_affiliations where user_id=new.id;
    update public.xelay_knu_email_challenges set state='invalidated' where user_id=new.id and state in('pending','sent');
    return new;
  end if;
  if v_email is not null and new.email_confirmed_at is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||new.id::text,0));
    perform pg_advisory_xact_lock(hashtextextended('xelay:knu-email:'||v_email,0));
    insert into public.xelay_knu_email_affiliations(user_id,email,verified_at,source)
      values(new.id,v_email,new.email_confirmed_at,'auth')
      on conflict(user_id) do update set email=excluded.email,
        verified_at=case when xelay_knu_email_affiliations.email=excluded.email then xelay_knu_email_affiliations.verified_at else excluded.verified_at end,source='auth';
    update public.xelay_knu_email_challenges set state='invalidated' where user_id=new.id and state in('pending','sent');
  end if;
  return new;
end $$;
create trigger xelay_knu_auth_email_confirmed after insert or update of email,email_confirmed_at,deleted_at on auth.users
  for each row execute function public.xelay_knu_auth_email_confirmed();
revoke all on function public.xelay_knu_auth_email_guard(),public.xelay_knu_auth_email_confirmed() from public,anon,authenticated,service_role;

-- Supabase Auth calls this hook before creating an email or OAuth identity.
-- Grants, not user-editable metadata or the SECURITY DEFINER owner, authorize it.
create function public.xelay_before_user_created_knu(p_event jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_email text:=public.xelay_normalize_knu_email(p_event->'user'->>'email');
begin
  if v_email is null then
    return jsonb_build_object('error',jsonb_build_object('http_code',400,'message','KNU_EMAIL_REQUIRED: Для нового акаунта потрібна пошта @knu.ua. Якщо акаунт уже є, увійдіть зі звичною поштою.'));
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.xelay_before_user_created_knu(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_before_user_created_knu(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;

create function public.xelay_private_knu_active(p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null
    and deleted_at is null and coalesce(banned_until,'-infinity'::timestamptz)<=now());
$$;
create function public.xelay_private_knu_status(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('verifiedEmail',a.email,'verifiedAt',a.verified_at,
    'authEmailVerified',coalesce(public.xelay_normalize_knu_email(u.email)=a.email and u.email_confirmed_at is not null,false))
    ||case when c.id is null then '{}'::jsonb else jsonb_build_object('challenge',jsonb_build_object(
      'id',c.id,'email',c.email,'expiresAt',c.expires_at,'resendAt',c.resend_at)) end
  from auth.users u left join public.xelay_knu_email_affiliations a on a.user_id=u.id
    left join lateral(select id,email,expires_at,resend_at from public.xelay_knu_email_challenges
      where user_id=u.id and state='sent' and expires_at>now() and attempts<5 order by created_at desc limit 1)c on true
  where u.id=p_user;
$$;
create function public.xelay_knu_email_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.xelay_private_knu_active(auth.uid()) then
    raise exception 'KNU_EMAIL_AUTH_REQUIRED' using errcode='42501';end if;
  return public.xelay_private_knu_status(auth.uid());
end $$;

create function public.xelay_knu_email_prepare(p_user uuid,p_id uuid,p_email text,p_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_email text:=public.xelay_normalize_knu_email(p_email);v_now timestamptz:=clock_timestamp();v_last timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'KNU_EMAIL_FORBIDDEN' using errcode='42501';end if;
  if not public.xelay_private_knu_active(p_user) then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
  if p_id is null or v_email is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'code','KNU_EMAIL_INVALID');end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-daily-mail',0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||p_user::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-email:'||v_email,0));
  if not public.xelay_private_knu_active(p_user) then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
  if exists(select 1 from public.xelay_knu_email_affiliations where user_id=p_user and email=v_email)
    or exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null and public.xelay_normalize_knu_email(email) is not null) then
    return jsonb_build_object('ok',true,'alreadyVerified',true,'status',public.xelay_private_knu_status(p_user));end if;
  -- Do not disclose anyone else's bindings here. The request and mail budgets
  -- are identical for occupied and unoccupied addresses; only a valid code
  -- holder may learn that the address is in use.
  select max(resend_at) into v_last from public.xelay_knu_email_challenges where user_id=p_user;
  if v_last>v_now then return jsonb_build_object('ok',false,'code','KNU_EMAIL_RATE_LIMIT','retryAfterSeconds',greatest(1,ceil(extract(epoch from v_last-v_now))::integer));end if;
  if (select count(*) from public.xelay_knu_email_challenges where user_id=p_user and created_at>v_now-interval '1 hour')>=3
    or(select count(*) from public.xelay_knu_email_challenges where email=v_email and created_at>v_now-interval '1 hour')>=3 then
    return jsonb_build_object('ok',false,'code','KNU_EMAIL_RATE_LIMIT','retryAfterSeconds',3600);end if;
  if (select count(*) from public.xelay_knu_email_challenges where user_id=p_user and created_at>v_now-interval '1 day')>=10
    or(select count(*) from public.xelay_knu_email_challenges where email=v_email and created_at>v_now-interval '1 day')>=10
    or(select count(*) from public.xelay_knu_email_challenges where created_at>v_now-interval '1 day')>=200 then
    return jsonb_build_object('ok',false,'code','KNU_EMAIL_RATE_LIMIT','retryAfterSeconds',86400);end if;
  delete from public.xelay_knu_email_challenges where id in(select id from public.xelay_knu_email_challenges where created_at<v_now-interval '2 days' order by created_at limit 1000);
  update public.xelay_knu_email_challenges set state='invalidated' where user_id=p_user and state in('pending','sent');
  insert into public.xelay_knu_email_challenges(id,user_id,email,code_digest,state,created_at,expires_at,resend_at)
    values(p_id,p_user,v_email,p_digest,'pending',v_now,v_now+interval '10 minutes',v_now+interval '60 seconds');
  return jsonb_build_object('ok',true,'id',p_id);
end $$;

create function public.xelay_knu_email_delivery(p_user uuid,p_id uuid,p_delivered boolean)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'KNU_EMAIL_FORBIDDEN' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||p_user::text,0));
  update public.xelay_knu_email_challenges set state=case when p_delivered is true then 'sent' else 'failed' end
    where id=p_id and user_id=p_user and state='pending' and expires_at>clock_timestamp();
  if not found then return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_EXPIRED');end if;
  return jsonb_build_object('ok',true,'status',public.xelay_private_knu_status(p_user));
end $$;

create function public.xelay_knu_email_challenge(p_user uuid,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_challenge public.xelay_knu_email_challenges%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'KNU_EMAIL_FORBIDDEN' using errcode='42501';end if;
  if not public.xelay_private_knu_active(p_user) then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
  select * into v_challenge from public.xelay_knu_email_challenges where id=p_id and user_id=p_user;
  if not found or v_challenge.state<>'sent' or v_challenge.attempts>=5 then return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_INVALID');end if;
  if v_challenge.expires_at<=now() then return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_EXPIRED');end if;
  return jsonb_build_object('ok',true,'email',v_challenge.email);
end $$;

create function public.xelay_knu_email_verify(p_user uuid,p_id uuid,p_digest text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_challenge public.xelay_knu_email_challenges%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'KNU_EMAIL_FORBIDDEN' using errcode='42501';end if;
  if not public.xelay_private_knu_active(p_user) then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-user:'||p_user::text,0));
  if not public.xelay_private_knu_active(p_user) then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
  select * into v_challenge from public.xelay_knu_email_challenges where id=p_id and user_id=p_user for update;
  if not found or v_challenge.state<>'sent' or v_challenge.attempts>=5 then return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_INVALID');end if;
  if v_challenge.expires_at<=clock_timestamp() then
    update public.xelay_knu_email_challenges set state='expired' where id=p_id;
    return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_EXPIRED');end if;
  update public.xelay_knu_email_challenges set attempts=attempts+1 where id=p_id;
  if p_digest is null or p_digest !~ '^[a-f0-9]{64}$' or p_digest<>v_challenge.code_digest then
    return jsonb_build_object('ok',false,'code','KNU_EMAIL_CODE_INVALID');end if;
  if exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null and public.xelay_normalize_knu_email(email) is not null) then
    update public.xelay_knu_email_challenges set state='invalidated' where id=p_id;
    return jsonb_build_object('ok',true,'status',public.xelay_private_knu_status(p_user));end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:knu-email:'||v_challenge.email,0));
  if exists(select 1 from public.xelay_knu_email_affiliations where email=v_challenge.email and user_id<>p_user)
    or exists(select 1 from auth.users where id<>p_user and email_confirmed_at is not null and deleted_at is null and public.xelay_normalize_knu_email(email)=v_challenge.email) then
    return jsonb_build_object('ok',false,'code','KNU_EMAIL_IN_USE');end if;
  insert into public.xelay_knu_email_affiliations(user_id,email,verified_at,source)
    values(p_user,v_challenge.email,clock_timestamp(),'secondary')
    on conflict(user_id) do update set email=excluded.email,verified_at=excluded.verified_at,source='secondary';
  update public.xelay_knu_email_challenges set state='consumed',consumed_at=clock_timestamp() where id=p_id;
  return jsonb_build_object('ok',true,'status',public.xelay_private_knu_status(p_user));
end $$;

revoke all on function public.xelay_private_knu_active(uuid),public.xelay_private_knu_status(uuid),public.xelay_knu_email_status(),
  public.xelay_knu_email_prepare(uuid,uuid,text,text),public.xelay_knu_email_delivery(uuid,uuid,boolean),
  public.xelay_knu_email_challenge(uuid,uuid),public.xelay_knu_email_verify(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_knu_email_status() to authenticated;
grant execute on function public.xelay_knu_email_prepare(uuid,uuid,text,text),public.xelay_knu_email_delivery(uuid,uuid,boolean),
  public.xelay_knu_email_challenge(uuid,uuid),public.xelay_knu_email_verify(uuid,uuid,text) to service_role;
comment on table public.xelay_knu_email_affiliations is 'Private confirmed KNU mail ownership. No role, teacher approval or canonical Auth-email rewrite.';
comment on table public.xelay_knu_email_challenges is 'Private HMAC digests only. 10-minute, single-use challenges; 5 guesses, resend cooldown and durable hourly/daily caps. No codes or provider payloads.';
notify pgrst,'reload schema';
commit;
