-- Partner catalogue and aggregate, non-billing-grade click statistics.
-- This migration deliberately publishes no partners and changes no existing data.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.xelay_private_partner_https(p_value text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare authority text; host text;
begin
  if p_value is null or length(p_value) not between 10 and 2048
    or p_value ~ '[[:space:][:cntrl:]\\]' or p_value ~* '%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)'
    or p_value !~ '^https://' or p_value ~ '%(?![0-9a-fA-F]{2})' then return false; end if;
  authority := substring(p_value from '^https://([^/?#]+)');
  if authority is null or authority ~ '@' or authority ~ '[\[\]]' then return false; end if;
  host := lower(regexp_replace(authority, ':443$', ''));
  if host ~ ':' or length(host)>253 or host ~ '\.$'
    or host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$'
    or host ~ '(^|\.)(localhost|local|localdomain|lan|home|corp|intranet|internal|invalid|onion|test)$' or host ~ '(^|\.)home\.arpa$' then return false; end if;
  return true;
end;
$$;
revoke all on function public.xelay_private_partner_https(text) from public,anon,authenticated,service_role;

create function public.xelay_private_partner_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.xelay_is_platform_admin()
    and coalesce(auth.jwt()->>'aal','')='aal2'
    and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
    and exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=clock_timestamp());
$$;
revoke all on function public.xelay_private_partner_is_admin() from public,anon,authenticated,service_role;
-- Storage policies need this capability check. It exposes no other actor's state.
grant execute on function public.xelay_private_partner_is_admin() to anon,authenticated;

create table public.partner_tools(
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(btrim(name)) between 2 and 80),
  description text not null check(length(btrim(description)) between 1 and 240),
  category text not null default 'other' check(category in('study','productivity','career','other')),
  logo_url text check(logo_url is null or public.xelay_private_partner_https(logo_url)),
  destination_url text not null check(public.xelay_private_partner_https(destination_url)),
  status text not null default 'draft' check(status in('draft','published','hidden')),
  featured boolean not null default false,
  sort_order integer not null default 0 check(sort_order between 0 and 9999),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index partner_tools_public_order on public.partner_tools(sort_order,name,id) where status='published';
alter table public.partner_tools enable row level security;
revoke all on public.partner_tools from public,anon,authenticated,service_role;

create table public.partner_tool_click_daily(
  date date not null,
  tool_id uuid not null references public.partner_tools(id) on delete restrict,
  source text not null check(source in('catalog','home')),
  clicks bigint not null default 0 check(clicks>=0),
  primary key(date,tool_id,source)
);
create table public.partner_tool_click_dedupe(
  tool_id uuid not null references public.partner_tools(id) on delete cascade,
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  last_counted_at timestamptz not null,
  primary key(tool_id,fingerprint)
);
create table public.partner_tool_click_rate(
  fingerprint text primary key check(fingerprint ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  hits integer not null check(hits between 1 and 601)
);
create index partner_tool_click_dedupe_expiry on public.partner_tool_click_dedupe(last_counted_at);
create index partner_tool_click_rate_expiry on public.partner_tool_click_rate(window_started_at);
alter table public.partner_tool_click_daily enable row level security;
alter table public.partner_tool_click_dedupe enable row level security;
alter table public.partner_tool_click_rate enable row level security;
revoke all on public.partner_tool_click_daily,public.partner_tool_click_dedupe,public.partner_tool_click_rate from public,anon,authenticated,service_role;

create function public.xelay_partner_tools()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
    'id',t.id,'name',t.name,'description',t.description,'category',t.category,
    'logo_url',t.logo_url,'destination_url',t.destination_url,'status',t.status,
    'featured',t.featured,'sort_order',t.sort_order,'updated_at',t.updated_at
  ) order by t.sort_order,t.name,t.id),'[]'::jsonb)) from
    (select * from public.partner_tools where status='published' order by sort_order,name,id limit 500) t;
$$;
revoke all on function public.xelay_partner_tools() from public,anon,authenticated,service_role;
grant execute on function public.xelay_partner_tools() to anon,authenticated;

create function public.xelay_admin_partner_tools(p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare date_from date:=coalesce(p_from,(now() at time zone 'Europe/Kyiv')::date-29);
  date_to date:=coalesce(p_to,(now() at time zone 'Europe/Kyiv')::date);
begin
  if not public.xelay_private_partner_is_admin() then raise exception 'PARTNER_ADMIN_MFA_REQUIRED' using errcode='42501'; end if;
  if date_from>date_to or date_to-date_from>365 or date_from<'2020-01-01'::date or date_to>'2200-01-01'::date then
    raise exception 'PARTNER_DATE_RANGE_INVALID' using errcode='22023'; end if;
  return jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(s)-'created_at' order by s.sort_order,s.name,s.id),'[]'::jsonb)
    from(select t.*,coalesce((select sum(d.clicks) from public.partner_tool_click_daily d
      where d.tool_id=t.id and d.date between date_from and date_to),0)::bigint clicks from public.partner_tools t) s),
    'daily',(select coalesce(jsonb_agg(to_jsonb(d) order by d.date,d.tool_id,d.source),'[]'::jsonb)
      from public.partner_tool_click_daily d where d.date between date_from and date_to));
end;
$$;
revoke all on function public.xelay_admin_partner_tools(date,date) from public,anon,authenticated,service_role;
grant execute on function public.xelay_admin_partner_tools(date,date) to authenticated;

create function public.xelay_admin_save_partner_tool(p_payload jsonb,p_expected_actor_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare saved public.partner_tools; tool_id uuid; old_updated_at timestamptz;
  tool_name text; tool_description text; tool_category text; tool_logo text; tool_destination text; tool_status text;
  tool_featured boolean; tool_order integer;
begin
  if not public.xelay_private_partner_is_admin() or p_expected_actor_id is distinct from auth.uid() then
    raise exception 'PARTNER_ADMIN_MFA_REQUIRED' using errcode='42501'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>8192
    or exists(select 1 from jsonb_object_keys(p_payload) k where k not in('id','name','description','category','logo_url','destination_url','status','featured','sort_order','updated_at'))
    or exists(select 1 from unnest(array['name','description','category','destination_url','status']) k where jsonb_typeof(p_payload->k) is distinct from 'string')
    or p_payload ? 'logo_url' and jsonb_typeof(p_payload->'logo_url') not in('string','null')
    or p_payload ? 'featured' and jsonb_typeof(p_payload->'featured') is distinct from 'boolean'
    or p_payload ? 'sort_order' and (jsonb_typeof(p_payload->'sort_order') is distinct from 'number' or p_payload->>'sort_order' !~ '^\d{1,6}$') then
    raise exception 'PARTNER_INPUT_INVALID' using errcode='22023'; end if;
  tool_name:=btrim(p_payload->>'name'); tool_description:=btrim(p_payload->>'description');
  tool_category:=p_payload->>'category'; tool_logo:=nullif(btrim(p_payload->>'logo_url'),'');
  tool_destination:=btrim(p_payload->>'destination_url'); tool_status:=p_payload->>'status';
  tool_featured:=coalesce((p_payload->>'featured')::boolean,false); tool_order:=coalesce((p_payload->>'sort_order')::integer,0);
  if length(tool_name) not between 2 and 80 or length(tool_description) not between 1 and 240
    or tool_name ~ '[[:cntrl:]]' or tool_description ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    or tool_category not in('study','productivity','career','other') or tool_status not in('draft','published','hidden')
    or tool_order not between 0 and 9999 or not public.xelay_private_partner_https(tool_destination)
    or tool_logo is not null and not public.xelay_private_partner_https(tool_logo) then
    raise exception 'PARTNER_INPUT_INVALID' using errcode='22023'; end if;
  if p_payload ? 'id' and p_payload->>'id' is not null then
    if p_payload->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(p_payload->'updated_at') is distinct from 'string' then raise exception 'PARTNER_INPUT_INVALID' using errcode='22023'; end if;
    tool_id:=(p_payload->>'id')::uuid;
    select updated_at into old_updated_at from public.partner_tools where id=tool_id for update;
    if not found then raise exception 'PARTNER_NOT_FOUND' using errcode='22023'; end if;
    begin
      if (p_payload->>'updated_at')::timestamptz is distinct from old_updated_at then raise exception 'PARTNER_TOOL_CHANGED' using errcode='40001'; end if;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception 'PARTNER_INPUT_INVALID' using errcode='22023'; end;
    update public.partner_tools set name=tool_name,description=tool_description,category=tool_category,logo_url=tool_logo,
      destination_url=tool_destination,status=tool_status,featured=tool_featured,sort_order=tool_order,
      updated_at=greatest(clock_timestamp(),old_updated_at+interval '1 microsecond') where id=tool_id returning * into saved;
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:partner-tools:catalogue-capacity',0));
    if (select count(*) from public.partner_tools)>=500 then raise exception 'PARTNER_CATALOG_LIMIT' using errcode='22023'; end if;
    insert into public.partner_tools(name,description,category,logo_url,destination_url,status,featured,sort_order)
      values(tool_name,tool_description,tool_category,tool_logo,tool_destination,tool_status,tool_featured,tool_order) returning * into saved;
  end if;
  return to_jsonb(saved)-'created_at';
end;
$$;
revoke all on function public.xelay_admin_save_partner_tool(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_admin_save_partner_tool(jsonb,uuid) to authenticated;

-- Callable only by the server, never by a browser's anon/authenticated API token.
create function public.xelay_record_partner_click(p_tool_id uuid,p_source text,p_fingerprint text,p_network_fingerprint text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare stamp timestamptz:=clock_timestamp(); allowed_hits integer; accepted boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'PARTNER_COUNTER_SERVER_ONLY' using errcode='42501'; end if;
  if p_source not in('catalog','home') or p_source is null or p_fingerprint !~ '^[0-9a-f]{64}$' or p_fingerprint is null
    or p_network_fingerprint !~ '^[0-9a-f]{64}$' or p_network_fingerprint is null then raise exception 'PARTNER_INPUT_INVALID' using errcode='22023'; end if;
  perform 1 from public.partner_tools where id=p_tool_id and status='published' for share;
  if not found then return jsonb_build_object('counted',false); end if;
  -- Very short-lived, irreversible pseudonyms only. No IP, UA, account, cookie or email is stored.
  delete from public.partner_tool_click_dedupe where last_counted_at<stamp-interval '2 days';
  delete from public.partner_tool_click_rate where window_started_at<stamp-interval '2 days';
  insert into public.partner_tool_click_rate as r(fingerprint,window_started_at,hits) values(p_network_fingerprint,stamp,1)
    on conflict(fingerprint) do update set window_started_at=case when r.window_started_at<=stamp-interval '1 minute' then stamp else r.window_started_at end,
      hits=case when r.window_started_at<=stamp-interval '1 minute' then 1 else least(r.hits+1,601) end returning hits into allowed_hits;
  if allowed_hits>600 then return jsonb_build_object('counted',false); end if;
  insert into public.partner_tool_click_dedupe as d(tool_id,fingerprint,last_counted_at) values(p_tool_id,p_fingerprint,stamp)
    on conflict(tool_id,fingerprint) do update set last_counted_at=excluded.last_counted_at
    where d.last_counted_at<=stamp-interval '30 minutes' returning true into accepted;
  if accepted is distinct from true then return jsonb_build_object('counted',false); end if;
  insert into public.partner_tool_click_daily as d(date,tool_id,source,clicks)
    values((stamp at time zone 'Europe/Kyiv')::date,p_tool_id,p_source,1)
    on conflict(date,tool_id,source) do update set clicks=d.clicks+1;
  return jsonb_build_object('counted',true);
end;
$$;
revoke all on function public.xelay_record_partner_click(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_record_partner_click(uuid,text,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('partner-logos','partner-logos',true,2097152,array['image/png','image/jpeg','image/webp']);
create policy "Partner logos public read" on storage.objects for select to anon,authenticated using(bucket_id='partner-logos');
create policy "Partner logos admin insert" on storage.objects for insert to authenticated
  with check(bucket_id='partner-logos' and public.xelay_private_partner_is_admin());
create policy "Partner logos admin update" on storage.objects for update to authenticated
  using(bucket_id='partner-logos' and public.xelay_private_partner_is_admin())
  with check(bucket_id='partner-logos' and public.xelay_private_partner_is_admin());
create policy "Partner logos admin delete" on storage.objects for delete to authenticated
  using(bucket_id='partner-logos' and public.xelay_private_partner_is_admin());
-- Restrictive guards keep older broad storage policies from granting partner-logo writes.
create policy "Partner logo insert boundary" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'partner-logos' or (public.xelay_private_partner_is_admin()
    and lower(storage.extension(name)) in('png','jpg','jpeg','webp')));
create policy "Partner logo update boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'partner-logos' or public.xelay_private_partner_is_admin())
  with check(bucket_id<>'partner-logos' or (public.xelay_private_partner_is_admin()
    and lower(storage.extension(name)) in('png','jpg','jpeg','webp')));
create policy "Partner logo delete boundary" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'partner-logos' or public.xelay_private_partner_is_admin());

commit;
