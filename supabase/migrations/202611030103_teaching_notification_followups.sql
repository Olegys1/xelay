-- Follow up on unresolved teaching work through the existing email outbox.
-- Apply before explicitly enabling the reminder schedule.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create index xelay_teaching_pending_review_age_idx
  on public.teaching_submissions(submitted_at) where status='submitted';
create index xelay_teaching_open_grade_request_age_idx
  on public.teaching_grade_requests(created_at) where status='open';

create table public.teaching_followup_receipts (
  recipient_id uuid not null references auth.users(id) on delete cascade,
  kyiv_day date not null,
  queued_at timestamptz not null,
  backlog_fingerprint text not null,
  notification_id text not null unique,
  primary key (recipient_id,kyiv_day)
);
alter table public.teaching_followup_receipts enable row level security;
revoke all on public.teaching_followup_receipts from public,anon,authenticated,service_role;

create policy "Teaching followups server insert" on public.notifications
  as restrictive for insert to anon,authenticated
  with check (type is distinct from 'teaching_followup');

create function public.xelay_guard_teaching_followup_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (old.type='teaching_followup' and (to_jsonb(new)-'is_read') is distinct from (to_jsonb(old)-'is_read'))
    or (old.type is distinct from 'teaching_followup' and new.type='teaching_followup') then
    raise exception 'TEACHING_FOLLOWUP_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_teaching_followup_update() from public,anon,authenticated,service_role;
create trigger teaching_followup_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_teaching_followup_update();

create function public.xelay_private_teaching_followup_backlog(p_cutoff timestamptz,p_recipient_id uuid default null)
returns table(recipient_id uuid,review_count bigint,request_count bigint,backlog_fingerprint text)
language sql stable security definer set search_path='' as $$
  with pending as materialized (
    select s.course_id,s.group_id,'review'::text as kind,s.id,s.attempt as revision
    from public.teaching_submissions s
    join public.teaching_items i on i.id=s.item_id and i.course_id=s.course_id
    join public.teaching_item_targets t on t.item_id=s.item_id and t.group_id=s.group_id
    where s.status='submitted' and s.submitted_at<=p_cutoff
      and i.kind='assignment' and i.status='published' and i.withdrawn_at is null
    union all
    select r.course_id,r.group_id,'grade_request',r.id,r.version
    from public.teaching_grade_requests r
    where r.status='open' and r.created_at<=p_cutoff
      and public.xelay_private_grade_request_activity_visible(r.activity_id)
  ), scopes as (
    select distinct p.course_id,p.group_id from pending p
  ), staff as materialized (
    select s.course_id,s.group_id,t.user_id,
      public.xelay_teaching_group_permissions(s.course_id,s.group_id,t.user_id) as permissions
    from scopes s
    join public.teaching_courses c on c.id=s.course_id and c.archived_at is null
    join public.teaching_course_groups l on l.course_id=s.course_id and l.group_id=s.group_id and l.status='accepted'
    join public.xelay_listed_study_groups g on g.id=s.group_id
    cross join lateral (
      select c.owner_id as user_id where p_recipient_id is null or p_recipient_id=c.owner_id
      union all
      select t.user_id from public.teaching_course_teachers t
      where t.course_id=s.course_id and t.status='accepted' and t.user_id<>c.owner_id
        and (p_recipient_id is null or p_recipient_id=t.user_id)
    ) t
    where public.xelay_teaching_has_current_access(t.user_id)
  )
  select t.user_id,count(*) filter(where p.kind='review'),count(*) filter(where p.kind='grade_request'),
    md5(string_agg(p.kind||':'||p.id::text||':'||p.revision::text,',' order by p.kind,p.id,p.revision))
  from pending p join staff t on t.course_id=p.course_id and t.group_id=p.group_id
  where (p.kind='review' and t.permissions&&array['assignments','grades']::text[])
    or (p.kind='grade_request' and 'grades'=any(t.permissions))
  group by t.user_id;
$$;
revoke all on function public.xelay_private_teaching_followup_backlog(timestamptz,uuid)
  from public,anon,authenticated,service_role;

create function public.xelay_private_queue_teaching_followups(p_now timestamptz)
returns integer language plpgsql security definer set search_path='' as $$
declare
  v_kyiv timestamp:=p_now at time zone 'Europe/Kyiv';
  v_day date:=v_kyiv::date;
  v_item record;
  v_notification_id text;
  v_count integer:=0;
begin
  if extract(isodow from v_kyiv)>5 or v_kyiv::time<time '09:00' or v_kyiv::time>=time '12:00' then return 0; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('xelay:teaching-followups',0)) then return 0; end if;
  for v_item in
    select d.*
    from public.xelay_private_teaching_followup_backlog(p_now-interval '24 hours') d
    left join public.notification_preferences p on p.user_id=d.recipient_id
    where coalesce(p.notifications_enabled,true)
      and not exists (
        select 1 from public.teaching_followup_receipts r where r.recipient_id=d.recipient_id and r.kyiv_day=v_day
      )
      and d.backlog_fingerprint is distinct from (
        select r.backlog_fingerprint from public.teaching_followup_receipts r
        where r.recipient_id=d.recipient_id order by r.kyiv_day desc limit 1
      )
    order by d.recipient_id limit 100
  loop
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read)
    values(v_item.recipient_id,v_item.recipient_id,'Xelay','teaching_followup',
      format('Роботи на перевірку понад добу (%s). Запити щодо балів без відповіді понад добу (%s). Перегляньте кабінет викладача.',
        v_item.review_count,v_item.request_count),false)
    returning id::text into v_notification_id;
    insert into public.teaching_followup_receipts(recipient_id,kyiv_day,queued_at,backlog_fingerprint,notification_id)
    values(v_item.recipient_id,v_day,p_now,v_item.backlog_fingerprint,v_notification_id);
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.xelay_private_queue_teaching_followups(timestamptz) from public,anon,authenticated,service_role;

create function public.xelay_queue_teaching_followups()
returns integer language sql security definer set search_path='' as $$
  select public.xelay_private_queue_teaching_followups(statement_timestamp());
$$;
revoke all on function public.xelay_queue_teaching_followups() from public,anon,authenticated,service_role;

create function public.xelay_teaching_followup_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();
  v_receipt public.teaching_followup_receipts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  select r.* into v_receipt
  from public.notification_email_outbox q
  join public.teaching_followup_receipts r on r.notification_id=q.notification_id and r.recipient_id=q.recipient_id
  join public.notifications n on n.id::text=q.notification_id
    and n.recipient_id::text=q.recipient_id::text and n.type=q.notification_type
  where q.id=p_job_id and q.lock_token=p_lock_token and q.status='processing'
    and q.locked_until>v_now and q.notification_type='teaching_followup';
  if not found then return jsonb_build_object('eligible',false,'reason','teaching_followup_context_missing'); end if;

  if v_receipt.kyiv_day<>(v_now at time zone 'Europe/Kyiv')::date or not exists (
    select 1 from public.xelay_private_teaching_followup_backlog(
      v_receipt.queued_at-interval '24 hours',v_receipt.recipient_id
    )
  ) then return jsonb_build_object('eligible',false,'reason','teaching_followup_unavailable'); end if;

  return jsonb_build_object('eligible',true);
end $$;
revoke all on function public.xelay_teaching_followup_email_context(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_followup_email_context(uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;
