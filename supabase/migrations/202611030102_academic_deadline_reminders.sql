-- Install the reminder producer and delivery check. Scheduling is opt-in.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.academic_deadline_reminder_receipts (
  kind text not null check (kind in ('teaching','homework','long_term')),
  source_id uuid not null,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz not null check (isfinite(due_at)),
  lesson_date date,
  notification_id text not null unique,
  primary key (kind,source_id,group_id,recipient_id,due_at)
);
create index academic_deadline_reminder_group_idx on public.academic_deadline_reminder_receipts(group_id);
create index academic_deadline_reminder_recipient_idx on public.academic_deadline_reminder_receipts(recipient_id);
alter table public.academic_deadline_reminder_receipts enable row level security;
revoke all on public.academic_deadline_reminder_receipts from public,anon,authenticated,service_role;

create policy "Academic deadline reminders server insert" on public.notifications
  as restrictive for insert to anon,authenticated
  with check (type is distinct from 'academic_deadline');

create function public.xelay_guard_academic_deadline_reminder_update()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (old.type='academic_deadline' and (to_jsonb(new)-'is_read') is distinct from (to_jsonb(old)-'is_read'))
    or (old.type is distinct from 'academic_deadline' and new.type='academic_deadline') then
    raise exception 'ACADEMIC_DEADLINE_REMINDER_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_academic_deadline_reminder_update() from public,anon,authenticated,service_role;
create trigger academic_deadline_reminder_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_academic_deadline_reminder_update();

create function public.xelay_queue_academic_deadline_reminders()
returns integer language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=statement_timestamp();
  v_item record;
  v_notification_id text;
  v_count integer:=0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('xelay:academic-deadline-reminders',0)) then return 0; end if;
  for v_item in
    select batch.* from (
      select d.*
      from public.xelay_private_academic_deadline_candidates(v_now,v_now+interval '24 hours') d
      left join public.notification_preferences p on p.user_id::text=d.recipient_id::text
      where coalesce(p.notifications_enabled,true)
        and not exists (
          select 1 from public.academic_deadline_reminder_receipts r
          where (r.kind,r.source_id,r.group_id,r.recipient_id,r.due_at)
            =(d.kind,d.source_id,d.group_id,d.recipient_id,d.due_at)
        )
      order by d.due_at,d.recipient_id,d.kind,d.source_id,d.group_id
      limit 100
    ) batch
    order by batch.recipient_id,batch.due_at,batch.kind,batch.source_id,batch.group_id
  loop
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,study_group_id)
    values(v_item.recipient_id,v_item.recipient_id,'Xelay','academic_deadline',
      case v_item.kind
        when 'teaching' then 'Наближається дедлайн завдання викладача. Перевірте термін здачі у своїй групі.'
        when 'homework' then 'Наближається дедлайн домашнього завдання. Перевірте термін здачі у своїй групі.'
        else 'Наближається дедлайн довгострокового завдання. Перевірте термін здачі у своїй групі.'
      end,false,v_item.group_id)
    returning id::text into v_notification_id;
    insert into public.academic_deadline_reminder_receipts(kind,source_id,group_id,recipient_id,due_at,lesson_date,notification_id)
    values(v_item.kind,v_item.source_id,v_item.group_id,v_item.recipient_id,v_item.due_at,v_item.lesson_date,v_notification_id);
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.xelay_queue_academic_deadline_reminders() from public,anon,authenticated,service_role;

create function public.xelay_academic_deadline_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();
  v_receipt public.academic_deadline_reminder_receipts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  select r.* into v_receipt
  from public.notification_email_outbox q
  join public.academic_deadline_reminder_receipts r on r.notification_id=q.notification_id and r.recipient_id=q.recipient_id
  join public.notifications n on n.id::text=q.notification_id
    and n.recipient_id::text=q.recipient_id::text and n.study_group_id=r.group_id and n.type=q.notification_type
  where q.id=p_job_id and q.lock_token=p_lock_token and q.status='processing'
    and q.locked_until>v_now and q.notification_type='academic_deadline';
  if not found then return jsonb_build_object('eligible',false,'reason','deadline_context_missing'); end if;

  if not exists (
    select 1 from public.xelay_private_academic_deadline_candidates(
      v_now,v_receipt.due_at,v_receipt.kind,v_receipt.source_id,v_receipt.group_id,v_receipt.recipient_id
    ) d
    where d.due_at=v_receipt.due_at and d.lesson_date is not distinct from v_receipt.lesson_date
  ) then return jsonb_build_object('eligible',false,'reason','deadline_unavailable'); end if;

  return jsonb_build_object('eligible',true,'kind',v_receipt.kind,'group_id',v_receipt.group_id,
    'source_id',v_receipt.source_id,'due_at',v_receipt.due_at,'lesson_date',v_receipt.lesson_date);
end $$;
revoke all on function public.xelay_academic_deadline_email_context(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_academic_deadline_email_context(uuid,uuid) to service_role;

notify pgrst,'reload schema';
commit;
