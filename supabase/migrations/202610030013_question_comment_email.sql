-- Queue future question-comment notifications using the existing email rules.
-- No old notifications are backfilled and no delivery setting is enabled here.
begin;

create or replace function public.xelay_queue_notification_email()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_preferences public.notification_preferences%rowtype; v_key text;
begin
  if new.recipient_id is null or new.recipient_id::text = coalesce(new.actor_id::text, '')
    or coalesce(new.is_read, false)
    or new.type is null or new.type not in ('answer', 'question_comment', 'connection_request', 'connection_accepted', 'message', 'news_comment',
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
revoke all on function public.xelay_queue_notification_email() from public, anon, authenticated, service_role;

commit;
