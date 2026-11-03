-- Resolve upcoming academic deadlines from the live records and audiences.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create index if not exists xelay_teaching_deadline_due_idx
  on public.teaching_item_targets(due_at) where due_at is not null;
create index if not exists xelay_homework_deadline_due_idx
  on public.study_group_homework(due_at) where due_at is not null;
create index if not exists xelay_long_term_deadline_due_idx
  on public.study_group_long_term_tasks(due_date) where closed_at is null;

create or replace function public.xelay_private_academic_deadline_candidates(
  p_after timestamptz,
  p_until timestamptz,
  p_kind text default null,
  p_source_id uuid default null,
  p_group_id uuid default null,
  p_recipient_id uuid default null
)
returns table(kind text,source_id uuid,group_id uuid,recipient_id uuid,due_at timestamptz,lesson_date date,course_id uuid)
language sql stable security definer set search_path='' as $$
  with sources as (
    select 'teaching'::text as kind,i.id as source_id,t.group_id,t.due_at,t.lesson_date,i.submission_mode,i.course_id
    from public.teaching_item_targets t
    join public.teaching_items i on i.id=t.item_id
    join public.teaching_courses c on c.id=i.course_id
    where (p_kind is null or p_kind='teaching')
      and (p_source_id is null or t.item_id=p_source_id)
      and (p_group_id is null or t.group_id=p_group_id)
      and t.due_at>p_after and t.due_at<=p_until
      and i.kind='assignment' and i.status='published' and i.withdrawn_at is null
      and c.archived_at is null
    union all
    select 'homework',h.id,h.group_id,h.due_at,h.lesson_date,null,null
    from public.study_group_homework h
    join public.study_group_schedule s on s.id=h.schedule_item_id and s.group_id=h.group_id
    where (p_kind is null or p_kind='homework')
      and (p_source_id is null or h.id=p_source_id)
      and (p_group_id is null or h.group_id=p_group_id)
      and h.due_at>p_after and h.due_at<=p_until
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
        s.week_pattern,s.week_anchor_date,h.lesson_date)
      and not(h.lesson_date=any(s.excluded_dates))
      and (btrim(h.body)<>'' or nullif(btrim(h.url),'') is not null
        or jsonb_array_length(h.resource_links)>0 or jsonb_array_length(h.attachments)>0)
    union all
    select 'long_term',t.id,t.group_id,(t.due_date+1)::timestamp at time zone 'Europe/Kyiv',null,null,null
    from public.study_group_long_term_tasks t
    where (p_kind is null or p_kind='long_term')
      and (p_source_id is null or t.id=p_source_id)
      and (p_group_id is null or t.group_id=p_group_id)
      and t.closed_at is null
      and t.due_date>=(p_after at time zone 'Europe/Kyiv')::date
      and t.due_date<(p_until at time zone 'Europe/Kyiv')::date
  )
  select s.kind,s.source_id,s.group_id,a.user_id,s.due_at,s.lesson_date,s.course_id
  from sources s
  join public.xelay_listed_study_groups g on g.id=s.group_id
  cross join lateral (
    select g.representative_id as user_id
      where p_recipient_id is null or p_recipient_id=g.representative_id
    union all
    select m.user_id from public.study_group_members m
    where m.group_id=g.id and m.status='accepted' and m.user_id<>g.representative_id
      and (p_recipient_id is null or p_recipient_id=m.user_id)
  ) a
  join auth.users u on u.id=a.user_id
    and u.deleted_at is null and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp()
  where s.due_at>p_after and s.due_at<=p_until
    and (s.kind<>'teaching' or (
      public.xelay_classroom_student(s.source_id,s.group_id,a.user_id)
      and (s.submission_mode<>'team' or public.xelay_private_teaching_my_team(s.source_id,s.group_id,a.user_id) is not null)
      and not exists(
        select 1 from public.teaching_submissions w
        where w.item_id=s.source_id and w.group_id=s.group_id and w.status in ('submitted','reviewed')
          and public.xelay_private_teaching_submission_owner(w,a.user_id)
      )
    ));
$$;

revoke all on function public.xelay_private_academic_deadline_candidates(timestamptz,timestamptz,text,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
comment on function public.xelay_private_academic_deadline_candidates(timestamptz,timestamptz,text,uuid,uuid,uuid)
  is 'Internal source resolver for one-day academic reminders. Date-only work ends at the next Kyiv midnight. No reminder for drafts, completed teacher submissions, cancelled lesson occurrences, or hidden test groups in the background worker.';
commit;
