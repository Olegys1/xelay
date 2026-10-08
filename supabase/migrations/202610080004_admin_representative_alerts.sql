-- Persistent administrator alerts for unreviewed class-representative requests.
-- Telegram receives only an aggregate count and waiting time. Request content
-- remains in the existing administration interface; the new alert summary
-- independently requires current platform ADMIN, AAL2 and a verified MFA factor.
begin;

do $$
begin
  if to_regclass('public.class_representative_requests') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regclass('auth.mfa_factors') is null then
    raise exception 'Class-representative requests, administrator role helper and Auth MFA factors are required';
  end if;
  if not exists (select 1 from pg_catalog.pg_class c
    where c.oid = 'public.class_representative_requests'::regclass and c.relrowsecurity) then
    raise exception 'Class-representative request RLS must remain enabled';
  end if;
end $$;

-- This row is durable even when Telegram is not configured or is unavailable.
-- New requests advance generation; successful delivery acknowledges only the
-- snapshot actually prepared for that send. A new request cannot replace a lease.
create table if not exists public.admin_representative_alert_delivery (
  singleton boolean primary key default true check (singleton),
  generation bigint not null default 0 check (generation >= 0),
  sent_generation bigint not null default 0 check (sent_generation >= 0 and sent_generation <= generation),
  attempts integer not null default 0 check (attempts between 0 and 30),
  next_attempt_at timestamptz not null default clock_timestamp(),
  provider_retry_until timestamptz,
  last_sent_at timestamptz,
  last_error_code text,
  last_queue_changed_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  claimed_generation bigint,
  constraint admin_representative_alert_lease_check check (
    (lease_token is null and lease_until is null and claimed_generation is null)
    or (lease_token is not null and lease_until is not null and claimed_generation is not null
      and claimed_generation between 0 and generation)
  ),
  constraint admin_representative_alert_error_check check (
    last_error_code is null or last_error_code in (
      'telegram_rate_limited', 'telegram_unavailable', 'telegram_configuration',
      'telegram_chat_not_private', 'malformed_queue', 'delivery_deadline',
      'delivery_temporarily_unavailable', 'delivery_receipt_unavailable'
    )
  )
);
alter table public.admin_representative_alert_delivery enable row level security;
revoke all on public.admin_representative_alert_delivery from public, anon, authenticated, service_role;
insert into public.admin_representative_alert_delivery (singleton) values (true)
  on conflict (singleton) do nothing;

-- Owner-only helper: no anonymous/account-lookup endpoint and no applicant PII.
create or replace function public.xelay_private_representative_pending_summary()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'pending_count', count(*),
    -- Preserve normal historic timestamps, while caller-supplied infinite/BC/
    -- future dates cannot poison ISO parsing or produce negative waiting time.
    'oldest_pending_at', min(case when isfinite(r.created_at)
      and r.created_at >= timestamptz '1970-01-01 00:00:00+00'
      then least(r.created_at, statement_timestamp()) else statement_timestamp() end),
    'latest_pending_at', max(case when isfinite(r.created_at)
      and r.created_at >= timestamptz '1970-01-01 00:00:00+00'
      then least(r.created_at, statement_timestamp()) else statement_timestamp() end),
    'latest_request_id', (select newest.id from public.class_representative_requests newest
      where newest.status = 'pending' order by newest.created_at desc, newest.id desc limit 1)
  )
  from public.class_representative_requests r where r.status = 'pending';
$$;
revoke all on function public.xelay_private_representative_pending_summary()
  from public, anon, authenticated, service_role;

create or replace function public.xelay_admin_representative_alert_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  -- Check current platform-role semantics and explicitly enforce AAL2 plus a
  -- verified factor for this new read, independently of the legacy role helper.
  -- Client flags do not authorize a read; the shared helper is not modified.
  if auth.uid() is null or not coalesce(public.xelay_is_platform_admin(), false)
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
    or not exists (select 1 from auth.mfa_factors f
      where f.user_id = auth.uid() and f.status = 'verified') then
    raise exception 'ADMIN_MFA_REQUIRED' using errcode = '42501';
  end if;
  -- created_at on the historical request table is caller-suppliable through its
  -- existing INSERT grant. The trigger-owned generation identifies new arrivals
  -- reliably even if timestamps/counts stay unchanged between administrator polls.
  return public.xelay_private_representative_pending_summary()
    || jsonb_build_object('alert_generation', (select s.generation
      from public.admin_representative_alert_delivery s where s.singleton));
end $$;

create or replace function public.xelay_private_queue_representative_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_new_pending boolean := false;
begin
  if tg_op = 'INSERT' then
    v_new_pending := new.status = 'pending';
  elsif tg_op = 'UPDATE' then
    v_new_pending := new.status = 'pending' and old.status is distinct from 'pending';
  end if;
  if v_new_pending then
    update public.admin_representative_alert_delivery s set
      generation = s.generation + 1,
      attempts = case when s.lease_until > clock_timestamp() then s.attempts else 0 end,
      next_attempt_at = clock_timestamp(), last_queue_changed_at = clock_timestamp()
      where s.singleton;
  else
    -- Reviews/deletions do not generate extra Telegram traffic. Claim/context/
    -- finish always read the live pending queue and stop reminders at zero.
    update public.admin_representative_alert_delivery s
      set last_queue_changed_at = clock_timestamp() where s.singleton;
  end if;
  return null;
end $$;
revoke all on function public.xelay_private_queue_representative_alert()
  from public, anon, authenticated, service_role;
drop trigger if exists xelay_queue_representative_alert on public.class_representative_requests;
create trigger xelay_queue_representative_alert
  after insert or update of status or delete on public.class_representative_requests
  for each row execute function public.xelay_private_queue_representative_alert();

-- Include existing unreviewed requests on initial installation. Re-running the
-- migration does not reset sent generations, active leases or retry deadlines.
update public.admin_representative_alert_delivery s set
  generation = 1, next_attempt_at = clock_timestamp()
  where s.singleton and s.generation = 0
    and exists (select 1 from public.class_representative_requests r where r.status = 'pending');

create or replace function public.xelay_claim_admin_representative_alert()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.admin_representative_alert_delivery%rowtype;
  v_summary jsonb;
  v_now timestamptz := clock_timestamp();
  v_token uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'ADMIN_ALERT_SERVICE_REQUIRED' using errcode = '42501';
  end if;
  select s.* into v_state from public.admin_representative_alert_delivery s
    where s.singleton for update skip locked;
  if not found or v_state.lease_until > v_now then return null; end if;

  v_summary := public.xelay_private_representative_pending_summary();
  if (v_summary ->> 'pending_count')::bigint = 0 then
    update public.admin_representative_alert_delivery s set
      sent_generation = s.generation, attempts = 0, next_attempt_at = v_now + interval '1 hour',
      lease_token = null, lease_until = null, claimed_generation = null
      where s.singleton;
    return null;
  end if;
  -- New submissions may accelerate an ordinary retry, but cannot bypass a
  -- provider-imposed Telegram Retry-After window.
  if v_state.next_attempt_at > v_now or v_state.provider_retry_until > v_now then return null; end if;
  v_token := gen_random_uuid();
  update public.admin_representative_alert_delivery s set
    lease_token = v_token, lease_until = v_now + interval '2 minutes',
    claimed_generation = s.generation, attempts = least(s.attempts + 1, 30)
    where s.singleton returning s.* into v_state;
  return (v_summary - 'latest_request_id') || jsonb_build_object(
    'lease_token', v_token, 'generation', v_state.claimed_generation, 'attempts', v_state.attempts
  );
end $$;

create or replace function public.xelay_admin_representative_alert_delivery_context(p_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_state public.admin_representative_alert_delivery%rowtype;
  v_summary jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'ADMIN_ALERT_SERVICE_REQUIRED' using errcode = '42501';
  end if;
  select s.* into v_state from public.admin_representative_alert_delivery s
    where s.singleton and s.lease_token = p_token and s.lease_until > clock_timestamp() for update;
  if not found or v_state.lease_until <= clock_timestamp() then return null; end if;
  v_summary := public.xelay_private_representative_pending_summary();
  if (v_summary ->> 'pending_count')::bigint = 0 then return null; end if;
  -- This is the live snapshot used immediately before the external send. New
  -- requests already included in it are acknowledged together; later arrivals
  -- retain a higher dirty generation and remain due after finish.
  update public.admin_representative_alert_delivery s set claimed_generation = s.generation
    where s.singleton returning s.* into v_state;
  return (v_summary - 'latest_request_id') || jsonb_build_object(
    'lease_token', p_token, 'generation', v_state.claimed_generation, 'attempts', v_state.attempts
  );
end $$;

create or replace function public.xelay_finish_admin_representative_alert(
  p_token uuid,
  p_status text,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_state public.admin_representative_alert_delivery%rowtype;
  v_now timestamptz := clock_timestamp();
  v_pending boolean;
  v_error text;
  v_retry integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'ADMIN_ALERT_SERVICE_REQUIRED' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Invalid administrator alert delivery status';
  end if;
  select s.* into v_state from public.admin_representative_alert_delivery s
    where s.singleton and s.lease_token = p_token and s.lease_until > v_now for update;
  if not found then return false; end if;
  v_now := clock_timestamp();
  if v_state.lease_until <= v_now then return false; end if;
  select exists (select 1 from public.class_representative_requests r where r.status = 'pending') into v_pending;

  if p_status = 'sent' then
    update public.admin_representative_alert_delivery s set
      sent_generation = greatest(s.sent_generation, v_state.claimed_generation),
      last_sent_at = v_now, last_error_code = null, attempts = 0, provider_retry_until = null,
      next_attempt_at = case when v_pending and s.generation > v_state.claimed_generation
        then v_now else v_now + interval '1 hour' end,
      lease_token = null, lease_until = null, claimed_generation = null
      where s.singleton;
  elsif not v_pending then
    update public.admin_representative_alert_delivery s set
      sent_generation = s.generation, attempts = 0, next_attempt_at = v_now + interval '1 hour',
      lease_token = null, lease_until = null, claimed_generation = null
      where s.singleton;
  else
    -- A skip with a live queue cannot discard it. An unknown error is reduced to
    -- a safe code, never storing a provider response, a bot token or applicant PII.
    v_error := case when p_error_code in (
      'telegram_rate_limited', 'telegram_unavailable', 'telegram_configuration',
      'telegram_chat_not_private', 'malformed_queue', 'delivery_deadline',
      'delivery_temporarily_unavailable', 'delivery_receipt_unavailable'
    ) then p_error_code else 'delivery_temporarily_unavailable' end;
    v_retry := greatest(60, least(1800, 60 * (2 ^ least(greatest(v_state.attempts - 1, 0), 5))::integer));
    update public.admin_representative_alert_delivery s set
      last_error_code = v_error,
      provider_retry_until = case when p_retry_after_seconds is not null
        then v_now + make_interval(secs => greatest(1, least(86400, p_retry_after_seconds)))
        else s.provider_retry_until end,
      next_attempt_at = v_now + make_interval(secs => v_retry),
      lease_token = null, lease_until = null, claimed_generation = null
      where s.singleton;
  end if;
  return true;
end $$;

revoke all on function public.xelay_admin_representative_alert_summary(),
  public.xelay_claim_admin_representative_alert(),
  public.xelay_admin_representative_alert_delivery_context(uuid),
  public.xelay_finish_admin_representative_alert(uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_admin_representative_alert_summary() to authenticated;
grant execute on function public.xelay_claim_admin_representative_alert(),
  public.xelay_admin_representative_alert_delivery_context(uuid),
  public.xelay_finish_admin_representative_alert(uuid, text, text, integer) to service_role;

comment on table public.admin_representative_alert_delivery is
  'Private singleton Telegram outbox for the live pending representative queue. New arrivals coalesce, failed sends retry without exhaustion, and sent backlog repeats hourly until reviewed. No request content or secrets. External delivery is at-least-once, not exactly-once.';
comment on function public.xelay_admin_representative_alert_summary() is
  'Aggregate pending request alert for current verified ADMIN at AAL2 only; role revocation takes effect on the next call. No applicant PII.';
comment on function public.xelay_admin_representative_alert_delivery_context(uuid) is
  'Service-only live pending count and age under a valid delivery lease, called immediately before Telegram. No applicant content or request ID.';

-- Do not publish the applicant table to supabase_realtime: Postgres Changes does
-- not apply RLS to DELETE events. The protected summary RPC is polled by admins
-- and refreshed on focus/review; no additional applicant event stream is exposed.
notify pgrst, 'reload schema';
commit;
