-- Local-reviewed notification center. No historical notifications are relabeled
-- mandatory, no historical email jobs are reactivated and no provider is called.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.notification_preferences add column category_settings jsonb not null default '{}'::jsonb;
alter table public.notifications add column category_key text not null default 'community',
  add column acknowledgement_required boolean not null default false,
  add column announcement_id uuid,
  add column announcement_version integer;
alter table public.teaching_announcements add column requires_acknowledgement boolean not null default false;
alter table public.notifications add constraint notification_center_announcement_pair check
  ((announcement_id is null)=(announcement_version is null) and (announcement_version is null or announcement_version>0));
create index notification_center_feed on public.notifications(recipient_id,created_at desc,id desc);
create index notification_center_required on public.notifications(recipient_id,created_at desc,id desc) where acknowledgement_required;

create table public.notification_acknowledgements(
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  acknowledged_at timestamptz not null default clock_timestamp()
);
create table public.notification_email_digest_batches(
  id uuid primary key default gen_random_uuid(), recipient_id uuid not null references auth.users(id) on delete cascade,
  bucket_date date not null, notification_id uuid unique references public.notifications(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(), frozen_at timestamptz,
  frozen_notification_ids uuid[], frozen_summary jsonb,
  unique(recipient_id,bucket_date)
);
create table public.notification_email_digest_entries(
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  batch_id uuid not null references public.notification_email_digest_batches(id) on delete cascade,
  category_key text not null, created_at timestamptz not null default clock_timestamp()
);
alter table public.notification_acknowledgements enable row level security;
alter table public.notification_email_digest_batches enable row level security;
alter table public.notification_email_digest_entries enable row level security;
revoke all on public.notification_acknowledgements,public.notification_email_digest_batches,public.notification_email_digest_entries from public,anon,authenticated,service_role;

create function public.xelay_private_notification_categories() returns text[] language sql immutable set search_path='' as $$
 select array['schedule','assignments','tests','grades','teacher_messages','groups','messages','news','organizer','account','community']::text[];
$$;
create function public.xelay_private_notification_category(p_notice public.notifications) returns text language sql immutable set search_path='' as $$
 select case
 when p_notice.type='study_group_update' and p_notice.academic_tab='timetable' then 'schedule'
 when p_notice.type in('group_homework','academic_deadline') then 'assignments'
 when p_notice.type='teaching_update' and p_notice.teaching_event_key like 'teaching-announcement:%' then 'teacher_messages'
 when p_notice.type='teaching_update' and p_notice.teaching_event_key like 'teaching-test-%' then 'tests'
 when p_notice.type='teaching_update' and (p_notice.teaching_event_key like 'teaching-grade:%' or p_notice.teaching_event_key like 'classroom-review:%' or p_notice.teaching_event_key like 'grade-request:%') then 'grades'
 when p_notice.type='teaching_update' and (p_notice.teaching_event_key like 'teaching-deadline:%' or p_notice.teaching_event_key like 'teaching-item:%' or p_notice.teaching_event_key like 'classroom-submit:%' or p_notice.teaching_event_key like 'teaching-extension:%') then 'assignments'
 when p_notice.type='teaching_followup' then 'assignments'
 when p_notice.type='teaching_update' and (p_notice.teaching_event_key like 'teacher-review:%' or p_notice.teaching_event_key like 'teacher-request:%') then 'account'
 when p_notice.type in('message','connection_request','connection_accepted') or p_notice.chat_space_id is not null then 'messages'
 when p_notice.type like '%organizer%' then 'organizer'
 when p_notice.news_post_id is not null or p_notice.type like 'news_%' or p_notice.type like 'editor_request_%' then 'news'
 when p_notice.study_group_id is not null or p_notice.type in('group_invite','class_rep_approved','class_rep_rejected') then 'groups'
 when p_notice.type='teaching_update' then 'account'
 else 'community' end;
$$;
create function public.xelay_private_notification_settings_valid(p_settings jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare v_key text;v_value jsonb;
begin
 if jsonb_typeof(p_settings) is distinct from 'object' then return false;end if;
 for v_key,v_value in select * from jsonb_each(p_settings) loop
   if not v_key=any(public.xelay_private_notification_categories()) or jsonb_typeof(v_value) is distinct from 'object'
    or jsonb_typeof(v_value->'in_app') is distinct from 'boolean' or v_value->>'email' is null
    or v_value->>'email' not in('immediate','daily','off') or v_value-array['in_app','email']<>'{}'::jsonb then return false;end if;
 end loop;return true;
end $$;
alter table public.notification_preferences add constraint notification_center_settings_valid check(jsonb_typeof(category_settings)='object' and octet_length(category_settings::text)<=10000);
create function public.xelay_guard_notification_settings() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not public.xelay_private_notification_settings_valid(new.category_settings) then raise exception 'NOTIFICATION_INVALID_INPUT';end if;
 return new;
end $$;
create trigger notification_center_settings_guard before insert or update of category_settings on public.notification_preferences for each row execute function public.xelay_guard_notification_settings();

-- Producer gates must not discard an event before its independently enabled
-- channel can route it. In-app-only gifts and the separately opted-in weekly
-- digest use explicit channels; their frequency and eligibility stay intact.
create function public.xelay_private_notification_channel_enabled(p_user uuid,p_category text,p_channel text default 'any')
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select
   (p_channel in('any','in_app') and p.notifications_enabled and coalesce((p.category_settings->p_category->>'in_app')::boolean,true))
   or(p_channel in('any','email') and p.email_notifications_enabled and coalesce(p.category_settings->p_category->>'email','immediate')<>'off')
  from public.notification_preferences p where p.user_id=p_user),true);
$$;

-- Metadata is assigned only by trusted producers and immutable even when a
-- legacy UPDATE policy permits the recipient to change is_read.
create function public.xelay_classify_notification_center() returns trigger language plpgsql security definer set search_path='' as $$
declare v_announcement public.teaching_announcements%rowtype;
begin
 if tg_op='UPDATE' then
  if(new.category_key,new.acknowledgement_required,new.announcement_id,new.announcement_version)
    is distinct from(old.category_key,old.acknowledgement_required,old.announcement_id,old.announcement_version)
    then raise exception 'NOTIFICATION_METADATA_IMMUTABLE' using errcode='42501';end if;
  return new;
 end if;
 new.category_key:=public.xelay_private_notification_category(new);
 new.acknowledgement_required:=false;new.announcement_id:=null;new.announcement_version:=null;
 if new.type='teaching_update' and new.teaching_event_key ~ '^teaching-announcement:[0-9a-f-]{36}:[0-9]+$' then
  select * into v_announcement from public.teaching_announcements where id=split_part(new.teaching_event_key,':',2)::uuid
    and version::text=split_part(new.teaching_event_key,':',3) and course_id=new.teaching_course_id and deleted_at is null;
  if found then new.announcement_id:=v_announcement.id;new.announcement_version:=v_announcement.version;
    new.acknowledgement_required:=v_announcement.requires_acknowledgement;end if;
 elsif new.type='study_group_update' and new.academic_tab='timetable' and new.delivery_priority='urgent' then
  new.acknowledgement_required:=true;
 elsif new.type='group_homework' and new.delivery_priority='urgent' then new.acknowledgement_required:=true;
 elsif new.type='teaching_update' and (new.teaching_event_key ~ '^teaching-deadline:[0-9a-f-]{36}:[0-9]+$'
   or new.teaching_event_key ~ '^teaching-test-admission:[0-9a-f-]{36}:[0-9]+:[0-9a-f-]{36}$'
   or new.teaching_event_key like 'teacher-review:%') then new.acknowledgement_required:=true;
 end if;
 return new;
end $$;
-- Alphabetical ordering puts classification after existing priority handling.
create trigger notification_z_center_metadata before insert or update on public.notifications for each row execute function public.xelay_classify_notification_center();

create function public.xelay_private_notification_current(p_notice public.notifications) returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_a public.teaching_announcements%rowtype;v_space public.chat_spaces%rowtype;v_member public.chat_members%rowtype;
begin
 if not exists(select 1 from auth.users u where u.id=p_notice.recipient_id::uuid and u.deleted_at is null
   and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp()) then return false;end if;
 if p_notice.announcement_id is not null then
  select * into v_a from public.teaching_announcements where id=p_notice.announcement_id and version=p_notice.announcement_version and deleted_at is null;
  return found and v_a.course_id=p_notice.teaching_course_id
   and exists(select 1 from public.teaching_courses c where c.id=v_a.course_id and c.archived_at is null)
   and 'assignments'=any(public.xelay_teaching_group_permissions(v_a.course_id,p_notice.study_group_id,v_a.created_by))
   and exists(select 1 from jsonb_array_elements(v_a.targets)t
   where(t->>'group_id')::uuid=p_notice.study_group_id and public.xelay_private_teaching_audience_allows(v_a.course_id,p_notice.study_group_id,coalesce(t->>'audience_mode','all'),
    array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),array(select value::uuid from jsonb_array_elements_text(coalesce(t->'team_ids','[]'))),p_notice.recipient_id::uuid));
 end if;
 if p_notice.type='teaching_update' and p_notice.teaching_event_key ~ '^teaching-test-admission:[0-9a-f-]{36}:[0-9]+:[0-9a-f-]{36}$' then
  return split_part(p_notice.teaching_event_key,':',4)=p_notice.recipient_id::text and exists(select 1 from public.teaching_tests t
   join public.teaching_courses c on c.id=t.course_id and c.archived_at is null
   where t.id=split_part(p_notice.teaching_event_key,':',2)::uuid and t.version::text=split_part(p_notice.teaching_event_key,':',3)
    and t.status<>'draft' and t.course_id=p_notice.teaching_course_id and exists(select 1 from jsonb_array_elements(t.targets)x
      where(x->>'group_id')::uuid=p_notice.study_group_id and public.xelay_private_teaching_audience_allows(t.course_id,p_notice.study_group_id,coalesce(x->>'audience_mode','all'),
        array(select value::uuid from jsonb_array_elements_text(coalesce(x->'subgroup_ids','[]'))),'{}',p_notice.recipient_id::uuid)));
 end if;
 if p_notice.type='teaching_update' and p_notice.teaching_event_key ~ '^teaching-test-published:[0-9a-f-]{36}:[0-9]+$' then
  -- A publication remains useful after edits, but never after unpublishing,
  -- course revocation or removal from its actual current target audience.
  return exists(select 1 from public.teaching_tests t join public.teaching_courses c on c.id=t.course_id and c.archived_at is null
   where t.id=split_part(p_notice.teaching_event_key,':',2)::uuid and t.status='published' and t.course_id=p_notice.teaching_course_id
    and exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=p_notice.study_group_id
      and public.xelay_private_teaching_audience_allows(t.course_id,p_notice.study_group_id,coalesce(x->>'audience_mode','all'),
        array(select value::uuid from jsonb_array_elements_text(coalesce(x->'subgroup_ids','[]'))),'{}',p_notice.recipient_id::uuid)));
 end if;
 if p_notice.type='teaching_update' and p_notice.teaching_event_key ~ '^teaching-deadline:[0-9a-f-]{36}:[0-9]+$' then
  return exists(select 1 from public.teaching_items i join public.teaching_courses c on c.id=i.course_id and c.archived_at is null
    where i.id=split_part(p_notice.teaching_event_key,':',2)::uuid and i.version::text=split_part(p_notice.teaching_event_key,':',3)
      and i.course_id=p_notice.teaching_course_id and i.status='published' and i.withdrawn_at is null
      and public.xelay_classroom_student(i.id,p_notice.study_group_id,p_notice.recipient_id::uuid));
 end if;
 if p_notice.type='message' then
  return exists(select 1 from public.messages m join public.conversations c on c.id=m.conversation_id
   where m.id=p_notice.direct_message_id and m.conversation_id=p_notice.direct_conversation_id and m.sender_id=p_notice.actor_id::uuid
    and m.recipient_id=p_notice.recipient_id::uuid and m.deleted_at is null and exists(select 1 from public.connection_requests r where r.status='accepted'
      and least(r.requester_id,r.recipient_id)=c.user_one_id and greatest(r.requester_id,r.recipient_id)=c.user_two_id));
 end if;
 if p_notice.chat_space_id is not null then
  select * into v_space from public.chat_spaces where id=p_notice.chat_space_id;
  if not found then return false;end if;
  select * into v_member from public.chat_members where space_id=v_space.id and user_id=p_notice.recipient_id::uuid;
  if v_member.status='banned' then return false;end if;
  if p_notice.type='chat_invite' then return v_space.system_kind is null and exists(select 1 from public.chat_invitations i
    where i.space_id=v_space.id and i.user_id=p_notice.recipient_id::uuid and i.invited_by=p_notice.actor_id::uuid
      and(i.status='pending' or(i.status='accepted' and v_member.status='active')));end if;
  if v_member.status is distinct from 'active' then return false;end if;
  if v_space.system_kind is not null and(v_space.system_kind<>'faculty' or not exists(select 1 from public.profiles p
    join public.universities u on u.id=v_space.university_id and u.is_active
    join public.academic_units a on a.id=v_space.academic_unit_id and a.university_id=v_space.university_id and a.is_active
    where p.id=p_notice.recipient_id::uuid and p.university_id=v_space.university_id and p.academic_unit_id=v_space.academic_unit_id)) then return false;end if;
  if p_notice.type='chat_join_request' then return v_member.role in('owner','admin') and exists(select 1 from public.chat_join_requests r
    where r.space_id=v_space.id and r.user_id=p_notice.actor_id::uuid and r.status in('pending','accepted','rejected'));end if;
  if p_notice.type='chat_join_approved' then return exists(select 1 from public.chat_join_requests r where r.space_id=v_space.id
    and r.user_id=p_notice.recipient_id::uuid and r.status='accepted');end if;
  return true;
 end if;
 if p_notice.type in('shared_organizer_invite','shared_organizer_update') then
  if not exists(select 1 from public.shared_organizer_workspaces w where w.id=p_notice.shared_organizer_workspace_id and w.archived_at is null) then return false;end if;
  if p_notice.type='shared_organizer_invite' then return exists(select 1 from public.shared_organizer_invitations i
    where i.id=p_notice.shared_organizer_invitation_id and i.workspace_id=p_notice.shared_organizer_workspace_id and i.invitee_id=p_notice.recipient_id::uuid
      and i.inviter_id=p_notice.actor_id::uuid and((i.status='pending' and i.expires_at>clock_timestamp()) or(i.status='accepted'
        and exists(select 1 from public.shared_organizer_members m where m.workspace_id=i.workspace_id and m.user_id=i.invitee_id))));end if;
  return exists(select 1 from public.shared_organizer_members m where m.workspace_id=p_notice.shared_organizer_workspace_id and m.user_id=p_notice.recipient_id::uuid);
 end if;
 if p_notice.study_group_id is not null and p_notice.type not in('group_invite')
  and not(p_notice.type='teaching_update' and p_notice.teaching_event_key like 'teaching-%invite:%') then
  return public.xelay_teaching_is_member(p_notice.study_group_id,p_notice.recipient_id::uuid)
    or(p_notice.teaching_course_id is not null and cardinality(public.xelay_teaching_group_permissions(p_notice.teaching_course_id,p_notice.study_group_id,p_notice.recipient_id::uuid))>0);
 end if;
 if p_notice.type='notification_digest' then return false;end if;
 return true;
end $$;
create function public.xelay_private_notification_in_app(p_notice public.notifications) returns boolean language sql stable security definer set search_path='' as $$
 select p_notice.acknowledgement_required or coalesce((select p.notifications_enabled and coalesce((p.category_settings->(case when p_notice.category_key='community' then public.xelay_private_notification_category(p_notice) else p_notice.category_key end)->>'in_app')::boolean,true)
  from public.notification_preferences p where p.user_id=p_notice.recipient_id::uuid),true);
$$;
create function public.xelay_private_notification_email_mode(p_notice public.notifications) returns text language sql stable security definer set search_path='' as $$
 select case when p_notice.type='notification_digest' then 'immediate'
  when not public.xelay_private_notification_current(p_notice) then 'off'
  when p_notice.acknowledgement_required then 'immediate'
  when p_notice.chat_space_id is not null and exists(select 1 from public.chat_members m where m.space_id=p_notice.chat_space_id and m.user_id=p_notice.recipient_id::uuid and m.muted) then 'off'
  else coalesce((select case when not p.email_notifications_enabled then 'off'
   else coalesce(p.category_settings->(case when p_notice.category_key='community' then public.xelay_private_notification_category(p_notice) else p_notice.category_key end)->>'email','immediate') end from public.notification_preferences p where p.user_id=p_notice.recipient_id::uuid),'immediate') end;
$$;
create function public.xelay_notification_preferences_save(p_settings jsonb,p_expected_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_saved public.notification_preferences%rowtype;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'NOTIFICATION_ACTOR_CHANGED';end if;
 if jsonb_typeof(p_settings) is distinct from 'object' or p_settings-array['notifications_enabled','email_notifications_enabled','category_settings']<>'{}'::jsonb
  or jsonb_typeof(p_settings->'notifications_enabled') is distinct from 'boolean' or jsonb_typeof(p_settings->'email_notifications_enabled') is distinct from 'boolean'
  or not public.xelay_private_notification_settings_valid(p_settings->'category_settings') then raise exception 'NOTIFICATION_INVALID_INPUT';end if;
 insert into public.notification_preferences(user_id,notifications_enabled,email_notifications_enabled,category_settings)
  values(v_uid,(p_settings->>'notifications_enabled')::boolean,(p_settings->>'email_notifications_enabled')::boolean,p_settings->'category_settings')
 on conflict(user_id) do update set notifications_enabled=excluded.notifications_enabled,email_notifications_enabled=excluded.email_notifications_enabled,category_settings=excluded.category_settings
 returning * into v_saved;return to_jsonb(v_saved);
end $$;

create function public.xelay_private_notification_json(p_notice public.notifications) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(p_notice)||jsonb_build_object('category_key',case when p_notice.category_key='community' then public.xelay_private_notification_category(p_notice) else p_notice.category_key end,
 'acknowledged_at',(select a.acknowledged_at from public.notification_acknowledgements a where a.notification_id=p_notice.id),
 'group_name',case when p_notice.study_group_id is not null and public.xelay_teaching_is_member(p_notice.study_group_id,p_notice.recipient_id::uuid)
  then(select group_name from public.study_groups where id=p_notice.study_group_id) end,
 'course_title',case when p_notice.teaching_course_id is not null and exists(select 1 from public.teaching_course_groups g where g.course_id=p_notice.teaching_course_id and g.status='accepted'
  and(public.xelay_teaching_is_member(g.group_id,p_notice.recipient_id::uuid) or cardinality(public.xelay_teaching_group_permissions(g.course_id,g.group_id,p_notice.recipient_id::uuid))>0))
 then(select title from public.teaching_courses where id=p_notice.teaching_course_id) end);
$$;
create function public.xelay_notification_center(p_filters jsonb,p_cursor jsonb,p_limit integer,p_expected_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_view text:=coalesce(p_filters->>'view','all');v_category text:=coalesce(p_filters->>'category','all');
 v_group uuid;v_course uuid;v_period text:=coalesce(p_filters->>'period','all');v_search text:=coalesce(p_filters->>'search','');v_since timestamptz;
 v_cursor_at timestamptz;v_cursor_id uuid;v_items jsonb;v_required jsonb;v_options_groups jsonb;v_options_courses jsonb;v_unread int;v_badge int;v_required_count int;v_more boolean;v_next jsonb;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'NOTIFICATION_ACTOR_CHANGED';end if;
 if jsonb_typeof(p_filters) is distinct from 'object' or p_filters-array['view','category','group_id','course_id','period','search']<>'{}'::jsonb
  or v_view not in('all','unread','required','urgent') or not(v_category='all' or v_category=any(public.xelay_private_notification_categories()))
  or v_period not in('all','today','week','month') or length(v_search)>160 or p_limit is null or p_limit not between 1 and 100 then raise exception 'NOTIFICATION_INVALID_INPUT';end if;
 begin
  v_group:=nullif(p_filters->>'group_id','')::uuid;v_course:=nullif(p_filters->>'course_id','')::uuid;
  if p_cursor is not null and p_cursor<>'null'::jsonb then
   if jsonb_typeof(p_cursor) is distinct from 'object' or p_cursor-array['created_at','id']<>'{}'::jsonb or p_cursor->>'id' is null or p_cursor->>'created_at' is null then raise exception 'NOTIFICATION_INVALID_INPUT';end if;
   v_cursor_at:=(p_cursor->>'created_at')::timestamptz;v_cursor_id:=(p_cursor->>'id')::uuid;
  end if;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'NOTIFICATION_INVALID_INPUT';end;
 v_since:=case v_period when 'today' then date_trunc('day',statement_timestamp() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv'
  when 'week' then statement_timestamp()-interval '7 days' when 'month' then statement_timestamp()-interval '30 days' else '-infinity'::timestamptz end;
 with own as materialized(select n.*,a.acknowledged_at,case when n.category_key='community' then public.xelay_private_notification_category(n) else n.category_key end effective_category
  from public.notifications n left join public.notification_acknowledgements a on a.notification_id=n.id
  where n.recipient_id::uuid=v_uid and n.type<>'notification_digest' and public.xelay_private_notification_current(n)),
 filtered as materialized(select o.* from own o where
  (v_view='required' and o.acknowledgement_required and o.acknowledged_at is null or v_view<>'required' and not(o.acknowledgement_required and o.acknowledged_at is null))
  and(v_view<>'unread' or not o.is_read) and(v_view<>'urgent' or o.delivery_priority='urgent')
  and(v_category='all' or o.effective_category=v_category) and(v_group is null or o.study_group_id=v_group) and(v_course is null or o.teaching_course_id=v_course)
  and o.created_at>=v_since and(v_search='' or strpos(lower(coalesce(o.message,'')||' '||coalesce(o.actor_name,'')),lower(v_search))>0)
  and(v_cursor_at is null or(o.created_at,o.id)<(v_cursor_at,v_cursor_id))),
 page as materialized(select f.id from filtered f order by f.created_at desc,f.id desc limit p_limit)
 select coalesce((select jsonb_agg(public.xelay_private_notification_json(n) order by n.created_at desc,n.id desc) from public.notifications n join page p on p.id=n.id),'[]'),
  case when v_view='required' then '[]'::jsonb else coalesce((select jsonb_agg(public.xelay_private_notification_json(n) order by n.created_at desc,n.id desc)
   from public.notifications n where n.id in(select o.id from own o where o.acknowledgement_required and o.acknowledged_at is null order by o.created_at desc,o.id desc limit 20)),'[]') end,
  (select count(*)::int from own o where not o.is_read and public.xelay_private_notification_in_app((select n from public.notifications n where n.id=o.id))),
  (select count(*)::int from own o where o.acknowledgement_required and o.acknowledged_at is null),
  (select count(*)::int from own o where(o.acknowledgement_required and o.acknowledged_at is null) or(not o.is_read and public.xelay_private_notification_in_app((select n from public.notifications n where n.id=o.id)))),
  (select count(*)>p_limit from filtered),
  (select jsonb_build_object('created_at',o.created_at,'id',o.id) from own o join page p on p.id=o.id order by o.created_at,o.id limit 1),
  coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name) order by g.group_name) from public.study_groups g where g.id in(select distinct study_group_id from own)
    and(public.xelay_teaching_is_member(g.id,v_uid) or exists(select 1 from public.teaching_course_groups c where c.group_id=g.id and cardinality(public.xelay_teaching_group_permissions(c.course_id,g.id,v_uid))>0))),'[]'),
  coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title) order by c.title) from public.teaching_courses c where c.id in(select distinct teaching_course_id from own)
   and exists(select 1 from public.teaching_course_groups g where g.course_id=c.id and g.status='accepted' and(public.xelay_teaching_is_member(g.group_id,v_uid) or cardinality(public.xelay_teaching_group_permissions(c.id,g.group_id,v_uid))>0))),'[]')
 into v_items,v_required,v_unread,v_required_count,v_badge,v_more,v_next,v_options_groups,v_options_courses;
 return jsonb_build_object('items',v_items,'required_items',v_required,'unread_count',v_unread,'required_count',v_required_count,'badge_count',v_badge,
  'has_more',v_more,'next_cursor',case when v_more then v_next else null end,'groups',v_options_groups,'courses',v_options_courses);
end $$;
create function public.xelay_notification_counts(p_expected_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'NOTIFICATION_ACTOR_CHANGED';end if;
 select jsonb_build_object('unread_count',count(*) filter(where not n.is_read and public.xelay_private_notification_in_app(n)),
  'required_count',count(*) filter(where n.acknowledgement_required and a.notification_id is null),
  'badge_count',count(*) filter(where(n.acknowledgement_required and a.notification_id is null) or(not n.is_read and public.xelay_private_notification_in_app(n)))) into v_result
 from public.notifications n left join public.notification_acknowledgements a on a.notification_id=n.id
 where n.recipient_id::uuid=v_uid and n.type<>'notification_digest' and public.xelay_private_notification_current(n);
 return v_result;
end $$;
create function public.xelay_notification_mark_read(p_ids uuid[],p_expected_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_count int;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'NOTIFICATION_ACTOR_CHANGED';end if;
 if p_ids is null or cardinality(p_ids)>100 then raise exception 'NOTIFICATION_INVALID_INPUT';end if;
 if exists(select 1 from unnest(p_ids)i where not exists(select 1 from public.notifications n where n.id=i and n.recipient_id::uuid=v_uid)) then raise exception 'NOTIFICATION_FORBIDDEN' using errcode='42501';end if;
 update public.notifications set is_read=true where id=any(p_ids) and recipient_id::uuid=v_uid and not is_read;
 get diagnostics v_count=row_count;return jsonb_build_object('read_count',v_count);
end $$;
create function public.xelay_notification_acknowledge(p_notification_id uuid,p_expected_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_notice public.notifications%rowtype;v_at timestamptz;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'NOTIFICATION_ACTOR_CHANGED';end if;
 select * into v_notice from public.notifications where id=p_notification_id and recipient_id::uuid=v_uid for update;
 if not found or not v_notice.acknowledgement_required or not public.xelay_private_notification_current(v_notice) then raise exception 'NOTIFICATION_FORBIDDEN' using errcode='42501';end if;
 insert into public.notification_acknowledgements(notification_id,recipient_id) values(v_notice.id,v_uid) on conflict do nothing;
 select acknowledged_at into v_at from public.notification_acknowledgements where notification_id=v_notice.id;
 update public.notifications set is_read=true where id=v_notice.id and not is_read;
 return jsonb_build_object('id',v_notice.id,'acknowledged_at',v_at,'is_read',true);
end $$;

-- Reuse existing author, scope, membership, lock and version checks. Only the
-- announcement's opt-in flag is added before its canonical notification loop.
do $announcement_patch$
declare v_source text;v_old text;v_new text;
begin
 select pg_get_functiondef('public.xelay_teaching_audience_mutate(text,jsonb)'::regprocedure) into v_source;
 v_old:='insert into public.teaching_announcements(id,course_id,title,body,targets,created_by) values(v_id,v_course,btrim(p_payload->>''title''),btrim(p_payload->>''body''),p_payload->''targets'',v_uid)';
 v_new:='if p_payload ? ''requires_acknowledgement'' and jsonb_typeof(p_payload->''requires_acknowledgement'') is distinct from ''boolean'' then raise exception ''TEACHING_INVALID_INPUT'';end if;'||chr(10)||
  'if v_announcement.id is not null and (v_announcement.title,v_announcement.body,v_announcement.targets,v_announcement.requires_acknowledgement) is not distinct from (btrim(p_payload->>''title''),btrim(p_payload->>''body''),p_payload->''targets'',coalesce((p_payload->>''requires_acknowledgement'')::boolean,v_announcement.requires_acknowledgement,false)) then return jsonb_build_object(''id'',v_announcement.id,''version'',v_announcement.version);end if;'||chr(10)||
  'insert into public.teaching_announcements(id,course_id,title,body,targets,created_by,requires_acknowledgement) values(v_id,v_course,btrim(p_payload->>''title''),btrim(p_payload->>''body''),p_payload->''targets'',v_uid,coalesce((p_payload->>''requires_acknowledgement'')::boolean,v_announcement.requires_acknowledgement,false))';
 if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_ANNOUNCEMENT_SOURCE_CHANGED';end if;
 v_source:=replace(v_source,v_old,v_new);
 v_old:='body=excluded.body,targets=excluded.targets,version=public.teaching_announcements.version+1';
 if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_ANNOUNCEMENT_SOURCE_CHANGED';end if;
 execute replace(v_source,v_old,'body=excluded.body,targets=excluded.targets,requires_acknowledgement=excluded.requires_acknowledgement,version=public.teaching_announcements.version+1');
end $announcement_patch$;

create function public.xelay_teaching_announcement_audience(p_course_id uuid,p_targets jsonb,p_expected_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_target jsonb;v_count int;v_groups jsonb;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED';end if;
 if not public.xelay_teaching_is_verified(v_uid) or not public.xelay_teaching_has_current_access(v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
 if jsonb_typeof(p_targets) is distinct from 'array' or jsonb_array_length(p_targets) not between 1 and 100
  or jsonb_array_length(p_targets)<>(select count(distinct t->>'group_id') from jsonb_array_elements(p_targets)t) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
 for v_target in select value from jsonb_array_elements(p_targets) loop
  if not 'assignments'=any(public.xelay_teaching_group_permissions(p_course_id,(v_target->>'group_id')::uuid,v_uid)) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_private_validate_teaching_audience(p_course_id,null,v_target);
 end loop;
 with recipients as materialized(select p.id,(t->>'group_id')::uuid group_id from public.profiles p,jsonb_array_elements(p_targets)t
  join public.teaching_course_groups l on l.course_id=p_course_id and l.group_id=(t->>'group_id')::uuid and l.status='accepted'
  where p.id<>v_uid and exists(select 1 from auth.users u where u.id=p.id and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp())
  and public.xelay_private_teaching_audience_allows(p_course_id,(t->>'group_id')::uuid,coalesce(t->>'audience_mode','all'),
   array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),array(select value::uuid from jsonb_array_elements_text(coalesce(t->'team_ids','[]'))),p.id))
 select(select count(distinct id)::int from recipients),coalesce((select jsonb_agg(jsonb_build_object('group_id',group_id,'count',n) order by group_id) from(select group_id,count(distinct id)::int n from recipients group by group_id)g),'[]') into v_count,v_groups;
 return jsonb_build_object('recipient_count',v_count,'group_counts',v_groups);
end $$;
create function public.xelay_teaching_announcement_receipts(p_announcement_id uuid,p_expected_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_a public.teaching_announcements%rowtype;v_rows jsonb;v_total int;v_ack int;
begin
 if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED';end if;
 select * into v_a from public.teaching_announcements where id=p_announcement_id and deleted_at is null;
 if not found or not public.xelay_teaching_is_verified(v_uid) or not public.xelay_teaching_has_current_access(v_uid)
  or not exists(select 1 from jsonb_array_elements(v_a.targets)t where 'assignments'=any(public.xelay_teaching_group_permissions(v_a.course_id,(t->>'group_id')::uuid,v_uid)))
  then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
 with permitted as materialized(select n.recipient_id::uuid user_id,n.study_group_id group_id,p.full_name,a.acknowledged_at
  from public.notifications n join public.profiles p on p.id=n.recipient_id::uuid left join public.notification_acknowledgements a on a.notification_id=n.id
  where n.announcement_id=v_a.id and n.announcement_version=v_a.version and n.acknowledgement_required
   and 'assignments'=any(public.xelay_teaching_group_permissions(v_a.course_id,n.study_group_id,v_uid)) and public.xelay_private_notification_current(n))
 select coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'full_name',full_name,'group_id',group_id,'acknowledged_at',acknowledged_at) order by full_name),'[]'),count(*)::int,count(acknowledged_at)::int into v_rows,v_total,v_ack from permitted;
 return jsonb_build_object('id',v_a.id,'version',v_a.version,'total',v_total,'acknowledged',v_ack,'recipients',v_rows);
end $$;
-- Keep the existing student audience projection, adding only the caller's own
-- receipt and current revision's notification id.
alter function public.xelay_teaching_group_announcements(uuid) rename to xelay_private_group_announcements_before_center_20261105;
create function public.xelay_teaching_group_announcements(p_group_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_data jsonb;v_rows jsonb;
begin
 v_data:=public.xelay_private_group_announcements_before_center_20261105(p_group_id);
 select coalesce(jsonb_agg(item||jsonb_build_object('requires_acknowledgement',a.requires_acknowledgement,'notification_id',n.id,'acknowledged_at',r.acknowledged_at) order by item->>'created_at' desc),'[]') into v_rows
 from jsonb_array_elements(v_data->'announcements')item join public.teaching_announcements a on a.id=(item->>'id')::uuid
 left join public.notifications n on n.announcement_id=a.id and n.announcement_version=a.version and n.recipient_id::uuid=v_uid
 left join public.notification_acknowledgements r on r.notification_id=n.id;
 return jsonb_build_object('announcements',v_rows);
end $$;

create function public.xelay_private_queue_notification_digest(p_notice public.notifications) returns void language plpgsql security definer set search_path='' as $$
declare v_batch public.notification_email_digest_batches%rowtype;v_date date:=(clock_timestamp() at time zone 'Europe/Kyiv')::date;v_id uuid;v_due timestamptz;v_try int;
begin
 if p_notice.type='notification_digest' or p_notice.acknowledgement_required then return;end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay-email-'||p_notice.recipient_id::text,0));
 if exists(select 1 from public.notification_email_digest_entries where notification_id=p_notice.id) then return;end if;
 for v_try in 1..31 loop
  insert into public.notification_email_digest_batches(recipient_id,bucket_date) values(p_notice.recipient_id::uuid,v_date) on conflict do nothing;
  select * into v_batch from public.notification_email_digest_batches where recipient_id=p_notice.recipient_id::uuid and bucket_date=v_date for update;
  exit when v_batch.frozen_at is null;v_date:=v_date+1;
 end loop;
 if v_batch.frozen_at is not null then return;end if;
 if v_batch.notification_id is null then
  v_id:=gen_random_uuid();
  insert into public.notifications(id,recipient_id,actor_id,actor_name,type,message,is_read)
   values(v_id,p_notice.recipient_id,p_notice.recipient_id,'Xelay','notification_digest','Ваш підсумок сповіщень готовий.',true);
  update public.notification_email_digest_batches set notification_id=v_id where id=v_batch.id;
  v_batch.notification_id:=v_id;
  v_due:=((v_date+1)::timestamp+interval '9 hours') at time zone 'Europe/Kyiv';
  update public.notification_email_outbox set available_at=v_due where notification_id=v_id::text and status='pending';
 end if;
 insert into public.notification_email_digest_entries(notification_id,batch_id,category_key) values(p_notice.id,v_batch.id,case when p_notice.category_key='community' then public.xelay_private_notification_category(p_notice) else p_notice.category_key end) on conflict do nothing;
end $$;

-- Preserve every source guard (including gift/no-email exclusions) and the
-- existing queue's event key/lease/retry protocol. Change only routing policy.
do $queue_patch$
declare v_source text;v_old text;v_matches integer;
begin
 select replace(pg_get_functiondef('public.xelay_queue_notification_email()'::regprocedure),chr(13),'') into v_source;
 -- Known live source has one-space indentation and the platform-news email
 -- suppression. Patch only this exact policy expression, never its whole body.
 v_old:='if not coalesce\(v_preferences\.notifications_enabled,true\)\s+or not coalesce\(v_preferences\.email_notifications_enabled,true\) then return new; end if;';
 select count(*) into v_matches from regexp_matches(v_source,v_old,'g');
 if v_matches<>1 then raise exception 'NOTIFICATION_QUEUE_SOURCE_CHANGED';end if;
 v_source:=regexp_replace(v_source,v_old,'if public.xelay_private_notification_email_mode(new)=''off'' then return new;end if;'||chr(10)||
  'if public.xelay_private_notification_email_mode(new)=''daily'' then perform public.xelay_private_queue_notification_digest(new);return new;end if;');
 execute v_source;
 select replace(pg_get_functiondef('public.xelay_private_notification_email_message_state(uuid)'::regprocedure),chr(13),'') into v_source;
 v_old:='if exists(select 1 from public.notification_preferences p where p.user_id=v_job.recipient_id'||chr(10)||
  '    and(not p.notifications_enabled or not p.email_notifications_enabled)) then';
 if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_MESSAGE_CONTEXT_SOURCE_CHANGED';end if;
 execute replace(v_source,v_old,'if public.xelay_private_notification_email_mode(v_notification)=''off'' then');
end $queue_patch$;

-- Keep the exact legacy producer locks, caps, suppression receipts and source
-- eligibility. Only replace the coupled global-channel predicates.
do $producer_channels$
declare v_source text;v_old text;v_signature text;
begin
 foreach v_signature in array array['public.xelay_queue_academic_deadline_reminders()',
   'public.xelay_private_queue_teaching_followups(timestamp with time zone)'] loop
  select replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'') into v_source;
  v_old:='where coalesce(p.notifications_enabled,true)';
  if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_PRODUCER_SOURCE_CHANGED: %',v_signature;end if;
  execute replace(v_source,v_old,'where public.xelay_private_notification_channel_enabled(d.recipient_id,''assignments'')');
 end loop;
 v_signature:='public.xelay_private_dispatch_organizer_reminders(uuid,integer)';
 select replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'') into v_source;
 v_old:='and not exists(select 1 from public.notification_preferences pref'||chr(10)||'        where pref.user_id=t.user_id and pref.notifications_enabled is false)';
 if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_ORGANIZER_SOURCE_CHANGED';end if;
 v_source:=replace(v_source,v_old,'and public.xelay_private_notification_channel_enabled(t.user_id,''organizer'')');
 v_old:='select notifications_enabled into v_enabled from public.notification_preferences where user_id=v_task.user_id;'||chr(10)||'    if not coalesce(v_enabled,true) then continue; end if;';
 if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_ORGANIZER_RECHECK_CHANGED';end if;
 execute replace(v_source,v_old,'if not public.xelay_private_notification_channel_enabled(v_task.user_id,''organizer'') then continue;end if;');

 -- Birthdays deliberately have no email route, regardless of ordinary email
 -- settings. The feature exists in production but not older focused fixtures.
 if to_regprocedure('public.xelay_private_birthday_notification_recipient(uuid,timestamp with time zone)') is not null then
  select replace(pg_get_functiondef('public.xelay_private_birthday_notification_recipient(uuid,timestamp with time zone)'::regprocedure),chr(13),'') into v_source;
  v_old:='coalesce(('||chr(10)||'    select p.notifications_enabled from public.notification_preferences p where p.user_id::text=p_user::text),true)';
  if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_BIRTHDAY_SOURCE_CHANGED';end if;
  execute replace(v_source,v_old,'public.xelay_private_notification_channel_enabled(p_user,''groups'',''in_app'')');
 end if;
 -- Weekly opportunities retain their own opt-in, outbox and cadence. Ordinary
 -- email on/off applies; in-app attention can no longer suppress that email.
 foreach v_signature in array array['public.xelay_prepare_opportunities_digest()',
   'public.xelay_opportunities_digest_context(uuid,uuid)'] loop
  -- This separate feature was never deployed in some live environments. Do
  -- not install or implicitly enable it as part of notification preferences.
  if to_regprocedure(v_signature) is null then continue;end if;
  select replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'') into v_source;
  v_old:='coalesce(n.notifications_enabled,true)';
  if strpos(v_source,v_old)=0 then raise exception 'NOTIFICATION_WEEKLY_SOURCE_CHANGED: %',v_signature;end if;
  execute replace(v_source,v_old,'public.xelay_private_notification_channel_enabled(n.user_id,''community'',''email'')');
 end loop;
end $producer_channels$;

alter function public.xelay_claim_notification_email(uuid) rename to xelay_private_claim_email_before_center_20261105;
create function public.xelay_claim_notification_email(p_job_id uuid default null)
returns table(id uuid,notification_id text,attempts integer,created_at timestamptz,lock_token uuid)
language plpgsql security definer set search_path='' as $$
declare v_job record;v_batch public.notification_email_digest_batches%rowtype;v_ids uuid[];v_summary jsonb;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into v_job from public.xelay_private_claim_email_before_center_20261105(p_job_id);
 if not found then return;end if;
 select b.* into v_batch from public.notification_email_digest_batches b where b.notification_id::text=v_job.notification_id for update;
 if found and v_batch.frozen_at is null then
  select coalesce(array_agg(e.notification_id order by e.notification_id),'{}'::uuid[]) into v_ids
   from public.notification_email_digest_entries e join public.notifications n on n.id=e.notification_id
   where e.batch_id=v_batch.id and public.xelay_private_notification_email_mode(n)='daily' and public.xelay_private_notification_current(n);
  select jsonb_build_object('total',cardinality(v_ids),'categories',coalesce(jsonb_agg(jsonb_build_object('key',category_key,'count',n) order by category_key),'[]')) into v_summary
   from(select e.category_key,count(*)::int n from public.notification_email_digest_entries e where e.notification_id=any(v_ids) group by e.category_key)c;
  update public.notification_email_digest_batches b set frozen_at=clock_timestamp(),frozen_notification_ids=v_ids,frozen_summary=v_summary where b.id=v_batch.id;
 end if;
 return query select v_job.id::uuid,v_job.notification_id::text,v_job.attempts::integer,v_job.created_at::timestamptz,v_job.lock_token::uuid;
end $$;

create function public.xelay_notification_email_policy(p_job_id uuid,p_lock_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.notification_email_outbox%rowtype;v_notice public.notifications%rowtype;v_mode text;v_batch public.notification_email_digest_batches%rowtype;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into v_job from public.notification_email_outbox where id=p_job_id and status='processing' and lock_token=p_lock_token and locked_until>clock_timestamp();
 if not found then return jsonb_build_object('eligible',false,'required',false,'mode','off','reason','lease_lost');end if;
 select * into v_notice from public.notifications where id::text=v_job.notification_id and recipient_id::uuid=v_job.recipient_id and type=v_job.notification_type;
 if not found then return jsonb_build_object('eligible',false,'required',false,'mode','off','reason','notification_removed');end if;
 if not exists(select 1 from auth.users u where u.id=v_job.recipient_id and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null
  and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp()) then
  return jsonb_build_object('eligible',false,'required',false,'mode','off','reason','email_unverified');end if;
 if v_notice.type='notification_digest' then
  select * into v_batch from public.notification_email_digest_batches where notification_id=v_notice.id for update;
  if not found then return jsonb_build_object('eligible',false,'required',false,'mode','daily','reason','digest_missing');end if;
  -- First claim froze the item set and summary in the same transaction. If any
  -- frozen source loses permission, skip the whole summary instead of changing
  -- an ambiguously accepted provider request's idempotent message body.
  if v_batch.frozen_at is null or coalesce(cardinality(v_batch.frozen_notification_ids),0)=0
   or exists(select 1 from unnest(v_batch.frozen_notification_ids)i where not exists(select 1 from public.notifications n where n.id=i
     and public.xelay_private_notification_email_mode(n)='daily' and public.xelay_private_notification_current(n))) then
   return jsonb_build_object('eligible',false,'required',false,'mode','daily','reason','digest_empty');end if;
  return jsonb_build_object('eligible',true,'required',false,'mode','daily','reason','eligible');
 end if;
 if not public.xelay_private_notification_current(v_notice) then return jsonb_build_object('eligible',false,'required',v_notice.acknowledgement_required,'mode','off','reason','notification_unavailable');end if;
 v_mode:=public.xelay_private_notification_email_mode(v_notice);
 if v_mode='daily' then
  perform public.xelay_private_queue_notification_digest(v_notice);
  return jsonb_build_object('eligible',false,'required',false,'mode','daily','reason','digest_queued');
 end if;
 return jsonb_build_object('eligible',v_mode='immediate','required',v_notice.acknowledgement_required,'mode',v_mode,'reason',case when v_mode='off' then 'notifications_disabled' else 'eligible' end);
end $$;
create function public.xelay_notification_email_digest_context(p_job_id uuid,p_lock_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.notification_email_outbox%rowtype;v_batch public.notification_email_digest_batches%rowtype;v_categories jsonb;v_total int;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';end if;
 select * into v_job from public.notification_email_outbox where id=p_job_id and status='processing' and lock_token=p_lock_token and locked_until>clock_timestamp() and notification_type='notification_digest';
 if not found then return jsonb_build_object('eligible',false,'reason','lease_lost','total',0,'categories','[]'::jsonb);end if;
 select * into v_batch from public.notification_email_digest_batches where notification_id::text=v_job.notification_id and recipient_id=v_job.recipient_id;
 if not found or v_batch.frozen_at is null then return jsonb_build_object('eligible',false,'reason','digest_missing','total',0,'categories','[]'::jsonb);end if;
 if exists(select 1 from unnest(v_batch.frozen_notification_ids)i where not exists(select 1 from public.notifications n where n.id=i
  and public.xelay_private_notification_email_mode(n)='daily' and public.xelay_private_notification_current(n))) then
  return jsonb_build_object('eligible',false,'reason','digest_sources_changed','total',0,'categories','[]'::jsonb);end if;
 v_categories:=coalesce(v_batch.frozen_summary->'categories','[]');v_total:=coalesce((v_batch.frozen_summary->>'total')::int,0);
 return jsonb_build_object('eligible',v_total>0,'reason',case when v_total>0 then 'eligible' else 'digest_empty' end,'total',v_total,'categories',v_categories,
  'period_start',v_batch.created_at,'period_end',v_batch.frozen_at);
end $$;

-- New publications and admission changes create trusted, recipient-specific
-- events. Existing attempts, answers and grading remain entirely unchanged.
create function public.xelay_notify_test_center() returns trigger language plpgsql security definer set search_path='' as $$
declare v_target jsonb;v_recipient record;v_old jsonb;v_new jsonb;v_changed boolean;v_group uuid;
begin
 if new.status='draft' then return new;end if;
 if tg_op='INSERT' or old.status='draft' then
  for v_recipient in select p.id,min(t->>'group_id')::uuid group_id from public.profiles p,jsonb_array_elements(new.targets)t
   where public.xelay_private_teaching_audience_allows(new.course_id,(t->>'group_id')::uuid,coalesce(t->>'audience_mode','all'),
    array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),'{}',p.id) group by p.id loop
   perform public.xelay_teaching_notify(v_recipient.id,'teaching-test-published:'||new.id||':'||new.version,'Викладач опублікував тест. Перегляньте час і правила проходження.',new.course_id,v_recipient.group_id);
  end loop;
 elsif new.overrides is distinct from old.overrides then
  for v_recipient in select distinct (o->>'user_id')::uuid id from jsonb_array_elements(new.overrides||old.overrides)o loop
   select o into v_new from jsonb_array_elements(new.overrides)o where o->>'user_id'=v_recipient.id::text;
   select o into v_old from jsonb_array_elements(old.overrides)o where o->>'user_id'=v_recipient.id::text;
   v_changed:=coalesce((v_new->>'excluded')::boolean,false) is distinct from coalesce((v_old->>'excluded')::boolean,false)
    or(coalesce((v_new->>'excluded')::boolean,false) and coalesce(v_new->>'exclusion_reason','') is distinct from coalesce(v_old->>'exclusion_reason',''));
   if not v_changed then continue;end if;
   select min(t->>'group_id')::uuid into v_group from jsonb_array_elements(new.targets)t where public.xelay_private_teaching_audience_allows(new.course_id,(t->>'group_id')::uuid,coalesce(t->>'audience_mode','all'),
    array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),'{}',v_recipient.id);
   if v_group is not null then perform public.xelay_teaching_notify(v_recipient.id,'teaching-test-admission:'||new.id||':'||new.version||':'||v_recipient.id,
    'Викладач змінив ваш допуск до тесту. Перегляньте актуальні умови в Xelay.',new.course_id,v_group);end if;
  end loop;
 end if;return new;
end $$;
create trigger teaching_test_center_notify after insert or update of status,overrides on public.teaching_tests for each row execute function public.xelay_notify_test_center();

alter function public.xelay_notification_email_delivery_status() rename to xelay_private_email_status_before_center_20261105;
create function public.xelay_notification_email_delivery_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';end if;
 return public.xelay_private_email_status_before_center_20261105()||jsonb_build_object('notification_center_ready',true);
end $$;

-- Closed by default: neither internal source helpers nor receipt/digest tables
-- are made directly readable to a browser or the service worker.
revoke all on function public.xelay_private_notification_categories(),public.xelay_private_notification_category(public.notifications),
 public.xelay_private_notification_settings_valid(jsonb),public.xelay_guard_notification_settings(),public.xelay_private_notification_channel_enabled(uuid,text,text),public.xelay_classify_notification_center(),public.xelay_private_notification_current(public.notifications),
 public.xelay_private_notification_in_app(public.notifications),public.xelay_private_notification_email_mode(public.notifications),
 public.xelay_private_notification_json(public.notifications),public.xelay_private_group_announcements_before_center_20261105(uuid),
 public.xelay_private_queue_notification_digest(public.notifications),public.xelay_notify_test_center(),public.xelay_private_email_status_before_center_20261105(),
 public.xelay_private_claim_email_before_center_20261105(uuid),public.xelay_claim_notification_email(uuid),
 public.xelay_notification_center(jsonb,jsonb,integer,uuid),public.xelay_notification_counts(uuid),public.xelay_notification_mark_read(uuid[],uuid),public.xelay_notification_acknowledge(uuid,uuid),
 public.xelay_notification_preferences_save(jsonb,uuid),public.xelay_teaching_announcement_audience(uuid,jsonb,uuid),public.xelay_teaching_announcement_receipts(uuid,uuid),
 public.xelay_teaching_group_announcements(uuid),public.xelay_notification_email_policy(uuid,uuid),public.xelay_notification_email_digest_context(uuid,uuid),
 public.xelay_notification_email_delivery_status() from public,anon,authenticated,service_role;
grant execute on function public.xelay_notification_center(jsonb,jsonb,integer,uuid),public.xelay_notification_counts(uuid),public.xelay_notification_mark_read(uuid[],uuid),
 public.xelay_notification_acknowledge(uuid,uuid),public.xelay_notification_preferences_save(jsonb,uuid),public.xelay_teaching_announcement_audience(uuid,jsonb,uuid),
 public.xelay_teaching_announcement_receipts(uuid,uuid),public.xelay_teaching_group_announcements(uuid) to authenticated;
grant execute on function public.xelay_notification_email_policy(uuid,uuid),public.xelay_notification_email_digest_context(uuid,uuid),public.xelay_notification_email_delivery_status(),public.xelay_claim_notification_email(uuid) to service_role;

notify pgrst,'reload schema';
commit;
