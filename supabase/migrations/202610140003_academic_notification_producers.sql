-- Future academic/team events only. Delivery is handled by the existing email
-- outbox; this migration never sends mail or broadcasts historical content.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $academic_notifications_preflight$
begin
  if to_regclass('public.notifications') is null
    or to_regclass('public.notification_email_outbox') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_long_term_tasks') is null
    or to_regclass('public.study_group_materials') is null
    or to_regclass('public.study_group_seminars') is null
    or to_regclass('public.study_group_seminar_questions') is null
    or to_regclass('public.study_group_seminar_teams') is null
    or to_regclass('public.study_group_seminar_schedule') is null
    or to_regclass('public.study_group_timetable_photos') is null
    or to_regclass('public.shared_organizer_workspaces') is null
    or to_regclass('public.shared_organizer_invitations') is null
    or to_regclass('public.shared_organizer_members') is null
    or to_regclass('public.shared_organizer_tasks') is null
    or to_regprocedure('public.xelay_teaching_is_backend_write()') is null
    or not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='notifications' and column_name='type' and data_type in('text','character varying'))
    or not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='study_group_long_term_tasks' and column_name='resource_attachments') then
    raise exception 'ACADEMIC_NOTIFICATION_PREREQUISITES_MISSING'
      using hint='Apply study-group resources, shared organizers, classroom workflow and the notification email queue migration first. No changes were made.';
  end if;
end;
$academic_notifications_preflight$;

alter table public.notifications
  add column if not exists academic_event_key text,
  add column if not exists academic_tab text,
  add column if not exists shared_organizer_workspace_id uuid references public.shared_organizer_workspaces(id) on delete cascade,
  add column if not exists shared_organizer_invitation_id uuid references public.shared_organizer_invitations(id) on delete cascade;
create unique index if not exists notifications_academic_event_unique
  on public.notifications(recipient_id,academic_event_key) where academic_event_key is not null;
alter table public.notifications drop constraint if exists notifications_academic_context_check;
alter table public.notifications add constraint notifications_academic_context_check check(
  (academic_event_key is null and academic_tab is null
    and shared_organizer_workspace_id is null and shared_organizer_invitation_id is null
    and coalesce(type,'') not in('study_group_update','shared_organizer_invite','shared_organizer_update'))
  or(academic_event_key is not null and type is not null and length(academic_event_key) between 1 and 240 and(
    (type in('study_group_update','group_homework') and study_group_id is not null
      and academic_tab is not null and academic_tab in('schedule','seminars','timetable','materials')
      and shared_organizer_workspace_id is null and shared_organizer_invitation_id is null)
    or(type in('shared_organizer_invite','shared_organizer_update')
      and shared_organizer_workspace_id is not null and study_group_id is null and academic_tab is null
      and(type<>'shared_organizer_invite' or shared_organizer_invitation_id is not null)))));

-- An authenticated browser cannot fabricate events, recipients, or email jobs
-- through permissive legacy notification INSERT/UPDATE policies.
drop policy if exists "Academic notifications server insert boundary" on public.notifications;
create policy "Academic notifications server insert boundary" on public.notifications as restrictive
  for insert to anon,authenticated with check(
    academic_event_key is null and academic_tab is null and shared_organizer_workspace_id is null
    and shared_organizer_invitation_id is null
    and coalesce(type,'') not in('study_group_update','shared_organizer_invite','shared_organizer_update'));
create or replace function public.xelay_guard_academic_notification_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if public.xelay_teaching_is_backend_write() then return new; end if;
  if old.academic_event_key is not null then
    if(to_jsonb(new)-'is_read') is distinct from(to_jsonb(old)-'is_read') then
      raise exception 'ACADEMIC_NOTIFICATION_IMMUTABLE' using errcode='42501'; end if;
  elsif new.academic_event_key is distinct from old.academic_event_key
    or new.academic_tab is distinct from old.academic_tab
    or new.shared_organizer_workspace_id is distinct from old.shared_organizer_workspace_id
    or new.shared_organizer_invitation_id is distinct from old.shared_organizer_invitation_id
    or new.type in('study_group_update','shared_organizer_invite','shared_organizer_update') then
    raise exception 'ACADEMIC_NOTIFICATION_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists academic_notification_update_guard on public.notifications;
create trigger academic_notification_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_academic_notification_update();

-- Only trigger owners call this helper. Representatives are an audience even
-- when their group has no separate owner membership row; pending members never
-- receive private academic updates. The editor receives no self-notification.
create or replace function public.xelay_private_notify_group_event(
  p_group uuid,p_event text,p_message text,p_tab text,p_actor uuid,p_type text default 'study_group_update'
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_actor is null or p_group is null or p_type not in('study_group_update','group_homework')
    or p_tab not in('schedule','seminars','timetable','materials') then return; end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,
    study_group_id,academic_event_key,academic_tab)
  select audience.user_id,p_actor,coalesce(nullif(p.full_name,''),'Xelay'),p_type,left(p_message,1000),false,
    p_group,p_event,p_tab
  from(
    select g.representative_id as user_id from public.study_groups g where g.id=p_group
    union
    select m.user_id from public.study_group_members m join public.study_groups g on g.id=m.group_id
      where m.group_id=p_group and m.status='accepted'
  ) audience
  join auth.users u on u.id=audience.user_id and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()
  left join public.profiles p on p.id=p_actor
  where audience.user_id<>p_actor
  order by audience.user_id
  on conflict(recipient_id,academic_event_key) where academic_event_key is not null do nothing;
end $$;

-- Correct the old producer: immutable created_by identifies the first author,
-- not the deputy/representative who edits an existing assignment today.
create or replace function public.xelay_notify_study_group_homework()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_subject text; v_actor uuid:=auth.uid(); v_message text; v_homework public.study_group_homework%rowtype;
begin
  if v_actor is null then if tg_op='DELETE' then return old; end if; return new; end if;
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by']) then return new; end if;
  if tg_op='DELETE' then v_homework:=old; else v_homework:=new; end if;
  select subject into v_subject from public.study_group_schedule where id=v_homework.schedule_item_id;
  -- A parent lesson deletion already has a timetable event; its cascaded
  -- homework removals must not generate an additional notification per date.
  if tg_op='DELETE' and not found then return old; end if;
  v_message:=case when tg_op='INSERT' then 'додав(-ла)' when tg_op='DELETE' then 'видалив(-ла)' else 'оновив(-ла)' end
    ||' інформацію про заняття: '||coalesce(v_subject,'Заняття')
    ||' ('||to_char(v_homework.lesson_date,'DD.MM.YYYY')||')';
  perform public.xelay_private_notify_group_event(v_homework.group_id,
    'academic:homework:'||v_homework.id::text||':'||txid_current()::text,v_message,'schedule',v_actor,'group_homework');
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists study_group_homework_notification on public.study_group_homework;
create trigger study_group_homework_notification after insert or update or delete on public.study_group_homework
  for each row execute function public.xelay_notify_study_group_homework();

-- Resources and status are meaningful changes; cosmetic timestamp writes are
-- not. A retry/no-op save does not create another notification.
create or replace function public.xelay_notify_academic_group_content()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_message text; v_tab text; v_kind text; v_item jsonb;
begin
  if v_actor is null then if tg_op='DELETE' then return old; end if; return new; end if;
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by','create_request_id'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','create_request_id']) then return new; end if;
  v_item:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_table_name='study_group_long_term_tasks' then
    v_kind:='long-term-task'; v_tab:='schedule';
    v_message:=case when tg_op='INSERT' then 'додав(-ла) довгострокове завдання'
      when tg_op='DELETE' then 'видалив(-ла) довгострокове завдання'
      when new.closed_at is distinct from old.closed_at and new.closed_at is not null then 'закрив(-ла) довгострокове завдання'
      when new.closed_at is distinct from old.closed_at then 'повторно відкрив(-ла) довгострокове завдання'
      else 'оновив(-ла) довгострокове завдання' end||': '||(v_item->>'title');
  else
    v_kind:='material'; v_tab:='materials';
    v_message:=case when tg_op='INSERT' then 'додав(-ла)' when tg_op='DELETE' then 'видалив(-ла)' else 'оновив(-ла)' end
      ||' навчальний матеріал: '||(v_item->>'title');
  end if;
  perform public.xelay_private_notify_group_event((v_item->>'group_id')::uuid,
    'academic:'||v_kind||':'||(v_item->>'id')||':'||txid_current()::text,v_message,v_tab,v_actor);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists study_group_long_term_task_notification on public.study_group_long_term_tasks;
create trigger study_group_long_term_task_notification after insert or update or delete on public.study_group_long_term_tasks
  for each row execute function public.xelay_notify_academic_group_content();
drop trigger if exists study_group_material_notification on public.study_group_materials;
create trigger study_group_material_notification after insert or update or delete on public.study_group_materials
  for each row execute function public.xelay_notify_academic_group_content();

-- One timetable notification per group/transaction: a photo/JSON import can
-- legitimately insert many lesson rows without creating dozens of copies.
create or replace function public.xelay_notify_academic_timetable()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_group uuid;
begin
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by','updated_by','teaching_version'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','updated_by','teaching_version']) then return new; end if;
  v_group:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  perform public.xelay_private_notify_group_event(v_group,
    'academic:timetable:'||v_group::text||':'||txid_current()::text,
    'оновив(-ла) розклад навчальної групи. Перевірте час, місце та посилання на заняття.','timetable',v_actor);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists study_group_schedule_notification on public.study_group_schedule;
create trigger study_group_schedule_notification after insert or update or delete on public.study_group_schedule
  for each row execute function public.xelay_notify_academic_timetable();
drop trigger if exists study_group_seminar_schedule_notification on public.study_group_seminar_schedule;
create trigger study_group_seminar_schedule_notification after insert or update or delete on public.study_group_seminar_schedule
  for each row execute function public.xelay_notify_academic_timetable();
drop trigger if exists study_group_timetable_photo_notification on public.study_group_timetable_photos;
create trigger study_group_timetable_photo_notification after insert or update or delete on public.study_group_timetable_photos
  for each row execute function public.xelay_notify_academic_timetable();

-- Defer until all questions/teams have been saved. This also lets the existing
-- classroom RPC insert its final teaching_update first: it remains the sole
-- notification for that teacher action. Headman edits of a teacher-originated
-- seminar still notify normally when no classroom event was emitted.
create or replace function public.xelay_notify_academic_seminar()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_id uuid; v_seminar public.study_group_seminars%rowtype;
  v_event text; v_message text;
begin
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by','teaching_version'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','teaching_version']) then return new; end if;
  if tg_table_name='study_group_seminars' then
    v_id:=case when tg_op='DELETE' then old.id else new.id end;
    if tg_op='DELETE' then v_seminar:=old;
    else select * into v_seminar from public.study_group_seminars where id=v_id;
      if not found then return new; end if;
    end if;
  else
    v_id:=case when tg_op='DELETE' then old.seminar_id else new.seminar_id end;
    select * into v_seminar from public.study_group_seminars where id=v_id;
    if not found then if tg_op='DELETE' then return old; end if; return new; end if;
  end if;
  if not(tg_table_name='study_group_seminars' and tg_op='DELETE')
    and exists(select 1 from public.notifications n where n.type='teaching_update' and n.actor_id::text=v_actor::text
      and n.created_at>=transaction_timestamp()
      and n.teaching_event_key='classroom-seminar:'||v_id::text||':'||v_seminar.teaching_version::text) then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  -- Template time propagation is already covered by its timetable event.
  if tg_table_name='study_group_seminars' and tg_op='UPDATE'
    and(to_jsonb(new)-array['updated_at','created_at','created_by','teaching_version','starts_at','ends_at'])
      is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','teaching_version','starts_at','ends_at'])
    and exists(select 1 from public.notifications n where n.study_group_id=v_seminar.group_id
      and n.academic_event_key='academic:timetable:'||v_seminar.group_id::text||':'||txid_current()::text) then return new; end if;
  v_event:='academic:seminar:'||v_id::text||':'||txid_current()::text;
  v_message:=case when tg_table_name='study_group_seminars' and tg_op='INSERT' then 'додав(-ла) семінар'
    when tg_table_name='study_group_seminars' and tg_op='DELETE' then 'видалив(-ла) семінар'
    else 'оновив(-ла) семінар' end||': '||v_seminar.title||' ('||to_char(v_seminar.lesson_date,'DD.MM.YYYY')||')';
  perform public.xelay_private_notify_group_event(v_seminar.group_id,v_event,v_message,'seminars',v_actor);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists study_group_seminar_notification on public.study_group_seminars;
create constraint trigger study_group_seminar_notification after insert or update or delete on public.study_group_seminars
  deferrable initially deferred for each row execute function public.xelay_notify_academic_seminar();
drop trigger if exists study_group_seminar_question_notification on public.study_group_seminar_questions;
create constraint trigger study_group_seminar_question_notification after insert or update or delete on public.study_group_seminar_questions
  deferrable initially deferred for each row execute function public.xelay_notify_academic_seminar();
drop trigger if exists study_group_seminar_team_notification on public.study_group_seminar_teams;
create constraint trigger study_group_seminar_team_notification after insert or update or delete on public.study_group_seminar_teams
  deferrable initially deferred for each row execute function public.xelay_notify_academic_seminar();

create or replace function public.xelay_private_notify_shared_organizer_event(
  p_recipient uuid,p_actor uuid,p_workspace uuid,p_event text,p_type text,p_message text,p_invitation uuid default null
)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_actor is null or p_recipient is null or p_recipient=p_actor
    or p_type not in('shared_organizer_invite','shared_organizer_update') then return; end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,
    academic_event_key,shared_organizer_workspace_id,shared_organizer_invitation_id)
  select p_recipient,p_actor,coalesce(nullif(p.full_name,''),'Xelay'),p_type,left(p_message,1000),false,
    p_event,p_workspace,p_invitation
  from auth.users u left join public.profiles p on p.id=p_actor
  where u.id=p_recipient and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()
    and exists(select 1 from public.shared_organizer_workspaces w where w.id=p_workspace and w.archived_at is null)
  on conflict(recipient_id,academic_event_key) where academic_event_key is not null do nothing;
end $$;
create or replace function public.xelay_notify_shared_organizer_invitation()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();
begin
  if tg_op='INSERT' and new.status='pending' and new.expires_at>clock_timestamp() then
    perform public.xelay_private_notify_shared_organizer_event(new.invitee_id,v_actor,new.workspace_id,
      'shared-organizer-invite:'||new.id::text,'shared_organizer_invite',
      'запросив(-ла) вас до спільного органайзера.',new.id);
  elsif tg_op='UPDATE' and old.status='pending' and new.status in('accepted','declined') then
    perform public.xelay_private_notify_shared_organizer_event(new.inviter_id,v_actor,new.workspace_id,
      'shared-organizer-response:'||new.id::text||':'||new.status,'shared_organizer_update',
      case when new.status='accepted' then 'прийняв(-ла)' else 'відхилив(-ла)' end||' запрошення до спільного органайзера.',new.id);
  end if;
  return new;
end $$;
drop trigger if exists shared_organizer_invitation_notification on public.shared_organizer_invitations;
create trigger shared_organizer_invitation_notification after insert or update on public.shared_organizer_invitations
  for each row execute function public.xelay_notify_shared_organizer_invitation();

create or replace function public.xelay_notify_shared_organizer_task()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_workspace uuid; v_id uuid; v_recipient uuid; v_message text;
begin
  if tg_op='UPDATE' and(to_jsonb(new)-array['updated_at','created_at','created_by','updated_by'])
    is not distinct from(to_jsonb(old)-array['updated_at','created_at','created_by','updated_by']) then return new; end if;
  v_workspace:=case when tg_op='DELETE' then old.workspace_id else new.workspace_id end;
  v_id:=case when tg_op='DELETE' then old.id else new.id end;
  -- Membership/account cleanup never pretends to be a member editing a task.
  if v_actor is null or not exists(select 1 from public.shared_organizer_members m
    where m.workspace_id=v_workspace and m.user_id=v_actor) then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  v_message:=case when tg_op='INSERT' then 'додав(-ла) завдання'
    when tg_op='DELETE' then 'видалив(-ла) завдання'
    when new.completed is distinct from old.completed and new.completed then 'позначив(-ла) завдання виконаним'
    when new.completed is distinct from old.completed then 'повернув(-ла) завдання до роботи'
    else 'оновив(-ла) завдання' end||' у спільному органайзері.';
  for v_recipient in select m.user_id from public.shared_organizer_members m where m.workspace_id=v_workspace order by m.user_id loop
    perform public.xelay_private_notify_shared_organizer_event(v_recipient,v_actor,v_workspace,
      'shared-organizer-task:'||v_id::text||':'||txid_current()::text,'shared_organizer_update',v_message);
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists shared_organizer_task_notification on public.shared_organizer_tasks;
create trigger shared_organizer_task_notification after insert or update or delete on public.shared_organizer_tasks
  for each row execute function public.xelay_notify_shared_organizer_task();

-- Private organizer tables deliberately have no service-role SELECT grant.
-- A leased worker can inspect exactly its notification's eligibility, without
-- learning workspace names, tasks, members, invitations or profile data.
create or replace function public.xelay_shared_organizer_notification_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.notification_email_outbox%rowtype; v_notification public.notifications%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  select * into v_job from public.notification_email_outbox q where q.id=p_job_id
    and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp();
  if not found then return jsonb_build_object('eligible',false,'reason','lease_lost','path',null); end if;
  if v_job.notification_type not in('shared_organizer_invite','shared_organizer_update') then
    return jsonb_build_object('eligible',false,'reason','organizer_context_missing','path',null); end if;
  select * into v_notification from public.notifications n where n.id::text=v_job.notification_id;
  if not found then return jsonb_build_object('eligible',false,'reason','notification_removed','path',null); end if;
  if v_notification.type is distinct from v_job.notification_type
    or v_notification.recipient_id::text is distinct from v_job.recipient_id::text
    or v_notification.actor_id::text is distinct from v_job.actor_id::text
    or v_notification.academic_event_key is null or v_notification.shared_organizer_workspace_id is null then
    return jsonb_build_object('eligible',false,'reason','organizer_context_mismatch','path',null); end if;
  if not exists(select 1 from public.shared_organizer_workspaces w
    where w.id=v_notification.shared_organizer_workspace_id and w.archived_at is null) then
    return jsonb_build_object('eligible',false,'reason','organizer_unavailable','path',null); end if;
  v_path:='/organizer?view=shared&workspace='||v_notification.shared_organizer_workspace_id::text;
  if v_notification.type='shared_organizer_invite' then
    if not exists(select 1 from public.shared_organizer_invitations i
      where i.id=v_notification.shared_organizer_invitation_id
        and i.workspace_id=v_notification.shared_organizer_workspace_id
        and i.invitee_id::text=v_job.recipient_id::text and i.inviter_id::text=v_job.actor_id::text
        and((i.status='pending' and i.expires_at>clock_timestamp())
          or(i.status='accepted' and exists(select 1 from public.shared_organizer_members m
            where m.workspace_id=i.workspace_id and m.user_id=i.invitee_id)))) then
      return jsonb_build_object('eligible',false,'reason','organizer_invitation_unavailable','path',null); end if;
  elsif not exists(select 1 from public.shared_organizer_members m
    where m.workspace_id=v_notification.shared_organizer_workspace_id and m.user_id::text=v_job.recipient_id::text) then
    return jsonb_build_object('eligible',false,'reason','organizer_membership_removed','path',null);
  end if;
  -- Reading or accepting an invitation never cancels its event while the
  -- recipient still has access. Declined/revoked/expired invitations do not
  -- grant access; accepted invitations require a current membership.
  return jsonb_build_object('eligible',true,'reason','eligible','path',v_path);
end $$;
revoke all on function public.xelay_shared_organizer_notification_email_context(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_shared_organizer_notification_email_context(uuid,uuid) to service_role;

revoke all on function public.xelay_guard_academic_notification_update(),
  public.xelay_private_notify_group_event(uuid,text,text,text,uuid,text),
  public.xelay_notify_study_group_homework(),public.xelay_notify_academic_group_content(),
  public.xelay_notify_academic_timetable(),public.xelay_notify_academic_seminar(),
  public.xelay_private_notify_shared_organizer_event(uuid,uuid,uuid,text,text,text,uuid),
  public.xelay_notify_shared_organizer_invitation(),public.xelay_notify_shared_organizer_task()
  from public,anon,authenticated,service_role;

comment on column public.notifications.academic_event_key is
  'Server-only event identity. One event per recipient; transaction keys coalesce imports and seminar questions into one notification. No historical backfill.';
notify pgrst,'reload schema';
commit;
