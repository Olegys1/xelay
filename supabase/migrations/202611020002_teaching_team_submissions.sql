-- One canonical team work, current membership authorization, individual grades.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
alter table public.teaching_submissions add column team_id uuid references public.teaching_lab_teams(id) on delete restrict;
create unique index teaching_submission_one_team_work on public.teaching_submissions(item_id,group_id,team_id) where team_id is not null;

create function public.xelay_private_teaching_my_team(p_item uuid,p_group uuid,p_user uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select t.id from public.teaching_lab_teams t join public.teaching_items i on i.id=t.item_id and i.submission_mode='team'
    where t.item_id=p_item and t.group_id=p_group and p_user=any(t.user_ids)
      and public.xelay_classroom_student(p_item,p_group,p_user) limit 1;
$$;
create function public.xelay_private_teaching_submission_owner(p_submission public.teaching_submissions,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select case when p_submission.team_id is null then p_submission.user_id=p_user else
    p_submission.team_id=public.xelay_private_teaching_my_team(p_submission.item_id,p_submission.group_id,p_user) end;
$$;
create function public.xelay_private_teaching_required_team(p_item uuid,p_group uuid,p_user uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_team uuid;
begin
  if(select submission_mode from public.teaching_items where id=p_item)='team' then
    v_team:=public.xelay_private_teaching_my_team(p_item,p_group,p_user);
    if v_team is null then raise exception 'TEACHING_TEAM_REQUIRED';end if;
  end if;
  return v_team;
end $$;

create function public.xelay_private_notify_teaching_team_review(p_submission public.teaching_submissions,p_event text,p_message text,p_course uuid,p_group uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
  if p_submission.team_id is null then
    perform public.xelay_teaching_notify(p_submission.user_id,p_event,p_message,p_course,p_group);
  else
    for v_user in select u from public.teaching_lab_teams t,unnest(t.user_ids)u where t.id=p_submission.team_id
      and public.xelay_classroom_student(p_submission.item_id,p_submission.group_id,u) loop
      perform public.xelay_teaching_notify(v_user,p_event,p_message,p_course,p_group);
    end loop;
  end if;
end $$;

create function public.xelay_guard_teaching_team_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and(new.course_id,new.group_id) is distinct from(old.course_id,old.group_id) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
  if exists(select 1 from public.teaching_submissions where team_id=old.id)
    and(tg_op='DELETE' or new.user_ids is distinct from old.user_ids) then raise exception 'TEACHING_TEAM_HAS_SUBMISSIONS';end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger teaching_team_membership_guard before update or delete on public.teaching_lab_teams for each row execute function public.xelay_guard_teaching_team_change();
create function public.xelay_guard_teaching_submission_mode() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.kind<>'assignment' and new.submission_mode<>'individual' then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
  if tg_op='UPDATE' and new.submission_mode<>old.submission_mode and exists(select 1 from public.teaching_submissions where item_id=new.id) then raise exception 'TEACHING_TEAM_HAS_SUBMISSIONS';end if;
  return new;
end $$;
create trigger teaching_submission_mode_guard before insert or update on public.teaching_items for each row execute function public.xelay_guard_teaching_submission_mode();

create function public.xelay_private_teaching_team_members(p_team uuid,p_staff boolean default false)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id',p.id,'full_name',p.full_name)||case when p_staff then jsonb_build_object(
    'entry_id',e.id,'grade_version',coalesce(g.version,0),'published_score',g.published_score,'published_comment',g.published_comment,'published_at',g.published_at) else '{}'::jsonb end order by p.full_name),'[]'::jsonb)
    from public.teaching_lab_teams t join public.profiles p on p.id=any(t.user_ids) and public.xelay_classroom_student(t.item_id,t.group_id,p.id)
    left join public.teaching_entries e on e.course_id=t.course_id and e.group_id=t.group_id and e.user_id=p.id and e.active
    left join public.teaching_activities a on a.item_id=t.item_id and a.group_id=t.group_id
    left join public.teaching_grades g on g.activity_id=a.id and g.entry_id=e.id where t.id=p_team;
$$;

create function public.xelay_private_teaching_submission_team_json(p_submission public.teaching_submissions,p_json jsonb,p_grades boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_grade record;v_result jsonb:=p_json;
begin
  if p_submission.team_id is null then return v_result;end if;
  v_result:=v_result||jsonb_build_object('team_id',p_submission.team_id,'team_name',(select name from public.teaching_lab_teams where id=p_submission.team_id),
    'team_members',public.xelay_private_teaching_team_members(p_submission.team_id,p_grades));
  if not p_grades then
    -- Never return the uploader's individual grade to another team member.
    select g.* into v_grade from public.teaching_grades g join public.teaching_entries e on e.id=g.entry_id
      join public.teaching_activities a on a.id=g.activity_id where a.item_id=p_submission.item_id and a.group_id=p_submission.group_id and e.user_id=v_uid and g.published_at is not null;
    v_result:=v_result||jsonb_build_object('grade_id',v_grade.id,'grade_version',coalesce(v_grade.version,0),
      'grade_published_at',v_grade.published_at,'published_score',v_grade.published_score,'published_comment',coalesce(v_grade.published_comment,''));
  end if;
  return v_result;
end $$;

create function pg_temp.xelay_team_patch(p_signature text,p_old text,p_new text,p_count integer default 1)
returns void language plpgsql as $$
declare v_body text;v_count integer;v_old text:=replace(p_old,chr(13),'');v_new text:=replace(p_new,chr(13),'');
begin
  v_body:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  v_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  if v_count<>p_count then raise exception 'TEACHING_TEAM_DEPLOYMENT_DRIFT: % (% matches; expected %)',p_signature,v_count,p_count;end if;
  execute replace(v_body,v_old,v_new);
end $$;

-- Keep canonical resource verification, closing times, history and state machine.
-- The same course lock serializes all members reserving the one shared row.
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'where item_id=v_item_id and group_id=v_group and user_id=v_uid for update;',
  'where item_id=v_item_id and group_id=v_group and(case when v_item.submission_mode=''team'' then team_id=public.xelay_private_teaching_required_team(v_item_id,v_group,v_uid) else user_id=v_uid and team_id is null end) for update;');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'insert into public.teaching_submissions(id,item_id,course_id,group_id,user_id)',
  'insert into public.teaching_submissions(id,item_id,course_id,group_id,user_id,team_id)');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'values(v_id,v_item_id,v_item.course_id,v_group,v_uid) returning * into v_submission;',
  'values(v_id,v_item_id,v_item.course_id,v_group,v_uid,public.xelay_private_teaching_required_team(v_item_id,v_group,v_uid)) returning * into v_submission;');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'v_submission.user_id<>v_uid or not public.xelay_classroom_student',
  'not public.xelay_private_teaching_submission_owner(v_submission,v_uid) or not public.xelay_classroom_student');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'if p_payload ? ''score'' then',
  'if p_payload ? ''score'' and v_submission.team_id is not null then raise exception ''TEACHING_TEAM_EXPLICIT_GRADES_REQUIRED'';end if;
    if p_payload ? ''score'' then');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'perform public.xelay_teaching_notify(v_submission.user_id,''classroom-review:''',
  'perform public.xelay_private_notify_teaching_team_review(v_submission,''classroom-review:''');
select pg_temp.xelay_team_patch('public.xelay_classroom_submission_mutate(text,jsonb)',
  'and e.user_id=v_submission.user_id and s.published_at is not null;',
  'and e.user_id=v_submission.user_id and s.published_at is not null and v_submission.team_id is null;');

-- Bytes stay in the uploading member's namespace. Shared members may reuse an
-- exact previously verified descriptor, never fabricate another user's path.
select pg_temp.xelay_team_patch('public.xelay_classroom_can_upload_file(text)',
  's.user_id=auth.uid()', 'public.xelay_private_teaching_submission_owner(s,auth.uid())');
select pg_temp.xelay_team_patch('public.xelay_classroom_can_read_file(text)',
  's.user_id=auth.uid()', 'public.xelay_private_teaching_submission_owner(s,auth.uid())');
select pg_temp.xelay_team_patch('public.xelay_classroom_validate_resources(uuid,jsonb,jsonb,jsonb)',
  'or split_part(v_path,''/'',2)<>auth.uid()::text',
  'or(split_part(v_path,''/'',2)<>auth.uid()::text and not(p_prior @> jsonb_build_array(v_file)))');

alter function public.xelay_classroom_submission_json(public.teaching_submissions,boolean,boolean) rename to xelay_private_pre_team_submission_json;
create function public.xelay_classroom_submission_json(p_submission public.teaching_submissions,p_owner boolean,p_grades boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.xelay_private_teaching_submission_team_json(p_submission,
    public.xelay_private_pre_team_submission_json(p_submission,p_owner,p_grades),p_grades);
$$;
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  'and s.user_id=v_uid) else null end,',
  'and public.xelay_private_teaching_submission_owner(s,v_uid)) else null end,');
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  'where s.item_id=p_item_id and s.group_id=p_group_id and(v_staff or s.user_id=v_uid)',
  'where s.item_id=p_item_id and s.group_id=p_group_id and(v_staff or public.xelay_private_teaching_submission_owner(s,v_uid))');
-- Shared feedback history is available, individual historic scores are not.
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  'case when s.user_id=v_uid or ''grades''=any(v_permissions) then h.score else null end',
  'case when(s.user_id=v_uid and s.team_id is null) or ''grades''=any(v_permissions) then h.score else null end',2);
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  '''permissions'',v_permissions,',
  '''my_team'',case when v_student then(select jsonb_build_object(''id'',t.id,''name'',t.name,''members'',public.xelay_private_teaching_team_members(t.id,false)) from public.teaching_lab_teams t where t.id=public.xelay_private_teaching_my_team(p_item_id,p_group_id,v_uid)) else null end,
    ''permissions'',v_permissions,');
-- A team student not yet placed by the teacher can read the instructions, but
-- cannot reserve or submit on behalf of an unspecified team.
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  '''can_save_draft'',v_student and v_course.archived_at is null,',
  '''can_save_draft'',v_student and v_course.archived_at is null and(v_item.submission_mode<>''team'' or public.xelay_private_teaching_my_team(p_item_id,p_group_id,v_uid) is not null),');
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  '''can_submit'',v_student and v_course.archived_at is null',
  '''can_submit'',v_student and v_course.archived_at is null and(v_item.submission_mode<>''team'' or public.xelay_private_teaching_my_team(p_item_id,p_group_id,v_uid) is not null)');
-- Recheck accepted recipients for the roster, rather than showing excluded
-- classmates to an assignment-only colleague through the submission screen.
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment(uuid,uuid)',
  'where public.xelay_teaching_is_member(p_group_id,p.id)',
  'where public.xelay_classroom_student(p_item_id,p_group_id,p.id)');
-- Course roster entries are needed for the explicit team-grade preview.
select pg_temp.xelay_team_patch('public.xelay_teaching_audience_mutate(text,jsonb)',
  'if p_action=''save_subgroup'' then
      insert into',
  'perform public.xelay_teaching_sync_roster(v_course,v_group);
    if p_action=''save_subgroup'' then
      insert into');
-- Shared-group edit forks preserve the original team's work, not a new copy.
select pg_temp.xelay_team_patch('public.xelay_classroom_assignment_mutate(text,jsonb)',
  'update public.teaching_submissions set item_id=v_id,updated_at=now(),version=version+1 where item_id=v_source.id and group_id=v_group;',
  'update public.teaching_lab_teams set item_id=v_id,updated_at=clock_timestamp(),version=version+1 where item_id=v_source.id and group_id=v_group;
      update public.teaching_items set submission_mode=v_source.submission_mode where id=v_id;
      update public.teaching_submissions set item_id=v_id,updated_at=now(),version=version+1 where item_id=v_source.id and group_id=v_group;');

create function public.xelay_private_grade_team_submission(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_submission public.teaching_submissions%rowtype;v_team public.teaching_lab_teams%rowtype;
  v_activity public.teaching_activities%rowtype;v_entry public.teaching_entries%rowtype;v_grade public.teaching_grades%rowtype;
  v_receipt public.classroom_request_receipts%rowtype;v_version integer:=(p_payload->>'version')::integer;v_score numeric;v_feedback text:=coalesce(p_payload->>'feedback','');
  v_result jsonb;v_rows jsonb:='[]';v_user uuid;v_count integer:=0;
begin
  if nullif(p_payload->>'expected_user_id','')::uuid is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000
    or p_payload->'confirm_team' is distinct from 'true'::jsonb or jsonb_typeof(p_payload->'grade_versions') is distinct from 'object'
    or jsonb_typeof(p_payload->'score') is distinct from 'number' or length(v_feedback)>3000
    or jsonb_typeof(p_payload->'publish') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT';end if;
  select * into v_submission from public.teaching_submissions where id=(p_payload->>'id')::uuid;
  if not found or v_submission.team_id is null then raise exception 'TEACHING_NOT_FOUND';end if;
  perform public.xelay_classroom_lock_group(v_submission.course_id,v_submission.group_id,'grades');
  if not public.xelay_teaching_can_read_item(v_submission.item_id,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:classroom-request:'||v_uid||':grade_team_submission:'||v_submission.id,0));
  select * into v_receipt from public.classroom_request_receipts where user_id=v_uid and action='grade_team_submission' and request_id=v_submission.id and expected_version=v_version;
  if found then
    if v_receipt.payload is distinct from p_payload then raise exception 'TEACHING_CONFLICT';end if;
    return v_receipt.result;
  end if;
  select * into v_submission from public.teaching_submissions where id=v_submission.id for update;
  if v_submission.version is distinct from v_version then raise exception 'TEACHING_CONFLICT';end if;
  if v_submission.status not in('submitted','reviewed') then raise exception 'CLASSROOM_WORK_LOCKED';end if;
  select * into v_team from public.teaching_lab_teams where id=v_submission.team_id for update;
  select * into v_activity from public.teaching_activities where item_id=v_submission.item_id and group_id=v_submission.group_id for update;
  if not found then raise exception 'CLASSROOM_ASSIGNMENT_NOT_ASSESSED';end if;
  v_score:=(p_payload->>'score')::numeric;
  if v_score<0 or v_score>v_activity.max_points or scale(v_score)>2 then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform public.xelay_teaching_sync_roster(v_submission.course_id,v_submission.group_id);
  for v_entry in select * from public.teaching_entries e where e.course_id=v_submission.course_id and e.group_id=v_submission.group_id
    and e.active and e.user_id=any(v_team.user_ids) and public.xelay_classroom_student(v_submission.item_id,v_submission.group_id,e.user_id) order by e.id for update loop
    v_count:=v_count+1;
    if not(p_payload->'grade_versions'?v_entry.id::text) then raise exception 'TEACHING_CONFLICT';end if;
    select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id for update;
    if(p_payload->'grade_versions'->>v_entry.id::text)::integer is distinct from coalesce(v_grade.version,0) then raise exception 'TEACHING_CONFLICT';end if;
    v_result:=public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity.id,'entry_id',v_entry.id,'score',v_score,
      'comment',v_feedback,'reason',coalesce(p_payload->>'reason',''),'version',coalesce(v_grade.version,0)));
    v_rows:=v_rows||jsonb_build_array(jsonb_build_object('entry_id',v_entry.id,'version',(v_result->>'version')::integer));
  end loop;
  if v_count=0 or v_count<>(select count(*) from jsonb_object_keys(p_payload->'grade_versions')) then raise exception 'TEACHING_CONFLICT';end if;
  if(p_payload->>'publish')::boolean then
    perform public.xelay_teaching_mutate('publish_grades',jsonb_build_object('activity_id',v_activity.id,'expected_versions',v_rows));
  end if;
  update public.teaching_submissions set status='reviewed',feedback=v_feedback,reviewed_by=v_uid,reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    where id=v_submission.id returning * into v_submission;
  perform public.xelay_classroom_write_history(v_submission,'reviewed',null);
  perform public.xelay_private_notify_teaching_team_review(v_submission,'classroom-review:'||v_submission.id||':'||v_submission.version,
    'Викладач перевірив командну роботу. Відповідь доступна в завданні.',v_submission.course_id,v_submission.group_id);
  v_result:=jsonb_build_object('id',v_submission.id,'version',v_submission.version);
  insert into public.classroom_request_receipts(user_id,action,request_id,expected_version,payload,result)
    values(v_uid,'grade_team_submission',v_submission.id,v_version,p_payload,v_result);
  return v_result;
end $$;
-- Preserve canonical facade, especially current permission checks before replay.
alter function public.xelay_classroom_mutate(text,jsonb) rename to xelay_private_pre_team_classroom_mutate;
create function public.xelay_classroom_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_teaching_assert_user();
  if p_action='grade_team_submission' then return public.xelay_private_grade_team_submission(p_payload);end if;
  return public.xelay_private_pre_team_classroom_mutate(p_action,p_payload);
end $$;
revoke all on function public.xelay_private_teaching_my_team(uuid,uuid,uuid),public.xelay_private_teaching_submission_owner(public.teaching_submissions,uuid),
  public.xelay_private_teaching_required_team(uuid,uuid,uuid),public.xelay_guard_teaching_team_change(),public.xelay_guard_teaching_submission_mode(),
  public.xelay_private_notify_teaching_team_review(public.teaching_submissions,text,text,uuid,uuid),
  public.xelay_private_teaching_team_members(uuid,boolean),public.xelay_private_teaching_submission_team_json(public.teaching_submissions,jsonb,boolean),
  public.xelay_classroom_submission_json(public.teaching_submissions,boolean,boolean),public.xelay_private_grade_team_submission(jsonb),
  public.xelay_private_pre_team_classroom_mutate(text,jsonb),public.xelay_classroom_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_classroom_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
