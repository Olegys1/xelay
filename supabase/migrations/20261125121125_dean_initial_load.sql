begin;
set local lock_timeout='5s';

-- The same gate as workspace_previous; no changes to authentication or roles.
create function dean_private.require_access() returns void language plpgsql security definer set search_path='' as $$
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501';end if;
 if exists(select 1 from dean_private.staff where user_id=auth.uid() and not enabled)
 or (not dean_private.is_admin() and not dean_private.staff_enabled(auth.uid())
 and not exists(select 1 from dean_private.access where user_id=auth.uid()))
 then raise exception 'DEAN_ACCESS_DENIED' using errcode='42501';end if;
end $$;
revoke all on function dean_private.require_access() from public,anon,authenticated;

create or replace function dean_private.workspace(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d dean_private.drafts; root dean_private.drafts; main dean_private.main_schedules; n dean_private.drafts; result jsonb;
begin
 -- Check current session, MFA and access without assembling group rosters.
 perform dean_private.require_access();
 if p_action in('teacher_catalog','teacher_publish') then return dean_private.teacher_delivery(case when p_action='teacher_catalog' then 'catalog' else 'publish' end,p_payload);end if;
 if p_action='bootstrap' then
  result:=dean_private.workspace('list','{}');
  return jsonb_build_object('admin',dean_private.is_admin(),'drafts',result,
   'draft',case when jsonb_array_length(result)>0 then dean_private.workspace('load',jsonb_build_object('id',result->0->>'id')) else null end);
 end if;
 if p_action in('load','main','main_summary') then
  -- Read committed snapshots; opening a calendar must never take write locks.
  select * into d from dean_private.drafts where id=(p_payload->>'id')::uuid;
  if d.id is null or not dean_private.can_read_draft(d.id) then raise exception 'DEAN_DRAFT_DENIED';end if;
  if p_action='load' then return to_jsonb(d);end if;
  if not dean_private.can_read_draft(d.workspace_id) then return '{"main":null,"canSelect":false}'::jsonb;end if;
  if p_action='main_summary' then
   select jsonb_build_object('draft_id',m.draft_id,'revision',m.revision,'version',m.version,'title',m.title,'selected_at',m.selected_at)
   into result from dean_private.main_schedules m where m.workspace_id=d.workspace_id;
  else
   select to_jsonb(m) into result from dean_private.main_schedules m where m.workspace_id=d.workspace_id;
  end if;
  return jsonb_build_object('main',result,'canSelect',true);
 end if;
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

commit;
