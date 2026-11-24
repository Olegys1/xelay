begin;
set local lock_timeout='5s';

-- A main timetable is a private, versioned snapshot, never a student publication.
alter table dean_private.drafts add column workspace_id uuid references dean_private.drafts(id);
update dean_private.drafts set workspace_id=id;
alter table dean_private.drafts alter column workspace_id set not null;
create function dean_private.draft_workspace_default() returns trigger language plpgsql set search_path='' as $$
begin new.workspace_id:=coalesce(new.workspace_id,new.id);return new;end $$;
create trigger dean_draft_workspace before insert on dean_private.drafts for each row execute function dean_private.draft_workspace_default();
create table dean_private.main_schedules (
 workspace_id uuid primary key references dean_private.drafts(id),
 draft_id uuid not null references dean_private.drafts(id), revision integer not null,
 version integer not null, document jsonb not null, title text not null,
 selected_by uuid not null references public.profiles(id), selected_at timestamptz not null default now()
);
alter table dean_private.main_schedules enable row level security;
revoke all on dean_private.main_schedules from public,anon,authenticated;

create function dean_private.can_read_draft(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select dean_private.session_valid() and not exists(select 1 from dean_private.staff where user_id=auth.uid() and not enabled)
 and exists(select 1 from dean_private.drafts d where d.id=p_id and (
 d.owner_id=auth.uid() or dean_private.is_admin() or exists(select 1 from dean_private.draft_readers where draft_id=d.id and user_id=auth.uid())
 or exists(select 1 from dean_private.main_schedules m join dean_private.drafts root on root.id=m.workspace_id where m.draft_id=d.id
 and (root.owner_id=auth.uid() or exists(select 1 from dean_private.draft_readers where draft_id=root.id and user_id=auth.uid())))
 ))
$$;

-- Revalidate a candidate independently of the worker's report and of browser controls.
create function dean_private.validate_source(p_source jsonb,p_settings jsonb default '{}',p_placement boolean default true) returns void
language plpgsql security definer set search_path='' as $$
declare e jsonb; r jsonb; cfg jsonb; n integer;
begin
 if jsonb_typeof(p_source->'events') is distinct from 'array' or jsonb_typeof(p_source->'students') is distinct from 'array'
 or jsonb_array_length(p_source->'events') not between 1 and 600 or jsonb_array_length(p_source->'students') not between 1 and 5000 then raise exception 'DEAN_SOURCE_INVALID';end if;
 cfg:='{"days":[1,2,3,4,5],"firstPeriod":1,"lastPeriod":6,"minDaily":2,"maxDaily":4,"zeroGaps":true,"fiveDays":true,"lowLoadException":true,"teacherZeroGaps":false,"blocked":[]}'::jsonb||coalesce(p_settings,'{}');
 if jsonb_typeof(cfg->'days') is distinct from 'array' or jsonb_array_length(cfg->'days') not between 1 and 5
 or exists(select 1 from jsonb_array_elements_text(cfg->'days') d where d!~'^[1-5]$')
 or exists(select 1 from unnest(array['firstPeriod','lastPeriod','minDaily','maxDaily']) k where coalesce(cfg->>k,'')!~'^[1-6]$')
 or exists(select 1 from unnest(array['zeroGaps','fiveDays','lowLoadException','teacherZeroGaps']) k where jsonb_typeof(cfg->k) is distinct from 'boolean')
 or (cfg->>'firstPeriod')::int>(cfg->>'lastPeriod')::int or (cfg->>'minDaily')::int>(cfg->>'maxDaily')::int
 or jsonb_typeof(cfg->'blocked') is distinct from 'array' or jsonb_array_length(cfg->'blocked')>200 then raise exception 'DEAN_SETTINGS_INVALID';end if;
 if exists(select 1 from jsonb_array_elements(p_source->'students') s where length(coalesce(s->>'id','')) not between 1 and 200 or length(coalesce(s->>'name','')) not between 1 and 200 or length(coalesce(s->>'group',''))>120)
 or exists(select 1 from jsonb_array_elements(p_source->'students') s group by s->>'id' having count(*)>1)
 or exists(select 1 from jsonb_array_elements(p_source->'events') x group by x->>'id' having count(*)>1) then raise exception 'DEAN_SOURCE_INVALID';end if;
 for e in select value from jsonb_array_elements(p_source->'events') loop
  if length(coalesce(e->>'id','')) not between 1 and 200 or length(coalesce(e->>'course','')) not between 1 and 120 or length(coalesce(e->>'teacher',''))>180
  or coalesce(e->>'activity','') not in('lecture','practice','seminar','lab') or coalesce(e->>'day','')!~'^[1-5]$' or coalesce(e->>'period','')!~'^[1-6]$'
  or jsonb_typeof(e->'studentIds') is distinct from 'array' or jsonb_typeof(e->'teacherIds') is distinct from 'array' or jsonb_typeof(e->'weeks') is distinct from 'array'
  then raise exception 'DEAN_SOURCE_INVALID';end if;
  if jsonb_array_length(e->'studentIds') not between 1 and 5000 or jsonb_array_length(e->'teacherIds')>10 or jsonb_array_length(e->'weeks') not between 1 and 30
  or exists(select 1 from jsonb_array_elements_text(e->'weeks') w where w!~'^([1-9]|[12][0-9]|30)$')
  or exists(select 1 from jsonb_array_elements_text(e->'teacherIds') t where length(t) not between 1 and 200)
  or exists(select 1 from jsonb_array_elements_text(e->'studentIds') s where not exists(select 1 from jsonb_array_elements(p_source->'students') p where p->>'id'=s))
  or (select count(distinct s) from jsonb_array_elements_text(e->'studentIds') s)<>jsonb_array_length(e->'studentIds')
  or (select count(distinct t) from jsonb_array_elements_text(e->'teacherIds') t)<>jsonb_array_length(e->'teacherIds')
  or (select count(distinct w) from jsonb_array_elements_text(e->'weeks') w)<>jsonb_array_length(e->'weeks') then raise exception 'DEAN_SOURCE_INVALID';end if;
  if e->>'activity'='lab' and jsonb_array_length(e->'studentIds')>18 then raise exception 'DEAN_LAB_CAPACITY';end if;
 end loop;
 if p_source?'rooms' then
  if jsonb_typeof(p_source->'rooms') is distinct from 'array' or jsonb_array_length(p_source->'rooms')>200
  or exists(select 1 from jsonb_array_elements(p_source->'rooms') x group by x->>'id' having count(*)>1) then raise exception 'DEAN_ROOMS_INVALID';end if;
  for r in select value from jsonb_array_elements(p_source->'rooms') loop
   if length(coalesce(r->>'id','')) not between 1 and 80 or jsonb_typeof(r->'computer') is distinct from 'boolean' or jsonb_typeof(r->'disabled') is distinct from 'boolean'
   or jsonb_typeof(r->'allowedPrograms') is distinct from 'array' or jsonb_typeof(r->'blockedSlots') is distinct from 'array' then raise exception 'DEAN_ROOMS_INVALID';end if;
   if not (r->>'disabled'='true' and r->'capacity'='null') and (coalesce(r->>'capacity','')!~'^[1-9][0-9]{0,3}$' or (r->>'capacity')::int>5000) then raise exception 'DEAN_ROOMS_INVALID';end if;
   if jsonb_array_length(r->'blockedSlots')>30 or jsonb_array_length(r->'allowedPrograms')>100
   or exists(select 1 from jsonb_array_elements(r->'blockedSlots') b where jsonb_typeof(b)<>'array' or jsonb_array_length(b)<>2 or coalesce(b->>0,'')!~'^[1-5]$' or coalesce(b->>1,'')!~'^[1-6]$') then raise exception 'DEAN_ROOMS_INVALID';end if;
  end loop;
 end if;
 if cfg?'teacherMaxWeeklyGaps' and cfg->'teacherMaxWeeklyGaps'<>'null' and coalesce(cfg->>'teacherMaxWeeklyGaps','')!~'^([0-9]|[12][0-9]|30)$' then raise exception 'DEAN_SETTINGS_INVALID';end if;
 if not p_placement then return;end if;
 for e in select value from jsonb_array_elements(p_source->'events') loop
  if not cfg->'days' @> jsonb_build_array((e->>'day')::int) or (e->>'period')::int not between (cfg->>'firstPeriod')::int and (cfg->>'lastPeriod')::int then raise exception 'DEAN_TIME_INVALID';end if;
  if exists(select 1 from jsonb_array_elements(cfg->'blocked') b where e->'teacherIds' ? (b->>'teacher') and e->'day'=b->'day' and e->'period'=b->'period') then raise exception 'DEAN_TEACHER_UNAVAILABLE';end if;
  if p_source?'rooms' then
   select value into r from jsonb_array_elements(p_source->'rooms') where value->>'id'=e->>'room';
   if r is null or r->>'disabled'='true' or jsonb_array_length(e->'studentIds')>coalesce((r->>'capacity')::int,-4)+3
   or e->>'activity'='lab' and r->>'computer'<>'true'
   or exists(select 1 from jsonb_array_elements(r->'blockedSlots') b where b->0=e->'day' and b->1=e->'period')
   or jsonb_array_length(r->'allowedPrograms')>0 and exists(select 1 from jsonb_array_elements(p_source->'students') s where e->'studentIds' ? (s->>'id') and not exists(select 1 from jsonb_array_elements_text(r->'allowedPrograms') p where upper(trim(p))=upper(trim(split_part(s->>'group','-',1))))) then raise exception 'DEAN_ROOM_INELIGIBLE';end if;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'studentIds') s group by s,w,ev->>'day',ev->>'period' having count(*)>1) then raise exception 'DEAN_STUDENT_CONFLICT';end if;
 if exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'teacherIds') t group by t,w,ev->>'day',ev->>'period' having count(*)>1) then raise exception 'DEAN_TEACHER_CONFLICT';end if;
 if p_source?'rooms' and exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w group by ev->>'room',w,ev->>'day',ev->>'period' having count(*)>1) then raise exception 'DEAN_ROOM_CONFLICT';end if;
 if exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'studentIds') s group by s,w,ev->>'day' having count(*) not between (cfg->>'minDaily')::int and (cfg->>'maxDaily')::int or (cfg->>'zeroGaps')::boolean and max((ev->>'period')::int)-min((ev->>'period')::int)+1<>count(*)) then raise exception 'DEAN_DAY_GAPS_OR_LOAD';end if;
 if (cfg->>'fiveDays')::boolean and exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'studentIds') s group by s,w having case when (cfg->>'lowLoadException')::boolean and count(*)<10 then count(distinct ev->>'day') not between 3 and 4 else count(distinct ev->>'day')<>jsonb_array_length(cfg->'days') end) then raise exception 'DEAN_STUDY_DAYS';end if;
 if (cfg->>'teacherZeroGaps')::boolean and exists(select 1 from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'teacherIds') t group by t,w,ev->>'day' having max((ev->>'period')::int)-min((ev->>'period')::int)+1<>count(*)) then raise exception 'DEAN_TEACHER_GAPS';end if;
 if cfg->>'teacherMaxWeeklyGaps' is not null and exists(select 1 from (select t,w,ev->>'day' as lesson_day,max((ev->>'period')::int)-min((ev->>'period')::int)+1-count(*) gaps from jsonb_array_elements(p_source->'events') ev,jsonb_array_elements_text(ev->'weeks') w,jsonb_array_elements_text(ev->'teacherIds') t group by t,w,ev->>'day') per_day group by t,w having sum(gaps)>(cfg->>'teacherMaxWeeklyGaps')::int) then raise exception 'DEAN_TEACHER_GAPS';end if;
end $$;

alter function dean_private.workspace(text,jsonb) rename to workspace_previous;
revoke all on function dean_private.workspace_previous(text,jsonb) from public,anon,authenticated;
create function dean_private.workspace(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d dean_private.drafts; root dean_private.drafts; main dean_private.main_schedules; n dean_private.drafts; result jsonb;
begin
 -- Reuse the exact access gate, including current sessions, 2FA and disabled staff.
 perform dean_private.workspace_previous('catalog','{}');
 if p_action in('teacher_catalog','teacher_publish') then return dean_private.teacher_delivery(case when p_action='teacher_catalog' then 'catalog' else 'publish' end,p_payload);end if;
 if p_action='list' then
  return (select coalesce(jsonb_agg(to_jsonb(x) order by updated_at desc),'[]') from (select id,title,revision,workspace_id,approved_revision,published_revision,updated_at from dean_private.drafts where dean_private.can_read_draft(id) order by updated_at desc limit 100) x);
 end if;
 if p_action='create' then
  perform dean_private.validate_source(p_payload->'document'->'source',p_payload->'document'->'settings',false);
  if p_payload->'document'?'planningSource' then perform dean_private.validate_source(p_payload->'document'->'planningSource',p_payload->'document'->'settings',false);end if;
  return dean_private.workspace_previous(p_action,p_payload);
 end if;
 if p_action in('catalog','grant') then return dean_private.workspace_previous(p_action,p_payload);end if;
 select * into d from dean_private.drafts where id=(p_payload->>'id')::uuid for update;
 if d.id is null or not dean_private.can_read_draft(d.id) then raise exception 'DEAN_DRAFT_DENIED';end if;
 select * into root from dean_private.drafts where id=d.workspace_id for update;
 select * into main from dean_private.main_schedules where workspace_id=d.workspace_id for update;
 if p_action='load' then return to_jsonb(d);end if;
 if p_action='main' then
  if not dean_private.can_read_draft(root.id) then return '{"main":null,"canSelect":false}'::jsonb;end if;
  return jsonb_build_object('main',case when main.workspace_id is not null then to_jsonb(main) else null end,'canSelect',true);
 end if;
 if (p_payload->>'revision')::int is distinct from d.revision then raise exception 'DEAN_STALE_VERSION';end if;
 if p_action='fork' then
  insert into dean_private.drafts(owner_id,title,document,workspace_id)values(auth.uid(),left(d.title,140)||' · чернетка',(d.document-'planningSource')||'{"rows":[]}'::jsonb,d.workspace_id)returning * into n;
  insert into dean_private.history values(n.id,n.revision,n.document,auth.uid(),now());
  insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'fork',n.id,n.revision);return to_jsonb(n);
 elsif p_action='make_main' then
  if not (dean_private.is_admin() or root.owner_id=auth.uid() or exists(select 1 from dean_private.draft_readers where draft_id=root.id and user_id=auth.uid())) then raise exception 'DEAN_MAIN_DENIED';end if;
  if p_payload->>'confirmation' is distinct from ('ОСНОВНИЙ '||d.revision) then raise exception 'DEAN_CONFIRMATION_REQUIRED';end if;
  if (p_payload->>'mainVersion')::int is distinct from coalesce(main.version,0) then raise exception 'DEAN_STALE_VERSION';end if;
  if d.document?'planningSource' then raise exception 'DEAN_INPUTS_NOT_CALCULATED';end if;
  perform dean_private.validate_source(d.document->'source',d.document->'settings',true);
  insert into dean_private.main_schedules values(d.workspace_id,d.id,d.revision,coalesce(main.version,0)+1,d.document,d.title,auth.uid(),now())
  on conflict(workspace_id) do update set draft_id=excluded.draft_id,revision=excluded.revision,version=excluded.version,document=excluded.document,title=excluded.title,selected_by=excluded.selected_by,selected_at=excluded.selected_at returning * into main;
  insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'make_main',d.id,d.revision);
  return to_jsonb(main);
 elsif p_action='save' then
  if d.teacher_published_revision is not null and (p_payload->'document'->'source' is distinct from d.document->'source' or p_payload->'document'->'teacherMapping' is distinct from d.document->'teacherMapping' or p_payload->'document'->'monday' is distinct from d.document->'monday') then raise exception 'DEAN_MAIN_IMMUTABLE';end if;
  if d.id=main.draft_id and (p_payload->'document'->'source' is distinct from main.document->'source' or p_payload->'document'->'settings' is distinct from main.document->'settings' or p_payload->'document'?'planningSource') then raise exception 'DEAN_MAIN_IMMUTABLE';end if;
  perform dean_private.validate_source(p_payload->'document'->'source',p_payload->'document'->'settings',false);
  if p_payload->'document'?'planningSource' then perform dean_private.validate_source(p_payload->'document'->'planningSource',p_payload->'document'->'settings',false);end if;
 elsif p_action in('review','approve','publish') then
  if main.draft_id is distinct from d.id or main.revision is distinct from d.revision or main.document is distinct from d.document then raise exception 'DEAN_MAIN_REQUIRED';end if;
  perform dean_private.validate_source(d.document->'source',d.document->'settings',true);
 end if;
 if p_action='approve' then
  if not dean_private.is_admin() or p_payload->>'confirmation' is distinct from ('ПІДТВЕРДЖУЮ '||d.revision) then raise exception 'DEAN_CONFIRMATION_REQUIRED';end if;
  perform dean_private.validate_rows(d.document,d.id);
  update dean_private.drafts set approved_revision=revision,approved_by=auth.uid() where id=d.id returning * into d;
  insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'approve',d.id,d.revision);return to_jsonb(d);
 end if;
 result:=dean_private.workspace_previous(p_action,p_payload);
 if p_action='save' and d.id=main.draft_id then
  update dean_private.main_schedules set document=result->'document',revision=(result->>'revision')::int,version=version+1 where workspace_id=d.workspace_id;
 end if;
 return result;
end $$;
revoke all on function dean_private.can_read_draft(uuid),dean_private.validate_source(jsonb,jsonb,boolean),dean_private.draft_workspace_default(),dean_private.workspace(text,jsonb) from public,anon,authenticated;
grant execute on function dean_private.workspace(text,jsonb) to authenticated;

create or replace function dean_private.online(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d dean_private.drafts; j dean_private.jobs; n dean_private.drafts; result jsonb; candidate jsonb; who uuid;
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501'; end if;
 if not dean_private.is_admin() and not dean_private.staff_enabled(auth.uid()) and not exists(select 1 from dean_private.access where user_id=auth.uid()) then raise exception 'DEAN_ACCESS_DENIED' using errcode='42501'; end if;
 if p_action='staff_list' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(s) order by created_at),'[]') from dean_private.staff s);
 elsif p_action='staff_register' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  who:=(p_payload->>'userId')::uuid;
  if not exists(select 1 from auth.users where id=who and raw_app_meta_data->>'dean_service'='true' and raw_app_meta_data->>'created_by'=auth.uid()::text and email=p_payload->>'login') then raise exception 'DEAN_STAFF_INVALID'; end if;
  if length(p_payload->>'label') not between 1 and 120 then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.staff(user_id,label,login,created_by) values(who,p_payload->>'label',p_payload->>'login',auth.uid());
  if p_payload->>'draftId' is not null then
   insert into dean_private.draft_readers values((p_payload->>'draftId')::uuid,who);
  end if;
  insert into dean_private.audit(actor,action)values(auth.uid(),'staff_created');
  return jsonb_build_object('ok',true);
 elsif p_action='staff_disable' then
  if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED'; end if;
  update dean_private.staff set enabled=false where user_id=(p_payload->>'userId')::uuid;
  delete from dean_private.access where user_id=(p_payload->>'userId')::uuid;
  insert into dean_private.audit(actor,action)values(auth.uid(),'staff_disabled');
  return jsonb_build_object('ok',true);
 elsif p_action='jobs' then
  return (select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from (
   select id,draft_id,revision,case when state='running' and created_at<now()-interval '4 minutes' then 'interrupted' else state end state,
    created_at,finished_at,applied_draft from dean_private.jobs where owner_id=auth.uid() order by created_at desc limit 12) x);
 elsif p_action='begin' then
  perform pg_advisory_xact_lock(22112026,2);
  select * into d from dean_private.drafts where id=(p_payload->>'draftId')::uuid for update;
  if d.id is null or not dean_private.can_read_draft(d.id) then raise exception 'DEAN_DRAFT_DENIED'; end if;
  if d.revision is distinct from (p_payload->>'revision')::integer then raise exception 'DEAN_STALE_VERSION'; end if;
  if exists(select 1 from dean_private.jobs where owner_id=auth.uid() and ((state='running' and created_at>now()-interval '4 minutes') or created_at>now()-interval '30 seconds')) then raise exception 'DEAN_CALC_BUSY'; end if;
  if (select count(*) from dean_private.jobs where state='running' and created_at>now()-interval '4 minutes')>=2 then raise exception 'DEAN_CALC_BUSY'; end if;
  if (select count(*) from dean_private.jobs where owner_id=auth.uid() and created_at>now()-interval '24 hours')>=40 then raise exception 'DEAN_CALC_LIMIT'; end if;
  if jsonb_typeof(p_payload->'settings') is distinct from 'object' or octet_length(p_payload::text)>50000 then raise exception 'DEAN_INPUT_INVALID'; end if;
  insert into dean_private.jobs(owner_id,session_id,draft_id,revision,settings,target) values(auth.uid(),auth.jwt()->>'session_id',d.id,d.revision,p_payload->'settings',p_payload->'target') returning * into j;
  return jsonb_build_object('job',j.id,'document',d.document,'settings',j.settings,'target',j.target);
 end if;
 select * into j from dean_private.jobs where id=(p_payload->>'id')::uuid and owner_id=auth.uid() for update;
 if j.id is null then raise exception 'DEAN_JOB_DENIED'; end if;
 if p_action='result' then return to_jsonb(j); end if;
 if p_action<>'apply' or j.state<>'done' then raise exception 'DEAN_RESULT_REQUIRED'; end if;
 if j.applied_draft is not null then
  if j.applied_option is distinct from (p_payload->>'option')::int then raise exception 'DEAN_OPTION_ALREADY_APPLIED'; end if;
  return dean_private.workspace('load',jsonb_build_object('id',j.applied_draft));
 end if;
 select * into d from dean_private.drafts where id=j.draft_id for update;
 if not dean_private.can_read_draft(d.id) then raise exception 'DEAN_DRAFT_DENIED';end if;
 if d.revision<>j.revision then raise exception 'DEAN_STALE_VERSION'; end if;
 candidate:=j.result->'options'->((p_payload->>'option')::int);
 if candidate is null or candidate->'report'->>'passed' is distinct from 'true' then raise exception 'DEAN_RESULT_REQUIRED'; end if;
 -- Worker results cannot change the original hours, memberships, or teaching assignments.
 if jsonb_array_length(candidate->'events')<>jsonb_array_length(coalesce(d.document->'planningSource',d.document->'source')->'events') or exists(
  select 1 from jsonb_array_elements(coalesce(d.document->'planningSource',d.document->'source')->'events') with ordinality a(e,i)
  full join jsonb_array_elements(candidate->'events') with ordinality b(e,i) using(i)
  where (a.e-'day'-'period'-'room') is distinct from (b.e-'day'-'period'-'room')
 ) then raise exception 'DEAN_SOURCE_CHANGED'; end if;
 result:=jsonb_set(d.document-'planningSource','{source}',coalesce(d.document->'planningSource',d.document->'source'));
 result:=jsonb_set(result,'{source,events}',candidate->'events');
 perform dean_private.validate_source(result->'source',j.settings,true);
 result:=jsonb_set(result,'{rows}','[]'); result:=jsonb_set(result,'{settings}',j.settings);
 insert into dean_private.drafts(owner_id,title,document,workspace_id)values(auth.uid(),left(d.title,130)||' · новий варіант',result,d.workspace_id) returning * into n;
 insert into dean_private.history values(n.id,n.revision,n.document,auth.uid(),now());
 update dean_private.jobs set applied_draft=n.id,applied_option=(p_payload->>'option')::int where id=j.id;
 insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'calculation_applied',n.id,n.revision);
 return to_jsonb(n);
end $$;


-- A browser cannot publish a different set of lessons from the selected main snapshot.
alter function dean_private.validate_rows(jsonb,uuid) rename to validate_rows_previous;
revoke all on function dean_private.validate_rows_previous(jsonb,uuid) from public,anon,authenticated;
create function dean_private.validate_rows(p_document jsonb,p_draft uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare expected jsonb; actual jsonb; first_day date;
begin
 if coalesce(p_document->>'monday','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'DEAN_DATE_INVALID';end if;
 first_day:=(p_document->>'monday')::date;
 if extract(isodow from first_day)<>1 then raise exception 'DEAN_DATE_INVALID';end if;
 if exists(select 1 from jsonb_array_elements(p_document->'source'->'events') e,jsonb_array_elements_text(e->'studentIds') s where coalesce(p_document->'mapping'->s->>'userId','')='' or coalesce(p_document->'mapping'->s->>'groupId','')='') then raise exception 'DEAN_ROWS_REQUIRED';end if;
 if exists(select 1 from jsonb_each(p_document->'mapping') m where coalesce(m.value->>'userId','')<>'' group by m.value->>'userId' having count(*)>1) then raise exception 'DEAN_ROSTER_INVALID';end if;
 select jsonb_agg(row order by row->>'sourceId',row->>'date',row->>'groupId') into expected from (
 select jsonb_build_object('sourceId',e->>'id','groupId',p_document->'mapping'->s->>'groupId','userIds',jsonb_agg(p_document->'mapping'->s->>'userId' order by p_document->'mapping'->s->>'userId'),
 'subject',e->>'course','teacher',e->>'teacher','teacherIds',e->'teacherIds','activity',e->>'activity','date',to_char(first_day+((w::int-1)*7+(e->>'day')::int-1),'YYYY-MM-DD'),'period',(e->>'period')::int,'room',coalesce(e->>'room','')) row
 from jsonb_array_elements(p_document->'source'->'events') e,jsonb_array_elements_text(e->'weeks') w,jsonb_array_elements_text(e->'studentIds') s
 group by e,w,p_document->'mapping'->s->>'groupId') x;
 select jsonb_agg(row order by row->>'sourceId',row->>'date',row->>'groupId') into actual from (
 select (r-'userIds')||jsonb_build_object('userIds',(select jsonb_agg(v order by v) from jsonb_array_elements_text(r->'userIds') v),'room',coalesce(r->>'room','')) row from jsonb_array_elements(p_document->'rows') r) x;
 if expected is distinct from actual then raise exception 'DEAN_PROJECTION_MISMATCH';end if;
 if exists(select 1 from jsonb_array_elements(p_document->'rows') r join dean_private.lessons l on l.lesson_date=(r->>'date')::date and l.period=(r->>'period')::int and l.room=r->>'room' where l.draft_id<>p_draft and coalesce(r->>'room','')<>'') then raise exception 'DEAN_ROOM_CONFLICT';end if;
 return dean_private.validate_rows_previous(p_document,p_draft);
end $$;
alter table dean_private.lessons add column room text not null default '';
create function dean_private.lesson_room() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select coalesce(e->>'room','') into new.room from dean_private.drafts d,jsonb_array_elements(d.document->'source'->'events') e where d.id=new.draft_id and e->>'id'=new.source_id;
 new.room:=coalesce(new.room,'');return new;
end $$;
create trigger dean_lesson_room before insert on dean_private.lessons for each row execute function dean_private.lesson_room();
revoke all on function dean_private.validate_rows(jsonb,uuid),dean_private.lesson_room() from public,anon,authenticated;

create or replace function dean_private.personal_lessons(p_group uuid,p_after uuid) returns jsonb
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
   room location,null::text online_url,created_by,true dean_managed
  from dean_private.lessons where group_id=p_group and auth.uid()=any(user_ids) and (p_after is null or id>p_after) order by id limit 500
 ) x; return result;
end $$;

alter table dean_private.drafts add column teacher_published_revision integer;
create table dean_private.teacher_lessons (
 draft_id uuid not null references dean_private.drafts(id),user_id uuid not null references public.profiles(id),
 source_id text not null,lesson_date date not null,period integer not null,course text not null,activity text not null,room text not null,
 primary key(draft_id,user_id,source_id,lesson_date)
);
create index dean_teacher_calendar on dean_private.teacher_lessons(user_id,lesson_date,period);
alter table dean_private.teacher_lessons enable row level security;
revoke all on dean_private.teacher_lessons from public,anon,authenticated;
create function dean_private.teacher_delivery(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d dean_private.drafts; doc jsonb; first_day date; count_rows integer;
begin
 if p_action='read' then
  if not dean_private.session_valid(false) then raise exception 'DEAN_MEMBER_REQUIRED';end if;
  return (select coalesce(jsonb_agg(to_jsonb(x) order by lesson_date,period),'[]') from (select source_id,lesson_date,period,course,activity,room from dean_private.teacher_lessons where user_id=auth.uid() and lesson_date between current_date-14 and current_date+370 order by lesson_date,period limit 5000) x);
 end if;
 perform dean_private.workspace('catalog','{}');
 if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED';end if;
 if p_action='catalog' then return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.full_name) order by p.full_name),'[]') from public.profiles p where exists(select 1 from public.teaching_courses c where c.owner_id=p.id) or exists(select 1 from public.teaching_course_teachers t where t.user_id=p.id and t.status='accepted'));end if;
 if p_action<>'publish' then raise exception 'DEAN_ACTION_INVALID';end if;
 perform pg_advisory_xact_lock(22112026,3);
 select * into d from dean_private.drafts where id=(p_payload->>'id')::uuid for update;
 if d.id is null or d.revision is distinct from (p_payload->>'revision')::int then raise exception 'DEAN_STALE_VERSION';end if;
 if p_payload->>'confirmation' is distinct from ('ВИКЛАДАЧАМ '||d.revision) then raise exception 'DEAN_CONFIRMATION_REQUIRED';end if;
 if not exists(select 1 from dean_private.main_schedules where draft_id=d.id and revision=d.revision and document=d.document) then raise exception 'DEAN_MAIN_REQUIRED';end if;
 doc:=d.document;perform dean_private.validate_source(doc->'source',doc->'settings',true);
 if coalesce(doc->>'monday','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'DEAN_DATE_INVALID';end if;
 first_day:=(doc->>'monday')::date;
 if extract(isodow from first_day)<>1 then raise exception 'DEAN_DATE_INVALID';end if;
 if exists(select 1 from jsonb_array_elements(doc->'source'->'events') e,jsonb_array_elements_text(e->'teacherIds') t where not exists(select 1 from public.profiles p where p.id::text=doc->'teacherMapping'->>t and (exists(select 1 from public.teaching_courses c where c.owner_id=p.id) or exists(select 1 from public.teaching_course_teachers ct where ct.user_id=p.id and ct.status='accepted')))) then raise exception 'DEAN_TEACHER_MAPPING_REQUIRED';end if;
 if exists(select 1 from jsonb_array_elements(doc->'source'->'events') e,jsonb_array_elements_text(e->'teacherIds') t,jsonb_array_elements_text(e->'weeks') w group by doc->'teacherMapping'->>t,w,e->>'day',e->>'period' having count(distinct e->>'id')>1) then raise exception 'DEAN_TEACHER_CONFLICT';end if;
 if exists(select 1 from jsonb_array_elements(doc->'source'->'events') e,jsonb_array_elements_text(e->'teacherIds') t,jsonb_array_elements_text(e->'weeks') w join dean_private.teacher_lessons l on l.draft_id<>d.id where l.user_id::text=doc->'teacherMapping'->>t and l.lesson_date=first_day+((w::int-1)*7+(e->>'day')::int-1) and l.period=(e->>'period')::int) then raise exception 'DEAN_TEACHER_CONFLICT';end if;
 insert into dean_private.teacher_lessons(draft_id,user_id,source_id,lesson_date,period,course,activity,room)
 select distinct d.id,(doc->'teacherMapping'->>t)::uuid,e->>'id',first_day+((w::int-1)*7+(e->>'day')::int-1),(e->>'period')::int,e->>'course',e->>'activity',coalesce(e->>'room','')
 from jsonb_array_elements(doc->'source'->'events') e,jsonb_array_elements_text(e->'teacherIds') t,jsonb_array_elements_text(e->'weeks') w on conflict do nothing;
 get diagnostics count_rows=row_count;
 update dean_private.drafts set teacher_published_revision=revision where id=d.id;
 insert into dean_private.audit(actor,action,draft_id,revision)values(auth.uid(),'publish_teachers',d.id,d.revision);
 return jsonb_build_object('ok',true,'lessons',count_rows);
end $$;
create function public.xelay_dean_teacher_delivery(p_action text,p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select dean_private.teacher_delivery(p_action,p_payload)$$;
revoke all on function dean_private.teacher_delivery(text,jsonb),public.xelay_dean_teacher_delivery(text,jsonb) from public,anon,authenticated;
grant execute on function dean_private.teacher_delivery(text,jsonb),public.xelay_dean_teacher_delivery(text,jsonb) to authenticated;

commit;
