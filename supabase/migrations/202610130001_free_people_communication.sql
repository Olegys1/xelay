-- People search and new contact requests are free for every authenticated user.
-- Keep recipient consent, immutable request identities, pair serialization and
-- the same anti-spam safeguards for all accounts. Historic counters stay private.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_guard_participant_connection_limits()') is null
    or to_regprocedure('public.xelay_connection_request_status(uuid)') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_private_share_study_group(uuid,uuid)') is null
    or not exists(select 1 from pg_trigger where tgrelid='public.connection_requests'::regclass
      and tgname='xelay_guard_participant_connection_limits' and not tgisinternal) then
    raise exception 'Apply participant communication migrations through 202610070006 first';
  end if;
end $$;

-- Retain the callable signature for clients deployed before this migration.
-- Legacy quota fields remain inert so already open clients keep working.
-- unlimited/free_communication carry the actual policy for new clients.
create or replace function public.xelay_connection_request_status(p_recipient_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  return jsonb_build_object('limit',3,'used',0,'remaining',3,'unlimited',true,'free_communication',true,
    'recipient_exempt',public.xelay_private_share_study_group(auth.uid(),p_recipient_id),
    'resets_at',(date_trunc('week',now() at time zone 'Europe/Kyiv')::date+7)::timestamp at time zone 'Europe/Kyiv');
end $$;

create or replace function public.xelay_guard_participant_connection_limits()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' then
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
  -- Technical abuse protection is identical for subscribers and free accounts.
  if (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '10 minutes')>=10
    or (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '1 day')>=30
    or exists(select 1 from public.connection_requests where requester_id=new.requester_id
      and recipient_id=new.recipient_id and status='rejected' and updated_at>new.created_at-interval '1 day') then
    raise exception 'CONNECTION_REQUEST_RATE_LIMIT' using errcode='P0001';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_participant_connection_limits() from public,anon,authenticated,service_role;

-- Premium identity still follows paid access; free communication does not.
create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_premium boolean; v_expiry timestamptz; v_emoji text; v_text text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium:=public.xelay_has_participant_access(auth.uid());
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
  return jsonb_build_object('is_premium',v_premium,'expires_at',v_expiry,'emoji_status',v_emoji,'status_text',v_text,
    'search_used',0,'search_remaining',3,'search_limit',3,'search_unlimited',true,
    'connection_used',0,'connection_remaining',3,'connection_limit',3,
    'connection_unlimited',true,'free_communication',true,
    'connection_resets_at',(date_trunc('week',now() at time zone 'Europe/Kyiv')::date+7)::timestamp at time zone 'Europe/Kyiv');
end $$;

create or replace function public.xelay_search_users_live(p_query text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  v_user_id uuid:=auth.uid();
  v_query text;
  v_profiles jsonb;
  v_has_more boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_query:=lower(regexp_replace(btrim(p_query),'^@+',''));
  if v_query is null or char_length(v_query)<2 or char_length(v_query)>30
    or v_query !~ '^[[:alnum:]_.-]+$' then
    raise exception 'INVALID_SEARCH_QUERY' using errcode='22023';
  end if;
  -- Literal matching prevents _/% from widening a query. Only public card
  -- fields are returned, with at most 30 results and no private email/metadata.
  with matches as materialized (
    select p.id,p.username,p.full_name,p.avatar_url,p.faculty,p.specialty,p.study_year,
      case when lower(p.username)=v_query then 0
        when left(lower(p.username),char_length(v_query))=v_query then 1 else 2 end as match_rank
    from public.profiles p
    where p.id<>v_user_id and strpos(lower(p.username),v_query)>0
    order by match_rank,char_length(p.username),lower(p.username),p.id
    limit 31
  ), ranked as (
    select m.*,row_number() over(order by m.match_rank,char_length(m.username),lower(m.username),m.id) as result_position
    from matches m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,'username',p.username,'full_name',p.full_name,'avatar_url',p.avatar_url,
      'faculty',p.faculty,'specialty',p.specialty,'study_year',p.study_year,
      'is_premium',public.xelay_has_participant_access(p.id),
      'emoji_status',case when public.xelay_has_participant_access(p.id) then pref.emoji_status else null end,
      'status_text',case when public.xelay_has_participant_access(p.id) then pref.status_text else null end
    ) order by p.result_position),'[]'::jsonb),(select count(*)>30 from matches)
  into v_profiles,v_has_more
  from ranked p left join public.premium_preferences pref on pref.user_id=p.id
  where p.result_position<=30;
  return jsonb_build_object('profiles',v_profiles,'has_more',v_has_more,'used',0,
    'remaining',3,'limit',3,'unlimited',true,'free_communication',true,'limit_reached',false,'session_expires_at',null);
end $$;

-- Manual and live search use the same free authorization and matching rules.
create or replace function public.xelay_search_users(p_query text)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select public.xelay_search_users_live(p_query);
$$;

comment on table public.connection_request_weekly_usage is
  'Historic contact quota counters; no longer incremented or enforced after free communication migration 202610130001. Direct access remains denied.';
comment on table public.user_search_usage is
  'Historic people-search quota counters; no longer incremented or enforced after migration 202610130001. Direct access remains restricted.';

-- Public signatures keep their existing authenticated-only access. Contact
-- send/accept and private-chat authorization are left in their existing paths.
revoke all on function public.xelay_connection_request_status(uuid),public.xelay_billing_status(),
  public.xelay_search_users(text),public.xelay_search_users_live(text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_connection_request_status(uuid),public.xelay_billing_status(),
  public.xelay_search_users(text),public.xelay_search_users_live(text) to authenticated;
notify pgrst,'reload schema';
commit;
