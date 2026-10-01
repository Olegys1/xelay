-- Short text and up to three emoji statuses for the Participant subscription.
-- Apply after the participant billing and live user search migrations.
-- A displayed status is available only while the account has active access.

begin;

alter table public.premium_preferences add column if not exists status_text text;
alter table public.premium_preferences drop constraint if exists premium_preferences_status_text_check;
alter table public.premium_preferences add constraint premium_preferences_status_text_check
  check (status_text is null or (
    char_length(status_text) between 1 and 48
    and status_text = btrim(status_text)
    and status_text !~ '[[:cntrl:]]'
    and status_text !~ U&'[\0080-\009F\2028\2029\202A-\202E\2066-\2069]'
  ));
alter table public.premium_preferences drop constraint if exists premium_preferences_emoji_status_length_check;
alter table public.premium_preferences add constraint premium_preferences_emoji_status_length_check
  check (emoji_status is null or char_length(emoji_status) between 1 and 100);

create or replace function public.xelay_set_participant_status(p_text text, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_text text := nullif(btrim(p_text, U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  v_emoji text := nullif(btrim(p_emoji), '');
  v_tokens text[];
  -- Keep aligned with src/lib/participantStatus.ts. Existing single emojis stay valid.
  v_allowed text[] := array['😊','😄','😎','🥰','😍','🤩','🥹','😌','🤔','😴','😅','😂','🥳','🙃','😇','🤗','🫠','🤓','💤','❤️','🎓','📚','📖','📝','✏️','📌','📎','🗓️','⏰','💻','🧠','💡','🎯','🧪','🔬','📐','🧮','🏛️','💼','🏆','🎨','🎭','🎬','🎵','🎧','🎤','🎸','📷','🎮','🎲','⚽','🏀','🏐','🎾','🏋️','🚴','🏃','🧘','🏊','📸','🌱','🌿','🌻','🌸','🍀','🌳','🌍','🌊','⛰️','🏕️','✈️','🚀','🚂','🚗','🌙','☀️','🌈','⭐','✨','❄️','☕','🍵','🍕','🍫','🍒','🍉','🥐','🔥','⚡','💪','🙌','👏','🤝','🫶','💜','💙','💛','🤍','🖤','💬'];
begin
  if v_user_id is null then
    raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xelay:participant-status:' || v_user_id::text, 0)
  );
  if not public.xelay_has_participant_access(v_user_id) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  if v_text is not null and (
    char_length(v_text) > 48
    or v_text ~ '[[:cntrl:]]'
    or v_text ~ U&'[\0080-\009F\2028\2029\202A-\202E\2066-\2069]'
  ) then
    raise exception 'INVALID_PARTICIPANT_STATUS_TEXT' using errcode = '22023';
  end if;

  if v_emoji is not null then
    v_tokens := string_to_array(v_emoji, ' ');
    if cardinality(v_tokens) < 1 or cardinality(v_tokens) > 3
      or char_length(v_emoji) > 100
      or exists (select 1 from unnest(v_tokens) as t(emoji) where not (t.emoji = any(v_allowed)))
      or (select count(distinct t.emoji) from unnest(v_tokens) as t(emoji)) <> cardinality(v_tokens) then
      raise exception 'INVALID_PARTICIPANT_STATUS_EMOJI' using errcode = '22023';
    end if;
  end if;

  -- Save text and emojis together so a partial edit cannot mix separate drafts.
  insert into public.premium_preferences (user_id, status_text, emoji_status)
  values (v_user_id, v_text, v_emoji)
  on conflict (user_id) do update
    set status_text = excluded.status_text,
        emoji_status = excluded.emoji_status,
        updated_at = now();
end;
$$;

-- Preserve clients using the old emoji-only API without removing their text.
create or replace function public.xelay_set_emoji_status(p_emoji text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_text text;
begin
  if v_user_id is null then
    raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xelay:participant-status:' || v_user_id::text, 0)
  );
  select status_text into v_text from public.premium_preferences where user_id = v_user_id;
  perform public.xelay_set_participant_status(v_text, p_emoji);
end;
$$;

create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
declare v_premium boolean; v_used integer; v_expiry timestamptz; v_emoji text; v_text text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  select coalesce(used,0) into v_used from public.user_search_usage where user_id=auth.uid() and usage_date=(now() at time zone 'Europe/Kyiv')::date;
  v_used := coalesce(v_used,0);
  if v_premium then
    -- Report only uninterrupted coverage, even if a manual database change
    -- has left a future gap. A distant future grant is not active access.
    with recursive coverage(until_at) as (
      select max(valid_until) from public.participant_entitlements
      where user_id=auth.uid() and revoked_at is null and valid_from<=now() and valid_until>now()
      union
      select e.valid_until from coverage c join public.participant_entitlements e
        on e.user_id=auth.uid() and e.revoked_at is null
          and e.valid_from<=c.until_at and e.valid_until>c.until_at
    ) select max(until_at) into v_expiry from coverage;
    select emoji_status, status_text into v_emoji, v_text from public.premium_preferences where user_id=auth.uid();
  end if;
  return jsonb_build_object('is_premium',v_premium,'expires_at',v_expiry,'emoji_status',v_emoji,'status_text',v_text,
    'search_used',v_used,'search_remaining',case when v_premium then null else greatest(5-v_used,0) end,
    'search_limit',5,'search_unlimited',v_premium);
end;
$$;

create or replace function public.xelay_public_premium(p_user_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp
as $$
begin
  if coalesce(cardinality(p_user_ids),0)>100 then raise exception 'Maximum 100 profile IDs'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('user_id',p.id,
    'is_premium',public.xelay_has_participant_access(p.id),
    'emoji_status',case when public.xelay_has_participant_access(p.id) then pref.emoji_status else null end,
    'status_text',case when public.xelay_has_participant_access(p.id) then pref.status_text else null end)),'[]'::jsonb)
    from public.profiles p left join public.premium_preferences pref on pref.user_id=p.id
    where p.id=any(coalesce(p_user_ids,'{}'::uuid[])));
end;
$$;

-- The quota logic below is unchanged; results gain the same public status fields.
create or replace function public.xelay_search_users(p_query text)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_query text; v_pattern text; v_premium boolean; v_used integer; v_profiles jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_query := lower(regexp_replace(btrim(p_query),'^@+',''));
  if v_query is null or length(v_query)<2 or length(v_query)>30 or v_query !~ '^[[:alnum:]_.-]+$' then raise exception 'INVALID_SEARCH_QUERY'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  insert into public.user_search_usage(user_id,usage_date,used) values(auth.uid(),(now() at time zone 'Europe/Kyiv')::date,1)
    on conflict(user_id,usage_date) do update set used=user_search_usage.used+1
    where v_premium or user_search_usage.used<5 returning used into v_used;
  if v_used is null then
    return jsonb_build_object('profiles','[]'::jsonb,'used',5,'remaining',0,'limit',5,'unlimited',false,'limit_reached',true);
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
  return jsonb_build_object('profiles',v_profiles,'used',v_used,'remaining',case when v_premium then null else greatest(5-v_used,0) end,'limit',5,'unlimited',v_premium);
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
    'remaining', case when v_premium then null else greatest(5 - v_used, 0) end,
    'limit', 5, 'unlimited', v_premium, 'limit_reached', false,
    'session_expires_at', v_session_expires_at
  );
end;
$$;

-- Status writes stay available only through the guarded authenticated RPC.
-- Existing preferences RLS and direct-table grants are unchanged.
revoke all on function public.xelay_set_participant_status(text, text),
  public.xelay_set_emoji_status(text), public.xelay_billing_status(),
  public.xelay_public_premium(uuid[]), public.xelay_search_users(text),
  public.xelay_search_users_live(text) from public, anon, authenticated;
grant execute on function public.xelay_set_participant_status(text, text),
  public.xelay_set_emoji_status(text), public.xelay_billing_status(),
  public.xelay_search_users(text), public.xelay_search_users_live(text) to authenticated;
grant execute on function public.xelay_public_premium(uuid[]) to anon, authenticated;

commit;

