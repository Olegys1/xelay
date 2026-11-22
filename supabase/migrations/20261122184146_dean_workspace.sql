begin;
set local lock_timeout='5s';
create schema if not exists dean_private;
revoke all on schema dean_private from public,anon,authenticated;
grant usage on schema dean_private to authenticated;

create table dean_private.access (
 user_id uuid references public.profiles(id) on delete cascade,
 group_id uuid references public.study_groups(id) on delete cascade,
 granted_by uuid not null references public.profiles(id),
 primary key(user_id,group_id)
);
create table dean_private.drafts (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id),
 title text not null check(length(title) between 1 and 160), revision integer not null default 1,
 document jsonb not null check(octet_length(document::text)<=8000000),
 approved_revision integer, approved_by uuid references public.profiles(id), published_revision integer,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table dean_private.history (
 draft_id uuid references dean_private.drafts(id), revision integer, document jsonb not null,
 actor uuid not null references public.profiles(id), created_at timestamptz not null default now(), primary key(draft_id,revision)
);
create table dean_private.audit (
 id bigint generated always as identity primary key, actor uuid not null references public.profiles(id),
 action text not null, draft_id uuid, revision integer, created_at timestamptz not null default now()
);
-- Personalized projection: original group schedules are never updated or deleted.
create table dean_private.lessons (
 id uuid primary key default gen_random_uuid(), draft_id uuid not null references dean_private.drafts(id),
 group_id uuid not null references public.study_groups(id), user_ids uuid[] not null,
 source_id text not null, subject text not null, teacher_name text not null, teacher_ids text[] not null,
 lesson_type text not null, lesson_date date not null, period integer not null,
 created_by uuid not null references public.profiles(id), unique(draft_id,group_id,source_id,lesson_date)
);
create index on dean_private.lessons(group_id,lesson_date,id);
create index on dean_private.lessons using gin(user_ids);
alter table dean_private.access enable row level security;
alter table dean_private.drafts enable row level security;
alter table dean_private.history enable row level security;
alter table dean_private.audit enable row level security;
alter table dean_private.lessons enable row level security;
revoke all on all tables in schema dean_private from public,anon,authenticated;

create function dean_private.session_valid(p_mfa boolean default true) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and exists(select 1 from auth.users u where u.id=auth.uid() and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()))
 and exists(select 1 from auth.sessions s where s.user_id=auth.uid() and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after>now()))
 and (not p_mfa or (coalesce(auth.jwt()->>'aal','')='aal2' and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')))
$$;
create function dean_private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
 select dean_private.session_valid() and public.xelay_is_platform_admin()
 and exists(select 1 from public.user_roles where user_id=auth.uid() and role='ADMIN')
$$;
create function dean_private.can_group(p_group uuid) returns boolean language sql stable security definer set search_path='' as $$
 select dean_private.session_valid() and exists(select 1 from public.study_groups where id=p_group)
 and (dean_private.is_admin() or exists(select 1 from dean_private.access where user_id=auth.uid() and group_id=p_group))
$$;

-- Validate the exact saved projection again under a publication lock, not a client audit flag.
create function dean_private.validate_rows(p_document jsonb,p_draft uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; g uuid; users uuid[]; d date; p integer; cnt integer; total integer:=0;
begin
 if jsonb_typeof(p_document->'rows') is distinct from 'array' or jsonb_array_length(p_document->'rows') not between 1 and 20000 then raise exception 'DEAN_ROWS_REQUIRED'; end if;
 if exists(select 1 from (select distinct (e->>'groupId')::uuid g from jsonb_array_elements(p_document->'rows') e) scope where not dean_private.can_group(scope.g)) then raise exception 'DEAN_SCOPE_DENIED' using errcode='42501'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e,jsonb_array_elements_text(e->'userIds') u
  where not exists(select 1 from public.study_group_members m where m.group_id=(e->>'groupId')::uuid and m.user_id=u::uuid and m.status='accepted')) then raise exception 'DEAN_ROSTER_CHANGED'; end if;
 for r in select value from jsonb_array_elements(p_document->'rows') loop
  if jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'userIds') is distinct from 'array' or jsonb_typeof(r->'teacherIds') is distinct from 'array'
   or coalesce(r->>'activity','') not in('lecture','practice','seminar','lab')
   or length(coalesce(r->>'subject','')) not between 1 and 120 or length(coalesce(r->>'sourceId','')) not between 1 and 200
   or length(coalesce(r->>'teacher',''))>180 or coalesce(r->>'period','')!~'^[1-6]$' or coalesce(r->>'date','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'DEAN_ROW_INVALID'; end if;
  g:=(r->>'groupId')::uuid; d:=(r->>'date')::date; p:=(r->>'period')::integer;
  if extract(isodow from d)>5 or d<date '2020-01-01' or d>date '2100-01-01' then raise exception 'DEAN_DATE_INVALID'; end if;
  select array_agg(value::uuid),count(distinct value) into users,cnt from jsonb_array_elements_text(r->'userIds');
  if coalesce(cnt,0)=0 or cnt<>jsonb_array_length(r->'userIds') or cnt>5000 then raise exception 'DEAN_ROSTER_INVALID'; end if;
  if exists(select 1 from jsonb_array_elements_text(r->'teacherIds') t where length(t) not between 1 and 200) then raise exception 'DEAN_TEACHER_INVALID'; end if;
  -- Conservatively reject overlapping existing group entries; never overwrite them.
  if exists(select 1 from public.study_group_schedule s where s.group_id=g and s.weekday=extract(isodow from d)
    and d between s.valid_from and s.valid_until
    and s.starts_at < (array['09:20','11:00','12:40','14:10','15:50','17:20'])[p]::time
    and s.ends_at > (array['08:00','09:40','11:20','12:50','14:30','16:00'])[p]::time) then raise exception 'DEAN_EXISTING_GROUP_CONFLICT'; end if;
  if exists(select 1 from dean_private.lessons l where l.draft_id<>p_draft and l.lesson_date=d and l.period=p
    and (l.user_ids&&users or l.teacher_ids&&array(select jsonb_array_elements_text(r->'teacherIds')))) then raise exception 'DEAN_PUBLISHED_CONFLICT'; end if;
  total:=total+cnt;
 end loop;
 -- A source event can span groups but must have a single time, subject and teacher identity.
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e group by e->>'sourceId',e->>'date'
   having count(distinct (e->>'period',e->>'subject',e->>'activity',e->>'teacher',e->'teacherIds'))>1)
 then raise exception 'DEAN_SOURCE_INCONSISTENT'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e where e->>'activity'='lab'
   group by e->>'sourceId',e->>'date' having sum(jsonb_array_length(e->'userIds'))>18) then raise exception 'DEAN_LAB_CAPACITY'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e, jsonb_array_elements_text(e->'userIds') u
   group by u,e->>'date',e->>'period' having count(*)>1) then raise exception 'DEAN_STUDENT_CONFLICT'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e,jsonb_array_elements_text(e->'teacherIds') t
   group by t,e->>'date',e->>'period' having count(distinct e->>'sourceId')>1) then raise exception 'DEAN_TEACHER_CONFLICT'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e,jsonb_array_elements_text(e->'userIds') u
   group by u,e->>'date' having count(*) not between 2 and 4 or max((e->>'period')::int)-min((e->>'period')::int)+1<>count(*)) then raise exception 'DEAN_DAY_GAPS_OR_LOAD'; end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') e,jsonb_array_elements_text(e->'userIds') u
   group by u,date_trunc('week',(e->>'date')::date)
   having (count(*)>=10 and count(distinct e->>'date')<>5) or (count(*)<10 and count(distinct e->>'date') not between 3 and 4)) then raise exception 'DEAN_STUDY_DAYS'; end if;
 return jsonb_build_object('lessons',jsonb_array_length(p_document->'rows'),'attendances',total,'passed',true);
end $$;

create function dean_private.workspace(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v dean_private.drafts; result jsonb; ident uuid; report jsonb; r jsonb;
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501'; end if;
 if not dean_private.is_admin() and not exists(select 1 from dean_private.access where user_id=auth.uid()) then raise exception 'DEAN_ACCESS_DENIED' using errcode='42501'; end if;
 if p_action='catalog' then
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name,'members',
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name,'username',p.username) order by p.full_name),'[]') from public.study_group_members m join public.profiles p on p.id=m.user_id where m.group_id=g.id and m.status='accepted')) order by g.group_name),'[]') into result
    from public.study_groups g where dean_private.can_group(g.id);
  return jsonb_build_object('groups',result,'admin',dean_private.is_admin());
 elsif p_action='list' then
  select coalesce(jsonb_agg(to_jsonb(x) order by updated_at desc),'[]') into result from
   (select id,title,revision,approved_revision,published_revision,updated_at from dean_private.drafts where owner_id=auth.uid() or dean_private.is_admin() order by updated_at desc limit 100) x;
  return result;
 elsif p_action='grant' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_payload->>'enabled'='true' then
   insert into dean_private.access(user_id,group_id,granted_by) values((p_payload->>'userId')::uuid,(p_payload->>'groupId')::uuid,auth.uid()) on conflict do nothing;
  elsif p_payload->>'enabled'='false' then delete from dean_private.access where user_id=(p_payload->>'userId')::uuid and group_id=(p_payload->>'groupId')::uuid;
  else raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.audit(actor,action)values(auth.uid(),'access:'||(p_payload->>'enabled'));
  return jsonb_build_object('ok',true);
 elsif p_action='create' then
  if octet_length(p_payload::text)>8000000 or jsonb_typeof(p_payload->'document') is distinct from 'object' then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.drafts(owner_id,title,document)values(auth.uid(),p_payload->>'title',p_payload->'document')returning * into v;
  insert into dean_private.history values(v.id,v.revision,v.document,auth.uid(),now());
  insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'create',v.id,v.revision);
  return to_jsonb(v);
 end if;
 ident:=(p_payload->>'id')::uuid;
 select * into v from dean_private.drafts where id=ident for update;
 if v.id is null or (v.owner_id<>auth.uid() and not dean_private.is_admin()) then raise exception 'DEAN_DRAFT_DENIED' using errcode='42501'; end if;
 if p_action='load' then return to_jsonb(v); end if;
 if (p_payload->>'revision')::int is distinct from v.revision then raise exception 'DEAN_STALE_VERSION'; end if;
 if p_action='save' then
  if v.published_revision is not null then raise exception 'DEAN_PUBLISHED_IMMUTABLE'; end if;
  if jsonb_typeof(p_payload->'document') is distinct from 'object' then raise exception 'DEAN_INPUT_INVALID'; end if;
  update dean_private.drafts set document=p_payload->'document',revision=revision+1,approved_revision=null,approved_by=null,updated_at=now() where id=v.id returning * into v;
  insert into dean_private.history values(v.id,v.revision,v.document,auth.uid(),now());
 elsif p_action in('review','approve','publish') then
  -- Serializes dean publications. Existing schedules are protected against concurrent edits too.
  perform pg_advisory_xact_lock(22112026,1);
  if p_action='publish' then
   lock table public.study_group_schedule in share mode;
   lock table public.study_group_members in share mode;
   lock table dean_private.access in share mode;
  end if;
  if p_action='publish' and v.published_revision=v.revision then return to_jsonb(v); end if;
  report:=dean_private.validate_rows(v.document,v.id);
  if p_action='review' then return report; end if;
  if p_action='approve' then
   if not dean_private.is_admin() or p_payload->>'confirmation' is distinct from ('ПІДТВЕРДЖУЮ '||v.revision) then raise exception 'DEAN_CONFIRMATION_REQUIRED'; end if;
   update dean_private.drafts set approved_revision=revision,approved_by=auth.uid() where id=v.id returning * into v;
  else
   if v.approved_revision is distinct from v.revision or v.approved_by is null then raise exception 'DEAN_APPROVAL_REQUIRED'; end if;
   for r in select value from jsonb_array_elements(v.document->'rows') loop
    insert into dean_private.lessons(draft_id,group_id,user_ids,source_id,subject,teacher_name,teacher_ids,lesson_type,lesson_date,period,created_by)
    values(v.id,(r->>'groupId')::uuid,array(select value::uuid from jsonb_array_elements_text(r->'userIds')),r->>'sourceId',r->>'subject',coalesce(r->>'teacher',''),array(select jsonb_array_elements_text(r->'teacherIds')),
    case r->>'activity' when 'practice' then 'practical' else r->>'activity' end,(r->>'date')::date,(r->>'period')::int,auth.uid());
   end loop;
   update dean_private.drafts set published_revision=revision where id=v.id returning * into v;
  end if;
 else raise exception 'DEAN_ACTION_INVALID'; end if;
 insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),p_action,v.id,v.revision);
 return to_jsonb(v);
end $$;

create function public.xelay_dean_workspace(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path='' as $$select dean_private.workspace(p_action,p_payload)$$;

create function dean_private.personal_lessons(p_group uuid,p_after uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not dean_private.session_valid(false) then raise exception 'DEAN_MEMBER_REQUIRED' using errcode='42501'; end if;
 if not exists(select 1 from public.study_group_members where group_id=p_group and user_id=auth.uid() and status='accepted') then return '[]'::jsonb; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') into result from (
  select id,group_id,extract(isodow from lesson_date)::int weekday,
   (array['08:00','09:40','11:20','12:50','14:30','16:00'])[period] starts_at,
   (array['09:20','11:00','12:40','14:10','15:50','17:20'])[period] ends_at,
   subject,teacher_name,lesson_type,lesson_date valid_from,lesson_date valid_until,period lesson_number,
   ''::text location,null::text online_url,created_by,true dean_managed
  from dean_private.lessons where group_id=p_group and auth.uid()=any(user_ids) and (p_after is null or id>p_after) order by id limit 500
 ) x; return result;
end $$;
create function public.xelay_dean_personal_lessons(p_group uuid,p_after uuid default null) returns jsonb
language sql security invoker set search_path='' as $$select dean_private.personal_lessons(p_group,p_after)$$;
revoke all on all functions in schema dean_private from public,anon,authenticated;
grant execute on function dean_private.workspace(text,jsonb),dean_private.personal_lessons(uuid,uuid) to authenticated;
revoke all on function public.xelay_dean_workspace(text,jsonb),public.xelay_dean_personal_lessons(uuid,uuid) from public,anon;
grant execute on function public.xelay_dean_workspace(text,jsonb),public.xelay_dean_personal_lessons(uuid,uuid) to authenticated;
commit;
