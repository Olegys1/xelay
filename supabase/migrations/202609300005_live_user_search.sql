-- Live nickname suggestions share a metered, ten-minute search window for
-- the same first two characters. The existing explicit-search RPC stays valid.
-- Apply after 202609300001_participant_billing.sql.

begin;

create table if not exists public.user_search_sessions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null,
  query_prefix text not null check (char_length(query_prefix) = 2),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, usage_date, query_prefix),
  check (expires_at > created_at)
);

alter table public.user_search_sessions enable row level security;
revoke all on public.user_search_sessions from public, anon, authenticated;
grant all on public.user_search_sessions to service_role;

create or replace function public.xelay_search_users_live(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_day date := (now() at time zone 'Europe/Kyiv')::date;
  v_query text;
  v_prefix text;
  v_premium boolean;
  v_used integer;
  v_session_expires_at timestamptz;
  v_profiles jsonb;
  v_has_more boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_query := lower(regexp_replace(btrim(p_query), '^@+', ''));
  if v_query is null or char_length(v_query) < 2 or char_length(v_query) > 30
    or v_query !~ '^[[:alnum:]_.-]+$' then
    raise exception 'INVALID_SEARCH_QUERY' using errcode = '22023';
  end if;
  v_prefix := left(v_query, 2);

  -- Serialize session creation per account. The shared usage row also keeps
  -- its atomic increment so calls to the legacy RPC cannot overspend quota.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 202609300005)
  );

  -- Only this account's expired windows are removed, at most twenty per call.
  -- Active windows are never extended by typing or by a repeated request.
  delete from public.user_search_sessions s
  using (
    select usage_date, query_prefix
    from public.user_search_sessions
    where user_id = v_user_id and expires_at <= v_now
    order by expires_at, usage_date, query_prefix
    limit 20
  ) expired
  where s.user_id = v_user_id
    and s.usage_date = expired.usage_date
    and s.query_prefix = expired.query_prefix;

  -- Entitlements are checked for every request. Premium requests create no
  -- free search windows and do not consume the five ordinary daily searches.
  v_premium := public.xelay_has_participant_access(v_user_id);
  if not v_premium then
    select s.expires_at into v_session_expires_at
    from public.user_search_sessions s
    where s.user_id = v_user_id and s.usage_date = v_day
      and s.query_prefix = v_prefix and s.expires_at > v_now;

    if v_session_expires_at is null then
      insert into public.user_search_usage (user_id, usage_date, used)
      values (v_user_id, v_day, 1)
      on conflict (user_id, usage_date) do update
        set used = user_search_usage.used + 1
        where user_search_usage.used < 5
      returning used into v_used;

      if v_used is null then
        select used into v_used from public.user_search_usage
        where user_id = v_user_id and usage_date = v_day;
        return jsonb_build_object(
          'profiles', '[]'::jsonb, 'has_more', false,
          'used', coalesce(v_used, 5), 'remaining', 0, 'limit', 5,
          'unlimited', false, 'limit_reached', true,
          'session_expires_at', null
        );
      end if;

      v_session_expires_at := v_now + interval '10 minutes';
      insert into public.user_search_sessions (
        user_id, usage_date, query_prefix, created_at, expires_at
      ) values (v_user_id, v_day, v_prefix, v_now, v_session_expires_at)
      on conflict (user_id, usage_date, query_prefix) do update
        set created_at = excluded.created_at, expires_at = excluded.expires_at;
    end if;
  end if;

  select used into v_used from public.user_search_usage
  where user_id = v_user_id and usage_date = v_day;
  v_used := coalesce(v_used, 0);

  -- strpos and left compare literal characters, including an underscore.
  -- Exact handles lead, then handles starting with the query, then substring
  -- matches. Fetch one extra result to report truncation accurately.
  with matches as materialized (
    select p.id, p.username, p.full_name, p.avatar_url,
      p.faculty, p.specialty, p.study_year,
      case
        when lower(p.username) = v_query then 0
        when left(lower(p.username), char_length(v_query)) = v_query then 1
        else 2
      end as match_rank
    from public.profiles p
    where p.id <> v_user_id and strpos(lower(p.username), v_query) > 0
    order by match_rank, char_length(p.username), lower(p.username), p.id
    limit 31
  ), ranked as (
    select m.*, row_number() over (
      order by m.match_rank, char_length(m.username), lower(m.username), m.id
    ) as result_position
    from matches m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'username', p.username, 'full_name', p.full_name,
      'avatar_url', p.avatar_url, 'faculty', p.faculty,
      'specialty', p.specialty, 'study_year', p.study_year,
      'is_premium', public.xelay_has_participant_access(p.id),
      'emoji_status', case when public.xelay_has_participant_access(p.id)
        then pref.emoji_status else null end
    ) order by p.result_position), '[]'::jsonb),
    (select count(*) > 30 from matches)
  into v_profiles, v_has_more
  from ranked p
  left join public.premium_preferences pref on pref.user_id = p.id
  where p.result_position <= 30;

  return jsonb_build_object(
    'profiles', v_profiles, 'has_more', v_has_more,
    'used', v_used,
    'remaining', case when v_premium then null else greatest(5 - v_used, 0) end,
    'limit', 5, 'unlimited', v_premium, 'limit_reached', false,
    'session_expires_at', v_session_expires_at
  );
end;
$$;

revoke all on function public.xelay_search_users_live(text) from public, anon, authenticated;
grant execute on function public.xelay_search_users_live(text) to authenticated;

commit;
