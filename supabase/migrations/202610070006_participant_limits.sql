-- Participant expansion: 3 people searches/day, 3 new contact requests/week.
-- Accepted contacts and study-group classmates remain free. No historic quotas
-- are charged. Apply the complete file in a fresh SQL Editor tab.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare v_name text;
begin
  foreach v_name in array array['profiles','connection_requests','conversations',
    'study_groups','study_group_members','user_search_usage','user_search_sessions',
    'participant_entitlements','premium_preferences'] loop
    if to_regclass('public.' || v_name) is null then
      raise exception 'Apply existing connection, study-group, billing and live-search migrations first: missing %',v_name;
    end if;
  end loop;
  if to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_billing_status()') is null
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='premium_preferences' and column_name='status_text') then
    raise exception 'Apply existing participant billing and participant-status migrations first';
  end if;
end $$;

-- Private counter survives request rejection/removal. Only successful INSERTs
-- increment it, in the same transaction as the request and notification.
create table if not exists public.connection_request_weekly_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  used integer not null default 0 check(used >= 0),
  primary key(user_id,week_start),
  constraint connection_request_week_is_monday check(extract(isodow from week_start)=1)
);
alter table public.connection_request_weekly_usage enable row level security;
revoke all on public.connection_request_weekly_usage from public,anon,authenticated,service_role;
create index if not exists connection_requests_requester_created_idx
  on public.connection_requests(requester_id,created_at);
alter table public.connection_requests enable row level security;

create or replace function public.xelay_private_share_study_group(p_first uuid,p_second uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_first is not null and p_second is not null and p_first<>p_second
    and exists(with candidates as (
      select id from public.study_groups where representative_id=p_first
      union select group_id from public.study_group_members where user_id=p_first and status='accepted'
    ) select 1 from candidates c join public.study_groups g on g.id=c.id
      where g.representative_id=p_second or exists(select 1 from public.study_group_members m
        where m.group_id=g.id and m.user_id=p_second and m.status='accepted'));
$$;
revoke all on function public.xelay_private_share_study_group(uuid,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_connection_request_status(p_recipient_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  v_owner uuid:=auth.uid();
  v_week date:=date_trunc('week',now() at time zone 'Europe/Kyiv')::date;
  v_used integer;
  v_premium boolean;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium:=public.xelay_has_participant_access(v_owner);
  select used into v_used from public.connection_request_weekly_usage where user_id=v_owner and week_start=v_week;
  v_used:=coalesce(v_used,0);
  return jsonb_build_object('limit',3,'used',v_used,
    'remaining',case when v_premium then null else greatest(3-v_used,0) end,
    'unlimited',v_premium,'recipient_exempt',public.xelay_private_share_study_group(v_owner,p_recipient_id),
    'resets_at',(v_week+7)::timestamp at time zone 'Europe/Kyiv');
end $$;

create or replace function public.xelay_guard_participant_connection_limits()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_used integer; v_week date; v_premium boolean;
begin
  if tg_op='UPDATE' then
    -- Receiving/accepting a request never consumes quota. Identity and dates
    -- cannot be rewritten to move old requests out of the abuse windows.
    if new.id is distinct from old.id or new.requester_id is distinct from old.requester_id
      or new.recipient_id is distinct from old.recipient_id then
      raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
    end if;
    new.created_at:=old.created_at;
    if new.status is distinct from old.status then
      if auth.uid() is distinct from old.recipient_id or old.status<>'pending'
        or new.status not in('accepted','rejected') then
        raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
      end if;
      new.updated_at:=clock_timestamp();
    else new.updated_at:=old.updated_at;
    end if;
    return new;
  end if;
  if auth.uid() is null or new.requester_id is distinct from auth.uid()
    or new.recipient_id is null or new.recipient_id=new.requester_id or new.status<>'pending' then
    raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
  end if;
  -- Same lock order as the existing chat-security trigger. This also guards
  -- direct-table INSERTs, which cannot bypass the RPC weekly counter.
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:' || least(new.requester_id,new.recipient_id)::text
    || ':' || greatest(new.requester_id,new.recipient_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-send:' || new.requester_id::text,0));
  new.created_at:=clock_timestamp(); new.updated_at:=new.created_at;
  if exists(select 1 from public.connection_requests r
    where r.status in('pending','accepted')
      and least(r.requester_id,r.recipient_id)=least(new.requester_id,new.recipient_id)
      and greatest(r.requester_id,r.recipient_id)=greatest(new.requester_id,new.recipient_id)) then
    raise unique_violation using constraint='connection_requests_active_pair_unique';
  end if;
  if (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '10 minutes')>=10
    or (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '1 day')>=30
    or exists(select 1 from public.connection_requests where requester_id=new.requester_id
      and recipient_id=new.recipient_id and status='rejected' and updated_at>new.created_at-interval '1 day') then
    raise exception 'CONNECTION_REQUEST_RATE_LIMIT' using errcode='P0001';
  end if;
  if not public.xelay_private_share_study_group(new.requester_id,new.recipient_id) then
    v_week:=date_trunc('week',new.created_at at time zone 'Europe/Kyiv')::date;
    v_premium:=public.xelay_has_participant_access(new.requester_id);
    insert into public.connection_request_weekly_usage(user_id,week_start,used)
    values(new.requester_id,v_week,1)
    on conflict(user_id,week_start) do update set used=connection_request_weekly_usage.used+1
      where v_premium or connection_request_weekly_usage.used<3 returning used into v_used;
    if v_used is null then raise exception 'CONNECTION_REQUEST_WEEKLY_LIMIT' using errcode='P0001'; end if;
  end if;
  return new;
end $$;
drop trigger if exists xelay_guard_participant_connection_limits on public.connection_requests;
create trigger xelay_guard_participant_connection_limits before insert or update on public.connection_requests
  for each row execute function public.xelay_guard_participant_connection_limits();
revoke all on function public.xelay_guard_participant_connection_limits() from public,anon,authenticated,service_role;

create or replace function public.send_connection_request(p_recipient_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=auth.uid(); v_request_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_recipient_id is null or p_recipient_id=v_owner then
    raise exception 'CONNECTION_REQUEST_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:' || least(v_owner,p_recipient_id)::text
    || ':' || greatest(v_owner,p_recipient_id)::text,0));
  select id into v_request_id from public.connection_requests
  where status in('pending','accepted') and least(requester_id,recipient_id)=least(v_owner,p_recipient_id)
    and greatest(requester_id,recipient_id)=greatest(v_owner,p_recipient_id)
  order by created_at desc limit 1;
  if v_request_id is not null then return v_request_id; end if;
  -- A client retry of an existing connection returns before any counters.
  -- FK, trigger, notification or INSERT errors roll back the counter too.
  insert into public.connection_requests(requester_id,recipient_id)
    values(v_owner,p_recipient_id) returning id into v_request_id;
  return v_request_id;
exception when unique_violation then
  select id into v_request_id from public.connection_requests
  where status in('pending','accepted') and least(requester_id,recipient_id)=least(v_owner,p_recipient_id)
    and greatest(requester_id,recipient_id)=greatest(v_owner,p_recipient_id)
  order by created_at desc limit 1;
  if v_request_id is null then raise; end if;
  return v_request_id;
end $$;

comment on table public.connection_request_weekly_usage is
  'Successful non-classmate contact requests per Kyiv Monday week. Replays/errors do not charge. Premium bypasses weekly limit but remains subject to abuse limits; accepted chats and received requests remain free.';

-- Existing billing-status fields are retained, including gap-safe coverage.
create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_premium boolean; v_used integer; v_expiry timestamptz; v_emoji text; v_text text; v_contacts jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium:=public.xelay_has_participant_access(auth.uid());
  select used into v_used from public.user_search_usage where user_id=auth.uid()
    and usage_date=(now() at time zone 'Europe/Kyiv')::date;
  v_used:=coalesce(v_used,0);
  if v_premium then
    with recursive coverage(until_at) as (
      select max(valid_until) from public.participant_entitlements where user_id=auth.uid()
        and revoked_at is null and valid_from<=now() and valid_until>now()
      union
      select e.valid_until from coverage c join public.participant_entitlements e
        on e.user_id=auth.uid() and e.revoked_at is null
          and e.valid_from<=c.until_at and e.valid_until>c.until_at
    ) select max(until_at) into v_expiry from coverage;
    select emoji_status,status_text into v_emoji,v_text from public.premium_preferences where user_id=auth.uid();
  end if;
  v_contacts:=public.xelay_connection_request_status(null);
  return jsonb_build_object('is_premium',v_premium,'expires_at',v_expiry,'emoji_status',v_emoji,'status_text',v_text,
    'search_used',v_used,'search_remaining',case when v_premium then null else greatest(3-v_used,0) end,
    'search_limit',3,'search_unlimited',v_premium,
    'connection_used',v_contacts->'used','connection_remaining',v_contacts->'remaining',
    'connection_limit',3,'connection_unlimited',v_premium,'connection_resets_at',v_contacts->'resets_at');
end $$;

-- Search definitions below preserve the existing ten-minute live refinement
-- window; reducing the counter never turns every keystroke into a new search.
create or replace function public.xelay_search_users(p_query text)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_query text; v_pattern text; v_premium boolean; v_used integer; v_profiles jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_query := lower(regexp_replace(btrim(p_query),'^@+',''));
  if v_query is null or length(v_query)<2 or length(v_query)>30 or v_query !~ '^[[:alnum:]_.-]+$' then raise exception 'INVALID_SEARCH_QUERY'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,202609300005));
  if v_premium then
    select used into v_used from public.user_search_usage where user_id=auth.uid()
      and usage_date=(now() at time zone 'Europe/Kyiv')::date;
    v_used:=coalesce(v_used,0);
  else
    insert into public.user_search_usage(user_id,usage_date,used) values(auth.uid(),(now() at time zone 'Europe/Kyiv')::date,1)
      on conflict(user_id,usage_date) do update set used=user_search_usage.used+1
      where user_search_usage.used<3 returning used into v_used;
    if v_used is null then
      select used into v_used from public.user_search_usage where user_id=auth.uid()
        and usage_date=(now() at time zone 'Europe/Kyiv')::date;
      return jsonb_build_object('profiles','[]'::jsonb,'used',coalesce(v_used,3),'remaining',0,'limit',3,'unlimited',false,'limit_reached',true);
    end if;
  end if;
  v_pattern := '%' || replace(replace(replace(v_query,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%';
  select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) into v_profiles from (
    select profiles.id,username,full_name,avatar_url,faculty,specialty,study_year,
      public.xelay_has_participant_access(profiles.id) as is_premium,
      case when public.xelay_has_participant_access(profiles.id) then pref.emoji_status else null end as emoji_status,
      case when public.xelay_has_participant_access(profiles.id) then pref.status_text else null end as status_text
    from public.profiles
    left join public.premium_preferences pref on pref.user_id=profiles.id
    where profiles.id<>auth.uid() and username ilike v_pattern escape E'\\' order by username limit 30
  ) p;
  return jsonb_build_object('profiles',v_profiles,'used',v_used,'remaining',case when v_premium then null else greatest(3-v_used,0) end,'limit',3,'unlimited',v_premium);
end;
$$;

-- Preserve the ten-minute search window and its atomic usage counter.
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
  -- free search windows and do not consume the three ordinary daily searches.
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
        where user_search_usage.used < 3
      returning used into v_used;

      if v_used is null then
        select used into v_used from public.user_search_usage
        where user_id = v_user_id and usage_date = v_day;
        return jsonb_build_object(
          'profiles', '[]'::jsonb, 'has_more', false,
          'used', coalesce(v_used, 3), 'remaining', 0, 'limit', 3,
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
        then pref.emoji_status else null end,
      'status_text', case when public.xelay_has_participant_access(p.id)
        then pref.status_text else null end
    ) order by p.result_position), '[]'::jsonb),
    (select count(*) > 30 from matches)
  into v_profiles, v_has_more
  from ranked p
  left join public.premium_preferences pref on pref.user_id = p.id
  where p.result_position <= 30;

  return jsonb_build_object(
    'profiles', v_profiles, 'has_more', v_has_more,
    'used', v_used,
    'remaining', case when v_premium then null else greatest(3 - v_used, 0) end,
    'limit', 3, 'unlimited', v_premium, 'limit_reached', false,
    'session_expires_at', v_session_expires_at
  );
end;
$$;


revoke all on function public.xelay_connection_request_status(uuid),public.send_connection_request(uuid),
  public.xelay_billing_status(),public.xelay_search_users(text),public.xelay_search_users_live(text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_connection_request_status(uuid),public.send_connection_request(uuid),
  public.xelay_billing_status(),public.xelay_search_users(text),public.xelay_search_users_live(text) to authenticated;
notify pgrst, 'reload schema';
commit;
