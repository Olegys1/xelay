-- Absence is a published journal value, independent of a numerical zero.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.teaching_grades
  add column draft_absent boolean not null default false,
  add column published_absent boolean not null default false,
  add constraint teaching_grade_draft_absence_score check(not draft_absent or draft_score is null),
  add constraint teaching_grade_published_absence_score check(not published_absent or published_score is null);
alter table public.teaching_grade_audit
  add column old_absent boolean not null default false,
  add column new_absent boolean not null default false;

create function public.xelay_private_journal_grade_flags()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_context jsonb:=coalesce(nullif(current_setting('xelay.journal_grade_context',true),''),'{}')::jsonb;
begin
  if v_context->>'mode'='draft' then new.draft_absent:=coalesce((v_context->>'absent')::boolean,false);
  elsif v_context->>'mode'='publication' then new.published_absent:=new.draft_absent;end if;
  if new.draft_score is not null then new.draft_absent:=false;end if;
  if new.published_score is not null then new.published_absent:=false;end if;
  return new;
end $$;
create trigger xelay_journal_grade_flags before insert or update on public.teaching_grades
for each row execute function public.xelay_private_journal_grade_flags();

create function public.xelay_private_journal_audit_flags()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_grade public.teaching_grades%rowtype;
  v_context jsonb:=coalesce(nullif(current_setting('xelay.journal_grade_context',true),''),'{}')::jsonb;
begin
  select * into v_grade from public.teaching_grades where activity_id=new.activity_id and entry_id=new.entry_id;
  if new.event='draft' then
    new.old_absent:=coalesce(v_grade.draft_absent,false);
    new.new_absent:=coalesce((v_context->>'absent')::boolean,false);
  elsif new.event='publication' then
    new.old_absent:=coalesce(v_grade.published_absent,false);
    new.new_absent:=coalesce(v_grade.draft_absent,false);
  end if;
  return new;
end $$;
create trigger xelay_journal_audit_flags before insert on public.teaching_grade_audit
for each row execute function public.xelay_private_journal_audit_flags();

alter function public.xelay_teaching_mutate(text,jsonb) rename to xelay_teaching_mutate_before_journal_20261104;
create function public.xelay_teaching_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_before public.teaching_grades%rowtype;v_grade public.teaching_grades%rowtype;
  v_result jsonb;v_row jsonb;v_absent boolean:=false;v_context text:=current_setting('xelay.journal_grade_context',true);
  v_entry public.teaching_entries%rowtype;v_reason text;
begin
  if p_action not in('save_grade','publish_grades') then
    return public.xelay_teaching_mutate_before_journal_20261104(p_action,p_payload);
  end if;
  if p_payload?'expected_user_id' and(p_payload->>'expected_user_id')::uuid is distinct from v_uid then
    raise exception 'TEACHING_ACTOR_CHANGED';end if;
  perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);
  if p_action='save_grade' then
    if p_payload?'absent' and jsonb_typeof(p_payload->'absent') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT';end if;
    v_absent:=coalesce((p_payload->>'absent')::boolean,false);
    if v_absent and p_payload->'score' is distinct from 'null'::jsonb then raise exception 'TEACHING_INVALID_INPUT';end if;
    select * into v_before from public.teaching_grades where activity_id=(p_payload->>'activity_id')::uuid and entry_id=(p_payload->>'entry_id')::uuid for update;
    v_reason:=btrim(coalesce(p_payload->>'reason',''));
    if v_before.published_at is not null and v_absent is distinct from v_before.published_absent and length(v_reason)<2 then
      raise exception 'TEACHING_REVISION_REASON_REQUIRED';end if;
    perform set_config('xelay.journal_grade_context',jsonb_build_object('mode','draft','absent',v_absent)::text,true);
    v_result:=public.xelay_teaching_mutate_before_journal_20261104(p_action,p_payload);
    select * into v_grade from public.teaching_grades where id=(v_result->>'id')::uuid for update;
    -- The existing writer may be a no-op when only absence changed.
    if v_grade.draft_absent is distinct from v_absent then
      insert into public.teaching_grade_audit(course_id,activity_id,entry_id,actor_id,old_score,new_score,old_comment,new_comment,reason,event)
        values(v_grade.course_id,v_grade.activity_id,v_grade.entry_id,v_uid,v_grade.draft_score,v_grade.draft_score,v_grade.draft_comment,v_grade.draft_comment,v_reason,'draft');
      update public.teaching_grades set draft_absent=v_absent,updated_by=v_uid,updated_at=now(),version=version+1
        where id=v_grade.id returning * into v_grade;
    end if;
    v_result:=jsonb_build_object('id',v_grade.id,'version',v_grade.version);
  else
    perform set_config('xelay.journal_grade_context','{"mode":"publication"}',true);
    -- Original command validates every expected version, link and permission.
    v_result:=public.xelay_teaching_mutate_before_journal_20261104(p_action,p_payload);
    for v_row in select value from jsonb_array_elements(p_payload->'expected_versions') order by value->>'entry_id' loop
      select * into v_grade from public.teaching_grades where activity_id=(p_payload->>'activity_id')::uuid and entry_id=(v_row->>'entry_id')::uuid for update;
      if v_grade.draft_absent is not distinct from v_grade.published_absent then continue;end if;
      insert into public.teaching_grade_audit(course_id,activity_id,entry_id,actor_id,old_score,new_score,old_comment,new_comment,event)
        values(v_grade.course_id,v_grade.activity_id,v_grade.entry_id,v_uid,v_grade.published_score,v_grade.draft_score,v_grade.published_comment,v_grade.draft_comment,'publication');
      update public.teaching_grades set published_absent=draft_absent,published_at=now(),updated_by=v_uid,updated_at=now(),version=version+1
        where id=v_grade.id returning * into v_grade;
      select * into v_entry from public.teaching_entries where id=v_grade.entry_id;
      if v_entry.user_id is not null and public.xelay_teaching_is_member(v_entry.group_id,v_entry.user_id) then
        perform public.xelay_teaching_notify(v_entry.user_id,'teaching-grade:'||v_grade.id::text||':'||v_grade.version::text,
          'Викладач опублікував або оновив ваші бали. Перегляньте розділ «Мої бали».',v_grade.course_id,v_grade.group_id);
      end if;
    end loop;
  end if;
  perform set_config('xelay.journal_grade_context',coalesce(v_context,''),true);
  return v_result;
exception when others then
  perform set_config('xelay.journal_grade_context',coalesce(v_context,''),true);
  raise;
end $$;

-- Extend the existing atomic batch protocol while preserving its receipts.
create or replace function public.xelay_save_teaching_grades_batch(p_request_id uuid,p_course_id uuid,p_group_id uuid,p_activity_id uuid,p_expected_user_id uuid,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_activity public.teaching_activities%rowtype;v_row jsonb;v_payload jsonb;
  v_receipt public.teaching_grade_batch_receipts%rowtype;v_result jsonb;v_version text;v_entry_id uuid;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if p_request_id is null or p_course_id is null or p_group_id is null or p_activity_id is null or jsonb_typeof(p_rows) is distinct from 'array'
    or jsonb_array_length(p_rows) not between 1 and 500 or octet_length(p_rows::text)>3000000 then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-batch:'||v_uid::text||':'||p_request_id::text,0));
  perform public.xelay_private_assert_teaching_group(p_course_id,p_group_id,'grades');
  perform public.xelay_teaching_lock_course(p_course_id,'grades');
  select * into v_activity from public.teaching_activities where id=p_activity_id and course_id=p_course_id and group_id=p_group_id for update;
  if not found then raise exception 'TEACHING_NOT_FOUND';end if;
  v_payload:=jsonb_build_object('course_id',p_course_id,'group_id',p_group_id,'activity_id',p_activity_id,'rows',p_rows);
  select * into v_receipt from public.teaching_grade_batch_receipts where user_id=v_uid and request_id=p_request_id;
  if found then if v_receipt.payload is distinct from v_payload then raise exception 'TEACHING_CONFLICT';end if;return v_receipt.result;end if;
  if(select count(*) from jsonb_array_elements(p_rows)) is distinct from(select count(distinct(value->>'entry_id')::uuid) from jsonb_array_elements(p_rows)) then raise exception 'TEACHING_INVALID_INPUT';end if;
  for v_row in select value from jsonb_array_elements(p_rows) order by value->>'entry_id' loop
    if jsonb_typeof(v_row) is distinct from 'object' or(v_row-array['entry_id','score','comment','reason','version','absent'])<>'{}'::jsonb
      or jsonb_typeof(v_row->'entry_id') is distinct from 'string' or not(v_row?'score')
      or(v_row->'score'<>'null'::jsonb and jsonb_typeof(v_row->'score') is distinct from 'number')
      or jsonb_typeof(v_row->'comment') is distinct from 'string' or jsonb_typeof(v_row->'reason') is distinct from 'string'
      or jsonb_typeof(v_row->'version') is distinct from 'number'
      or(v_row?'absent' and jsonb_typeof(v_row->'absent') is distinct from 'boolean') then raise exception 'TEACHING_INVALID_INPUT';end if;
    v_version:=v_row->>'version';if v_version!~'^[0-9]{1,9}$' then raise exception 'TEACHING_INVALID_INPUT';end if;
    v_entry_id:=(v_row->>'entry_id')::uuid;
    if not exists(select 1 from public.teaching_entries where id=v_entry_id and course_id=p_course_id and group_id=p_group_id and active) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    perform public.xelay_teaching_mutate('save_grade',jsonb_build_object('course_id',p_course_id,'activity_id',p_activity_id,'entry_id',v_entry_id,
      'score',v_row->'score','comment',v_row->>'comment','reason',v_row->>'reason','version',v_version::integer,'absent',coalesce((v_row->>'absent')::boolean,false)));
  end loop;
  v_result:=jsonb_build_object('id',p_activity_id,'count',jsonb_array_length(p_rows),'request_id',p_request_id);
  insert into public.teaching_grade_batch_receipts(user_id,request_id,course_id,activity_id,payload,result) values(v_uid,p_request_id,p_course_id,p_activity_id,v_payload,v_result);
  return v_result;
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation then raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
end $$;

create function public.xelay_private_journal_values(p_data jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb:=p_data;
begin
  if jsonb_typeof(p_data->'grades')='array' then
    v_result:=jsonb_set(v_result,'{grades}',coalesce((select jsonb_agg(g||jsonb_build_object('published_absent',s.published_absent)
      ||case when g?'draft_score' then jsonb_build_object('draft_absent',s.draft_absent) else '{}'::jsonb end)
      from jsonb_array_elements(p_data->'grades')g join public.teaching_grades s on s.id=(g->>'id')::uuid),'[]'));
  end if;
  if jsonb_typeof(p_data->'audit')='array' then
    v_result:=jsonb_set(v_result,'{audit}',coalesce((select jsonb_agg(a||jsonb_build_object('old_absent',s.old_absent,'new_absent',s.new_absent))
      from jsonb_array_elements(p_data->'audit')a join public.teaching_grade_audit s on s.id=(a->>'id')::uuid),'[]'));
  end if;
  return v_result;
end $$;
alter function public.xelay_teaching_course(uuid) rename to xelay_teaching_course_before_journal_20261104;
create function public.xelay_teaching_course(p_course_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select public.xelay_private_journal_values(public.xelay_teaching_course_before_journal_20261104(p_course_id));
$$;
alter function public.xelay_teaching_group(uuid) rename to xelay_teaching_group_before_journal_20261104;
create function public.xelay_teaching_group(p_group_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select public.xelay_private_journal_values(public.xelay_teaching_group_before_journal_20261104(p_group_id));
$$;

create table public.teaching_journal_preferences(
  user_id uuid not null references public.profiles(id) on delete cascade,course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,activity_ids uuid[] not null default '{}',
  version integer not null default 1,updated_at timestamptz not null default now(),primary key(user_id,course_id,group_id)
);
alter table public.teaching_journal_preferences enable row level security;
revoke all on public.teaching_journal_preferences from public,anon,authenticated,service_role;
create function public.xelay_teaching_journal_preferences(p_course_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;
begin
  if not 'grades'=any(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  select jsonb_build_object('activity_ids',activity_ids,'version',version) into v_result from public.teaching_journal_preferences
    where user_id=v_uid and course_id=p_course_id and group_id=p_group_id;
  return coalesce(v_result,'{"activity_ids":[],"version":0}'::jsonb);
end $$;
create function public.xelay_teaching_save_journal_preferences(p_course_id uuid,p_group_id uuid,p_activity_ids uuid[],p_version integer,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_previous public.teaching_journal_preferences%rowtype;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED';end if;
  if not public.xelay_teaching_is_verified(v_uid) or not public.xelay_teaching_has_current_access(v_uid)
    or not 'grades'=any(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if p_activity_ids is null or cardinality(p_activity_ids)>500 or cardinality(p_activity_ids)<>(select count(distinct id) from unnest(p_activity_ids)id)
    or exists(select 1 from unnest(p_activity_ids) as requested(activity_id) where not exists(select 1 from public.teaching_activities a where a.id=requested.activity_id and a.course_id=p_course_id and a.group_id=p_group_id)) then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:journal-order:'||v_uid::text||':'||p_course_id::text||':'||p_group_id::text,0));
  select * into v_previous from public.teaching_journal_preferences where user_id=v_uid and course_id=p_course_id and group_id=p_group_id for update;
  if coalesce(v_previous.version,0) is distinct from p_version then raise exception 'TEACHING_CONFLICT';end if;
  if v_previous.activity_ids is not distinct from p_activity_ids then return jsonb_build_object('activity_ids',v_previous.activity_ids,'version',v_previous.version);end if;
  insert into public.teaching_journal_preferences(user_id,course_id,group_id,activity_ids) values(v_uid,p_course_id,p_group_id,p_activity_ids)
    on conflict(user_id,course_id,group_id) do update set activity_ids=excluded.activity_ids,version=teaching_journal_preferences.version+1,updated_at=now()
    returning * into v_previous;
  return jsonb_build_object('activity_ids',v_previous.activity_ids,'version',v_previous.version);
end $$;

revoke all on function public.xelay_private_journal_grade_flags(),public.xelay_private_journal_audit_flags(),public.xelay_private_journal_values(jsonb),
  public.xelay_teaching_mutate_before_journal_20261104(text,jsonb),public.xelay_teaching_course_before_journal_20261104(uuid),
  public.xelay_teaching_group_before_journal_20261104(uuid),public.xelay_teaching_mutate(text,jsonb),public.xelay_teaching_course(uuid),public.xelay_teaching_group(uuid),
  public.xelay_teaching_journal_preferences(uuid,uuid),public.xelay_teaching_save_journal_preferences(uuid,uuid,uuid[],integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_mutate(text,jsonb),public.xelay_teaching_course(uuid),public.xelay_teaching_group(uuid),
  public.xelay_teaching_journal_preferences(uuid,uuid),public.xelay_teaching_save_journal_preferences(uuid,uuid,uuid[],integer,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
