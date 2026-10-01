-- Preferences, trusted notification creation, and a private email delivery queue.
begin;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notifications_enabled boolean not null default true,
  email_notifications_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public, anon, authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;
drop policy if exists "Own notification preferences select" on public.notification_preferences;
create policy "Own notification preferences select" on public.notification_preferences
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Own notification preferences insert" on public.notification_preferences;
create policy "Own notification preferences insert" on public.notification_preferences
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "Own notification preferences update" on public.notification_preferences;
create policy "Own notification preferences update" on public.notification_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.xelay_notification_preferences_timestamp()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
revoke all on function public.xelay_notification_preferences_timestamp() from public, anon, authenticated;
drop trigger if exists notification_preferences_timestamp on public.notification_preferences;
create trigger notification_preferences_timestamp before insert or update on public.notification_preferences
  for each row execute function public.xelay_notification_preferences_timestamp();

-- Notifications originate in database triggers/RPCs, never an arbitrary client
-- insert. Move the previous answer notification from the browser to the database.
create or replace function public.xelay_notify_answer()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_actor text; v_notification public.notifications%rowtype;
begin
  select q.user_id::uuid into v_owner from public.questions q where q.id::text = new.question_id::text;
  if v_owner is null or v_owner = new.user_id::uuid then return new; end if;
  select p.full_name into v_actor from public.profiles p where p.id = new.user_id::uuid;
  if not exists (select 1 from public.notifications n where n.type = 'answer'
    and n.answer_id::text = new.id::text and n.recipient_id::text = v_owner::text)
  then
    -- Convert legacy text IDs using the actual target column types.
    begin
      v_notification := jsonb_populate_record(null::public.notifications, jsonb_build_object(
        'recipient_id', v_owner, 'actor_id', new.user_id, 'question_id', new.question_id, 'answer_id', new.id
      ));
    exception when invalid_text_representation then
      -- A historic custom ID cannot fit a UUID reference column. Keep the answer
      -- and a generic notification rather than rolling back the user's answer.
      v_notification := jsonb_populate_record(null::public.notifications,
        jsonb_build_object('recipient_id', v_owner, 'actor_id', new.user_id));
    end;
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, question_id, answer_id, is_read)
    values (v_notification.recipient_id, v_notification.actor_id, coalesce(nullif(v_actor, ''), 'Учасник Xelay'), 'answer',
      'відповів(-ла) на ваше запитання', v_notification.question_id, v_notification.answer_id, false);
  end if;
  return new;
end;
$$;
revoke all on function public.xelay_notify_answer() from public, anon, authenticated;
drop trigger if exists xelay_answer_notification on public.answers;
create trigger xelay_answer_notification after insert on public.answers
  for each row execute function public.xelay_notify_answer();

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon;
revoke all on public.notifications from authenticated;
-- Remove any older column-level update grants before allowing only read status.
do $$
declare v_columns text;
begin
  select string_agg(quote_ident(attname), ', ') into v_columns from pg_attribute
    where attrelid = 'public.notifications'::regclass and attnum > 0 and not attisdropped;
  execute format('revoke insert (%s), update (%s) on public.notifications from public, anon, authenticated', v_columns, v_columns);
end;
$$;
grant select on public.notifications to authenticated;
grant update (is_read) on public.notifications to authenticated;
grant all on public.notifications to service_role;
drop policy if exists "Notification recipient select" on public.notifications;
create policy "Notification recipient select" on public.notifications
  for select to authenticated using (recipient_id::text = auth.uid()::text);
drop policy if exists "Notification recipient select guard" on public.notifications;
create policy "Notification recipient select guard" on public.notifications as restrictive
  for select to authenticated using (recipient_id::text = auth.uid()::text);
drop policy if exists "Notification recipient update" on public.notifications;
create policy "Notification recipient update" on public.notifications
  for update to authenticated using (recipient_id::text = auth.uid()::text)
  with check (recipient_id::text = auth.uid()::text);
drop policy if exists "Notification recipient update guard" on public.notifications;
create policy "Notification recipient update guard" on public.notifications as restrictive
  for update to authenticated using (recipient_id::text = auth.uid()::text)
  with check (recipient_id::text = auth.uid()::text);

create table if not exists public.notification_email_outbox (
  id uuid primary key default gen_random_uuid(),
  -- Legacy notification IDs may be uuid, text or numeric. Keep their exact text.
  notification_id text not null unique,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  notification_type text not null,
  event_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  lock_token uuid,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists notification_email_outbox_due_idx
  on public.notification_email_outbox (available_at, created_at) where status in ('pending', 'processing');
create index if not exists notification_email_outbox_recipient_recent_idx
  on public.notification_email_outbox (recipient_id, created_at desc);
alter table public.notification_email_outbox enable row level security;
revoke all on public.notification_email_outbox from public, anon, authenticated;
grant all on public.notification_email_outbox to service_role;

create or replace function public.xelay_queue_notification_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_preferences public.notification_preferences%rowtype; v_key text;
begin
  if new.recipient_id is null or new.recipient_id::text = coalesce(new.actor_id::text, '')
    or coalesce(new.is_read, false)
    or new.type is null or new.type not in ('answer', 'connection_request', 'connection_accepted', 'message', 'news_comment',
      'news_submission_published', 'news_submission_rejected', 'editor_request_approved', 'editor_request_rejected',
      'class_rep_approved', 'class_rep_rejected', 'group_invite', 'group_invite_accepted', 'group_homework')
  then return new; end if;
  if not exists (select 1 from auth.users u where u.id::text = new.recipient_id::text
    and u.email_confirmed_at is not null and nullif(u.email, '') is not null and u.deleted_at is null)
  then return new; end if;
  select * into v_preferences from public.notification_preferences where user_id::text = new.recipient_id::text;
  if not coalesce(v_preferences.notifications_enabled, true)
    or not coalesce(v_preferences.email_notifications_enabled, true) then return new; end if;

  -- Bound bursts per recipient without holding up the original platform event.
  perform pg_advisory_xact_lock(hashtextextended('xelay-email-' || new.recipient_id::text, 0));
  if (select count(*) from public.notification_email_outbox where recipient_id::text = new.recipient_id::text
    and created_at > now() - interval '1 hour') >= 30 then return new; end if;
  if new.type = 'message' and exists (select 1 from public.notification_email_outbox
    where recipient_id::text = new.recipient_id::text and actor_id::text = new.actor_id::text
      and notification_type = 'message' and created_at > now() - interval '10 minutes') then return new; end if;
  v_key := case when new.type = 'answer' and new.answer_id is not null
    then 'answer:' || new.answer_id::text || ':' || new.recipient_id::text
    else 'notification:' || new.id::text end;
  insert into public.notification_email_outbox (notification_id, recipient_id, actor_id, notification_type, event_key)
    values (new.id::text, new.recipient_id::uuid, new.actor_id::uuid, new.type, v_key) on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.xelay_queue_notification_email() from public, anon, authenticated;
drop trigger if exists notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row execute function public.xelay_queue_notification_email();

create or replace function public.xelay_claim_notification_email(p_job_id uuid default null)
returns table (id uuid, notification_id text, attempts integer, created_at timestamptz, lock_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  -- Resend idempotency lasts 24 hours. Stop before that window ends.
  update public.notification_email_outbox q set status = 'skipped', completed_at = now(),
    last_error_code = 'expired', lock_token = null, locked_until = null
    where q.status in ('pending', 'processing') and q.created_at <= now() - interval '23 hours';
  update public.notification_email_outbox q set status = 'failed', completed_at = now(),
    last_error_code = 'attempts_exhausted', lock_token = null, locked_until = null
    where q.attempts >= 5 and (q.status = 'pending' or (q.status = 'processing' and q.locked_until <= now()));
  return query
    update public.notification_email_outbox q set status = 'processing', attempts = q.attempts + 1,
      lock_token = gen_random_uuid(), locked_until = now() + interval '2 minutes'
    where q.id = (
      select candidate.id from public.notification_email_outbox candidate
      where (p_job_id is null or candidate.id = p_job_id) and candidate.attempts < 5
        and candidate.created_at > now() - interval '23 hours'
        and ((candidate.status = 'pending' and candidate.available_at <= now())
          or (candidate.status = 'processing' and candidate.locked_until <= now()))
      order by candidate.created_at, candidate.id for update skip locked limit 1
    ) returning q.id, q.notification_id, q.attempts, q.created_at, q.lock_token;
end;
$$;

create or replace function public.xelay_finish_notification_email(
  p_job_id uuid, p_lock_token uuid, p_status text,
  p_error_code text default null, p_provider_message_id text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_updated integer;
begin
  if p_status not in ('pending', 'sent', 'skipped', 'failed') then raise exception 'Invalid email job status'; end if;
  update public.notification_email_outbox q set
    status = case when p_status = 'pending' and q.attempts >= 5 then 'failed' else p_status end,
    available_at = case when p_status = 'pending'
      then now() + make_interval(secs => least(1800, 60 * (2 ^ (q.attempts - 1))::integer)) else q.available_at end,
    completed_at = case when p_status <> 'pending' or q.attempts >= 5 then now() else null end,
    provider_message_id = left(p_provider_message_id, 200), last_error_code = left(p_error_code, 80),
    lock_token = null, locked_until = null
    where q.id = p_job_id and q.status = 'processing' and q.lock_token = p_lock_token and q.locked_until > now();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;
revoke all on function public.xelay_claim_notification_email(uuid),
  public.xelay_finish_notification_email(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.xelay_claim_notification_email(uuid),
  public.xelay_finish_notification_email(uuid, uuid, text, text, text) to service_role;

-- Only notifications created after this migration are queued. No mail history dump.
commit;
