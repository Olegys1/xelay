-- Notify the exact university/faculty audience once when a post first becomes
-- published. published_at remains the existing display/sort date: it is not a
-- scheduler, and even a future-dated published post is already readable.
begin;

do $$
begin
  if to_regclass('public.news_posts') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.notification_preferences') is null
    or to_regclass('public.notification_email_outbox') is null
    or to_regclass('public.messages') is null
    or to_regprocedure('public.xelay_can_read_news(uuid)') is null
    or to_regprocedure('public.xelay_queue_notification_email()') is null
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='notifications' and column_name='news_post_id')
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='profiles' and column_name='academic_unit_id')
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='notifications' and column_name='direct_message_id')
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='notifications' and column_name='direct_conversation_id')
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_email_outbox' and column_name='direct_conversation_id')
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_email_outbox' and column_name='delivery_reserved_at') then
    raise exception 'Apply university/faculty news, trusted notifications, and unread email delivery migrations first';
  end if;
end $$;

-- Serialize activation with publications so a post cannot fall between the
-- legacy baseline and trigger installation.
lock table public.news_posts in share row exclusive mode;

create table if not exists public.news_publication_receipts (
  news_post_id uuid primary key references public.news_posts(id) on delete cascade,
  university_id uuid not null,
  academic_unit_id uuid,
  first_published_at timestamptz not null default clock_timestamp(),
  origin text not null check(origin in ('legacy','publication'))
);
alter table public.news_publication_receipts enable row level security;
revoke all on public.news_publication_receipts from public,anon,authenticated;
grant all on public.news_publication_receipts to service_role;

-- Existing content is not announced again when installing this feature.
-- Archived posts count as previous publications; existing drafts are announced
-- if they are first published after activation.
insert into public.news_publication_receipts(
  news_post_id,university_id,academic_unit_id,first_published_at,origin
)
select n.id,n.university_id,n.academic_unit_id,clock_timestamp(),'legacy'
from public.news_posts n where n.status in ('published','archived')
on conflict(news_post_id) do nothing;

create unique index if not exists notifications_news_publication_recipient_unique
  on public.notifications(recipient_id,news_post_id) where type='news_published';

-- Opening the general notification bell must not acknowledge the news feed.
-- Only the owner may set this independent read marker through the existing
-- restrictive recipient UPDATE policies; all event identity fields stay closed.
alter table public.notifications add column if not exists news_read_at timestamptz;
alter table public.notifications drop constraint if exists notifications_news_read_marker_check;
alter table public.notifications add constraint notifications_news_read_marker_check check (
  news_read_at is null or (type='news_published' and news_post_id is not null and isfinite(news_read_at))
);
grant update(news_read_at) on public.notifications to authenticated;
create index if not exists notifications_unread_news_recipient_idx
  on public.notifications(recipient_id,created_at desc,news_post_id)
  where type='news_published' and news_read_at is null;

-- Preserve the existing verified-address, saved preference, direct-message
-- delay, rate limit and actor self-email guards; extend only announcement type.
create or replace function public.xelay_queue_notification_email()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_preferences public.notification_preferences%rowtype;
  v_key text;
  v_available timestamptz:=clock_timestamp();
  v_message public.messages%rowtype;
begin
  if new.recipient_id is null or new.recipient_id::text=coalesce(new.actor_id::text,'')
    or (new.type is distinct from 'message' and coalesce(new.is_read,false))
    or new.type is null or new.type not in('answer','question_comment','connection_request','connection_accepted','message','news_comment','news_published',
      'news_submission_published','news_submission_rejected','editor_request_approved','editor_request_rejected',
      'class_rep_approved','class_rep_rejected','group_invite','group_invite_accepted','group_homework') then return new; end if;
  if not exists(select 1 from auth.users u where u.id::text=new.recipient_id::text
    and u.email_confirmed_at is not null and nullif(u.email,'') is not null and u.deleted_at is null) then return new; end if;
  select * into v_preferences from public.notification_preferences where user_id::text=new.recipient_id::text;
  if not coalesce(v_preferences.notifications_enabled,true)
    or not coalesce(v_preferences.email_notifications_enabled,true) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-email-'||new.recipient_id::text,0));

  if new.type='message' then
    select * into v_message from public.messages m
      where m.id=new.direct_message_id and m.conversation_id=new.direct_conversation_id
        and m.sender_id::text=new.actor_id::text and m.recipient_id::text=new.recipient_id::text
        and m.read_at is null and m.deleted_at is null;
    if not found then return new; end if;
    -- Retire an expired predecessor before the active-thread unique constraint
    -- sees the new event. Live processing leases are never overwritten.
    update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
      last_error_code='expired',lock_token=null,locked_until=null
      where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
        and q.notification_type='message' and q.created_at<=clock_timestamp()-interval '23 hours'
        and (q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()));
    if exists(select 1 from public.notification_email_outbox q
      where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
        and q.notification_type='message' and q.status in('pending','processing')) then return new; end if;
    v_available:=greatest(v_message.created_at+interval '5 minutes',coalesce(
      (select max(greatest(case when q.status='sent' then q.completed_at else null end,q.delivery_reserved_at))
          +interval '10 minutes' from public.notification_email_outbox q
        where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
          and q.notification_type='message'),v_message.created_at+interval '5 minutes'));
  end if;
  if(select count(*) from public.notification_email_outbox q where q.recipient_id::text=new.recipient_id::text
    and q.created_at>clock_timestamp()-interval '1 hour')>=30 then return new; end if;
  v_key:=case when new.type='answer' and new.answer_id is not null
    then 'answer:'||new.answer_id::text||':'||new.recipient_id::text else 'notification:'||new.id::text end;
  insert into public.notification_email_outbox(notification_id,recipient_id,actor_id,notification_type,event_key,
    available_at,direct_conversation_id)
  values(new.id::text,new.recipient_id::uuid,new.actor_id::uuid,new.type,v_key,v_available,
    case when new.type='message' then new.direct_conversation_id else null end) on conflict do nothing;
  return new;
end $$;
revoke all on function public.xelay_queue_notification_email() from public,anon,authenticated,service_role;

drop trigger if exists notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row execute function public.xelay_queue_notification_email();

create or replace function public.xelay_notify_news_publication()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_publication uuid; v_title text; v_actor_name text; v_received_at timestamptz;
begin
  if new.status is distinct from 'published' then return new; end if;
  if tg_op='UPDATE' and old.status='published' then return new; end if;

  v_received_at:=clock_timestamp();
  insert into public.news_publication_receipts(
    news_post_id,university_id,academic_unit_id,first_published_at,origin
  ) values(new.id,new.university_id,new.academic_unit_id,v_received_at,'publication')
    on conflict(news_post_id) do nothing returning news_post_id into v_publication;
  if v_publication is null then return new; end if;

  v_title:=left(btrim(regexp_replace(regexp_replace(new.title,'[[:cntrl:]]',' ','g'),
    '[[:space:]]+',' ','g')),180);
  v_actor_name:=case when new.academic_unit_id is null
    then 'Загальні новини університету' else 'Новини факультету' end;

  -- Scope membership is taken at publication time. Editorial access to a
  -- different faculty and deliberate chat sharing do not enroll that audience.
  -- Keep the publisher included: new-news availability is the same for everyone.
  insert into public.notifications(
    recipient_id,actor_id,actor_name,type,message,is_read,news_post_id,created_at
  )
  select p.id,new.published_by,v_actor_name,'news_published',
    'Нова публікація: '||v_title,false,new.id,v_received_at
  from public.profiles p join auth.users u on u.id=p.id and u.deleted_at is null
  where p.university_id=new.university_id
    and (new.academic_unit_id is null or p.academic_unit_id=new.academic_unit_id)
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=v_received_at
  -- The email enqueue trigger locks per recipient. Use the same order for
  -- concurrent university and faculty fanouts with overlapping audiences.
  order by p.id
  on conflict(recipient_id,news_post_id) where type='news_published' do nothing;
  return new;
end $$;
revoke all on function public.xelay_notify_news_publication() from public,anon,authenticated,service_role;

drop trigger if exists xelay_news_publication_notifications on public.news_posts;
create trigger xelay_news_publication_notifications
  after insert or update of status on public.news_posts
  for each row execute function public.xelay_notify_news_publication();

-- No new client insert privileges and no FULL replica identity: notification
-- UPDATE events stay recipient-scoped, while deletes carry only the row key.
alter table public.notifications replica identity default;
alter table public.news_posts replica identity default;
do $$
declare v_table text;
begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime' and not puballtables) then
    foreach v_table in array array['notifications','news_posts'] loop
      if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime'
        and schemaname='public' and tablename=v_table) then
        execute format('alter publication supabase_realtime add table public.%I',v_table);
      end if;
    end loop;
  end if;
end $$;

comment on table public.news_publication_receipts is
  'Server-only first-publication receipt. Existing published/archived news are baselined without notification fanout. Edits and republishing the same post never repeat the announcement.';
comment on function public.xelay_notify_news_publication() is
  'Atomic, once-per-post university/faculty announcement. The trusted notification table and existing recipient RLS remain authoritative; titles are bounded plain text, with no bodies or attachments copied.';
comment on column public.notifications.news_read_at is
  'Recipient-owned news acknowledgement, independent of bell is_read. A client sets it only after successfully displaying the relevant publication/feed snapshot; NULL keeps sidebar/scope dots lit.';
notify pgrst,'reload schema';
commit;
