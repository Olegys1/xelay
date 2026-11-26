-- Personal, cosmetic-only Advent collection. No payments, subscriptions or AI grants.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.winter_advent_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  campaign_id text not null check (campaign_id = 'winter-2026'),
  day smallint not null check (day between 1 and 31),
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (user_id, campaign_id, day)
);
create table public.winter_advent_claim_rate (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  hits integer not null check (hits between 1 and 60)
);
alter table public.winter_advent_claims enable row level security;
alter table public.winter_advent_claim_rate enable row level security;
-- Deliberately no browser policies or table grants. RPC is the only access path.
revoke all on public.winter_advent_claims, public.winter_advent_claim_rate
  from public, anon, authenticated, service_role;

create function public.xelay_private_winter_clock()
returns timestamptz language sql volatile set search_path = '' as $$
  select clock_timestamp();
$$;
revoke all on function public.xelay_private_winter_clock()
  from public, anon, authenticated, service_role;

create function public.xelay_winter_advent(
  p_user_id uuid, p_session_id uuid, p_claim_day integer default null
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now timestamptz;
  v_today date;
  v_phase text;
  v_day integer;
  v_claimed jsonb;
  v_new boolean := false;
  v_hits integer;
  v_started timestamptz;
  v_result jsonb;
begin
  -- Only a service credential may invoke this function; the HTTP server supplies
  -- IDs from a getUser-verified token, never from request body/query values.
  if coalesce(current_setting('request.jwt.claims', true), '') = ''
    or coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role'
    or p_user_id is null or p_session_id is null then
    raise exception 'WINTER_ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_claim_day is not null and p_claim_day not between 1 and 31 then
    raise exception 'WINTER_DAY_INVALID' using errcode = '22023';
  end if;
  if p_claim_day is not null then
    -- Serialize retries and distinct-day catch-up for the same account only.
    perform pg_advisory_xact_lock(hashtextextended('xelay-winter-2026:' || p_user_id::text, 0));
  end if;
  v_now := public.xelay_private_winter_clock();
  v_today := (v_now at time zone 'Europe/Kyiv')::date;
  v_phase := case when v_today < date '2026-12-01' then 'upcoming'
    when v_today >= date '2027-01-01' then 'ended' else 'active' end;
  v_day := greatest(0, least(31, v_today - date '2026-12-01' + 1));
  v_result := jsonb_build_object('serverNow', v_now, 'phase', v_phase, 'currentDay', v_day);
  if not exists (
    select 1 from auth.users u
    join auth.sessions s on s.user_id = u.id and s.id = p_session_id
    join public.profiles p on p.id = u.id
    where u.id = p_user_id and u.email_confirmed_at is not null
      and u.deleted_at is null and coalesce(u.is_anonymous, false) = false
      and (u.banned_until is null or u.banned_until <= v_now)
      and (s.not_after is null or s.not_after > v_now)
  ) then
    if p_claim_day is not null then
      raise exception 'WINTER_ACCOUNT_REQUIRED' using errcode = '42501';
    end if;
    return v_result || jsonb_build_object('eligible', false,
      'ineligibleReason', 'account_unavailable', 'claimedDays', '[]'::jsonb);
  end if;
  if p_claim_day is not null then
    if v_phase <> 'active' or p_claim_day > v_day then
      raise exception 'WINTER_DAY_UNAVAILABLE' using errcode = 'PT409';
    end if;
    select r.window_started_at, r.hits into v_started, v_hits
      from public.winter_advent_claim_rate r where r.user_id = p_user_id;
    if v_started is not null and v_started > v_now - interval '1 minute' and v_hits >= 60 then
      raise exception 'WINTER_RATE_LIMIT' using errcode = 'PT429';
    end if;
    insert into public.winter_advent_claim_rate(user_id, window_started_at, hits)
      values (p_user_id, v_now, 1)
      on conflict (user_id) do update
        set window_started_at = case when v_started <= v_now - interval '1 minute' then v_now else v_started end,
            hits = case when v_started <= v_now - interval '1 minute' then 1 else v_hits + 1 end;
    insert into public.winter_advent_claims(user_id, campaign_id, day, claimed_at)
      values (p_user_id, 'winter-2026', p_claim_day, v_now)
      on conflict (user_id, campaign_id, day) do nothing;
    v_new := found;
  end if;
  select coalesce(jsonb_agg(c.day order by c.day), '[]'::jsonb) into v_claimed
    from public.winter_advent_claims c
    where c.user_id = p_user_id and c.campaign_id = 'winter-2026';
  v_result := v_result || jsonb_build_object('eligible', true,
    'ineligibleReason', null, 'claimedDays', v_claimed);
  if p_claim_day is not null then
    v_result := v_result || jsonb_build_object('newlyClaimed', v_new);
  end if;
  return v_result;
end;
$$;
revoke all on function public.xelay_winter_advent(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_winter_advent(uuid, uuid, integer) to service_role;
comment on table public.winter_advent_claims is
  'Private cosmetic-only winter collection. Never an entitlement, credit, or billing source.';
commit;
