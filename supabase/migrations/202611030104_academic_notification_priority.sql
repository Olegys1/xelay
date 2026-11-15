-- Trusted event priority. Existing notifications and queue receipts stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.notifications
  add column delivery_priority text not null default 'normal'
  check (delivery_priority in ('urgent','attention','normal'));
alter table public.notification_email_outbox
  add column delivery_priority text not null default 'normal'
  check (delivery_priority in ('urgent','attention','normal'));

create policy "Notification priority server insert" on public.notifications
  as restrictive for insert to anon,authenticated with check (delivery_priority='normal');

create function public.xelay_classify_notification_priority()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if new.delivery_priority is distinct from old.delivery_priority then
      raise exception 'NOTIFICATION_PRIORITY_IMMUTABLE' using errcode='42501';
    end if;
    return new;
  end if;
  if new.type in ('academic_deadline','teaching_followup') then
    new.delivery_priority:='attention';
  elsif new.type='teaching_update' then
    if new.teaching_event_key like 'grade-request:%' or new.teaching_event_key like 'classroom-submit:%' then
      new.delivery_priority:='attention';
    elsif new.teaching_event_key like 'teaching-extension:%' then
      new.delivery_priority:='urgent';
    elsif new.teaching_event_key ~ '^classroom-review:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+$' then
      if exists (
        select 1 from public.teaching_submissions s
        where s.id=split_part(new.teaching_event_key,':',2)::uuid
          and s.version::text=split_part(new.teaching_event_key,':',3)
          and s.course_id=new.teaching_course_id and s.group_id=new.study_group_id
          and s.status='returned'
      ) then new.delivery_priority:='urgent'; end if;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.xelay_classify_notification_priority() from public,anon,authenticated,service_role;
create trigger notification_delivery_priority before insert or update of delivery_priority on public.notifications
  for each row execute function public.xelay_classify_notification_priority();

-- Change only the ordering and priority snapshot in the installed queue.
-- Keep the exact lease, retries, duplicate suppression and provider gates.
do $queue_priority$
declare
  v_patch record;
  v_definition text;
  v_matches integer;
begin
  for v_patch in select * from (values
    ('public.xelay_queue_notification_email()',
      'event_key,\s*available_at,\s*direct_conversation_id\)',
      'event_key,available_at,direct_conversation_id,delivery_priority)'),
    ('public.xelay_queue_notification_email()',
      'clock_timestamp\(\),\s*v_conversation\)',
      'clock_timestamp(),v_conversation,new.delivery_priority)'),
    ('public.xelay_claim_notification_email(uuid)',
      'order by\s+q\.created_at,\s*q\.id\s+for update skip locked limit 100',
      $order$order by case when q.delivery_priority='urgent' or q.created_at<=statement_timestamp()-interval '2 hours' then 0
          when q.delivery_priority='attention' then 1 else 2 end,q.created_at,q.id for update skip locked limit 100$order$)
  ) as p(signature,pattern,replacement) loop
    v_definition:=pg_get_functiondef(to_regprocedure(v_patch.signature));
    select count(*) into v_matches from regexp_matches(v_definition,v_patch.pattern,'gi');
    if v_matches<>1 then raise exception 'NOTIFICATION_PRIORITY_QUEUE_SOURCE_CHANGED: %',v_patch.signature; end if;
    execute regexp_replace(v_definition,v_patch.pattern,v_patch.replacement,'i');
  end loop;
end $queue_priority$;

create function public.xelay_teaching_action_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_notice record;
  v_source uuid;
  v_eligible boolean;
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
    and q.locked_until>clock_timestamp() and q.notification_type='teaching_update';
  if not found or v_notice.study_group_id is null or v_notice.teaching_event_key is null then
    return jsonb_build_object('eligible',false,'reason','teaching_action_context_missing');
  end if;
  if not public.xelay_teaching_has_current_access(v_notice.recipient_id) then
    return jsonb_build_object('eligible',false,'reason','teaching_action_unavailable');
  end if;
  if v_notice.teaching_event_key ~ '^classroom-submit:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+$' then
    v_source:=split_part(v_notice.teaching_event_key,':',2)::uuid;
    v_eligible:=public.xelay_classroom_staff(v_notice.teaching_course_id,v_notice.study_group_id,v_notice.recipient_id)
      and exists (
        select 1 from public.teaching_submissions s
        join public.teaching_items i on i.id=s.item_id and i.status='published' and i.withdrawn_at is null
        join public.teaching_item_targets t on t.item_id=s.item_id and t.group_id=s.group_id
        where s.id=v_source and s.course_id=v_notice.teaching_course_id and s.group_id=v_notice.study_group_id
          and s.status='submitted' and s.attempt::text=split_part(v_notice.teaching_event_key,':',3)
      );
  elsif v_notice.teaching_event_key ~ '^grade-request:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
    v_source:=split_part(v_notice.teaching_event_key,':',2)::uuid;
    v_eligible:='grades'=any(public.xelay_teaching_group_permissions(v_notice.teaching_course_id,v_notice.study_group_id,v_notice.recipient_id))
      and exists (
        select 1 from public.teaching_grade_requests r
        join public.teaching_course_groups l on l.course_id=r.course_id and l.group_id=r.group_id and l.status='accepted'
        where r.id=v_source and r.course_id=v_notice.teaching_course_id and r.group_id=v_notice.study_group_id and r.status='open'
          and public.xelay_private_grade_request_activity_visible(r.activity_id)
      );
  end if;
  if not coalesce(v_eligible,false) then return jsonb_build_object('eligible',false,'reason','teaching_action_unavailable'); end if;
  return jsonb_build_object('eligible',true);
end $$;
revoke all on function public.xelay_teaching_action_email_context(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_action_email_context(uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;
