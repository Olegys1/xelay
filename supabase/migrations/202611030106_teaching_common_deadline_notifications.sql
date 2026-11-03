-- Promote a changed common assignment deadline within the existing publication
-- event. The sender and audience remain those of the canonical teaching write.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function public.xelay_private_notify_assignment_edit(
  p_item_id uuid,p_prior_item jsonb,p_prior_targets jsonb
)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_actor uuid:=auth.uid();
  v_item public.teaching_items%rowtype;
  v_course_title text;
  v_content_changed boolean;
  v_recipient record;
begin
  if v_actor is null then return; end if;
  select * into v_item from public.teaching_items i where i.id=p_item_id
    and i.kind='assignment' and i.status='published' and i.withdrawn_at is null;
  if not found then return; end if;
  select title into v_course_title from public.teaching_courses where id=v_item.course_id;
  v_content_changed:=(to_jsonb(v_item)-array['version','updated_at'])
    is distinct from (p_prior_item-array['version','updated_at']);

  for v_recipient in
    with targets as materialized (
      select t.group_id,
        p_prior_targets ? (t.group_id::text)
          and (t.due_at is distinct from ((p_prior_targets->(t.group_id::text))->>'due_at')::timestamptz) as deadline_changed,
        (to_jsonb(t)-'due_at') is distinct from ((p_prior_targets->(t.group_id::text))-'due_at') as target_changed
      from public.teaching_item_targets t where t.item_id=p_item_id
    )
    select p.id,(min(t.group_id::text) filter(where t.deadline_changed))::uuid as deadline_group
    from targets t join public.profiles p on public.xelay_classroom_student(p_item_id,t.group_id,p.id)
    where p.id<>v_actor and (t.deadline_changed or t.target_changed or v_content_changed
      or not exists(select 1 from targets where deadline_changed))
    group by p.id order by p.id
  loop
    if v_recipient.deadline_group is null then
      perform public.xelay_teaching_notify(v_recipient.id,'teaching-item:'||p_item_id::text||':'||v_item.version::text,
        'Нове або оновлене завдання з предмета «'||v_course_title||'».',v_item.course_id);
    else
      insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,
        teaching_course_id,teaching_event_key,study_group_id,delivery_priority)
      select v_recipient.id,v_actor,coalesce((select full_name from public.profiles where id=v_actor),'Xelay'),
        'teaching_update','Викладач змінив термін здачі завдання. Перегляньте актуальні умови в Xelay.',false,
        v_item.course_id,'teaching-deadline:'||p_item_id::text||':'||v_item.version::text,
        v_recipient.deadline_group,'urgent'
      where exists(select 1 from auth.users u where u.id=v_recipient.id and u.deleted_at is null
        and coalesce(u.banned_until,'-infinity'::timestamptz)<=now())
      on conflict(recipient_id,teaching_event_key) where teaching_event_key is not null do nothing;
    end if;
  end loop;
end $$;
revoke all on function public.xelay_private_notify_assignment_edit(uuid,jsonb,jsonb)
  from public,anon,authenticated,service_role;

-- Capture the pre-save state after the existing scope and optimistic lock.
-- The writer replaces all targets, so an UPDATE trigger cannot see this edit.
create function pg_temp.xelay_patch_common_deadline(p_signature text,p_pattern text,p_replacement text)
returns void language plpgsql as $$
declare v_definition text;v_count integer;
begin
  select replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'') into v_definition;
  select count(*) into v_count from regexp_matches(v_definition,p_pattern,'g');
  if v_count<>1 then raise exception 'TEACHING_COMMON_DEADLINE_SOURCE_CHANGED: % (% matches)',p_signature,v_count; end if;
  execute regexp_replace(v_definition,p_pattern,p_replacement);
end $$;

select pg_temp.xelay_patch_common_deadline('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)',
  $pattern$v_permissions text\[\];\s*v_prior jsonb;$pattern$,
  $replacement$\&
  v_deadline_prior_item jsonb;v_deadline_prior_targets jsonb;$replacement$);
select pg_temp.xelay_patch_common_deadline('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)',
  $pattern$perform public\.xelay_teaching_validate_resources\(v_course_id,coalesce\(p_payload->'links','\[\]'::jsonb\),coalesce\(p_payload->'attachments','\[\]'::jsonb\),v_prior\);$pattern$,
  $replacement$\&
    if v_kind='assignment' and v_record.status='published' and v_record.withdrawn_at is null then
      v_deadline_prior_item:=to_jsonb(v_record);
      select coalesce(jsonb_object_agg(t.group_id::text,to_jsonb(t)),'{}'::jsonb) into v_deadline_prior_targets
      from public.teaching_item_targets t where t.item_id=v_record.id;
    end if;$replacement$);
select pg_temp.xelay_patch_common_deadline('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)',
  $pattern$if v_status='published' then(\s+select \* into v_course from public\.teaching_courses where id=v_course_id;\s+for v_recipient in select distinct p\.id[^;]+;.*?end loop;)$pattern$,
  $replacement$if v_status='published' then
      if v_deadline_prior_item is not null then
        perform public.xelay_private_notify_assignment_edit(v_record.id,v_deadline_prior_item,v_deadline_prior_targets);
      else\1
      end if;$replacement$);

-- A shared publication's single-group edit forks the item and moves that
-- group's prior target before invoking the canonical writer. Keep that fork
-- published inside this transaction when the source and final write are both
-- published, so it is treated as an edit. Independent copies remain drafts.
select pg_temp.xelay_patch_common_deadline('public.xelay_classroom_assignment_mutate(text,jsonb)',
  $pattern$(v_source\.material_date,v_source\.max_points,v_source\.category,)'draft'(,v_uid,v_source\.submission_format,v_source\.work_type\);\s*insert into public\.teaching_item_targets[^\r\n]*\s+select v_id,group_id,due_at)$pattern$,
  $replacement$\1
          case when v_source.status='published' and v_source.withdrawn_at is null
            and p_payload->>'status'='published' then 'published' else 'draft' end\2$replacement$);

create function public.xelay_teaching_deadline_change_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_notice record;
  v_item_id uuid;
  v_target public.teaching_item_targets%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  select n.teaching_event_key,n.teaching_course_id,n.study_group_id,q.recipient_id into v_notice
  from public.notification_email_outbox q
  join public.notifications n on n.id::text=q.notification_id
    and n.recipient_id::text=q.recipient_id::text and n.type=q.notification_type
  join public.teaching_courses c on c.id=n.teaching_course_id and c.archived_at is null
  join auth.users u on u.id=q.recipient_id and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp()
  where q.id=p_job_id and q.lock_token=p_lock_token and q.status='processing'
    and q.locked_until>clock_timestamp() and q.notification_type='teaching_update'
    and n.delivery_priority='urgent'
    and n.teaching_event_key ~ '^teaching-deadline:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+$';
  if not found or v_notice.study_group_id is null then
    return jsonb_build_object('eligible',false,'reason','teaching_deadline_change_context_missing');
  end if;
  v_item_id:=split_part(v_notice.teaching_event_key,':',2)::uuid;
  select t.* into v_target from public.teaching_item_targets t
  join public.teaching_items i on i.id=t.item_id and i.course_id=v_notice.teaching_course_id
    and i.version::text=split_part(v_notice.teaching_event_key,':',3)
  where t.item_id=v_item_id and t.group_id=v_notice.study_group_id
    and public.xelay_classroom_student(t.item_id,t.group_id,v_notice.recipient_id);
  if not found then
    return jsonb_build_object('eligible',false,'reason','teaching_deadline_change_unavailable');
  end if;
  return jsonb_build_object('eligible',true,'group_id',v_target.group_id,'source_id',v_target.item_id,
    'due_at',v_target.due_at,'lesson_date',v_target.lesson_date);
end $$;
revoke all on function public.xelay_teaching_deadline_change_email_context(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_deadline_change_email_context(uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;
