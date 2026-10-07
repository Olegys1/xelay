-- Participant appearance and opt-in browser push for personal organizer reminders.
-- Run this whole file in a fresh SQL tab after 202610070004/005/006.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_participant_runtime_status()') is null
    or to_regprocedure('public.xelay_dispatch_organizer_reminders(integer)') is null
    or to_regclass('public.notification_preferences') is null
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='organizer_task_id') then
    raise exception 'Apply participant direct and organizer migrations 202610070004 and 202610070005 before appearance/push';
  end if;
end;
$$;

create table if not exists public.participant_appearance_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_cover text not null default 'default' check(profile_cover in ('default','rose','ocean','forest','lavender','sunrise')),
  chat_theme text not null default 'default' check(chat_theme in ('default','rose','ocean','forest','lavender')),
  chat_wallpaper text not null default 'default' check(chat_wallpaper in ('default','dots','grid','waves')),
  updated_at timestamptz not null default now()
);
alter table public.participant_appearance_preferences enable row level security;
revoke all on public.participant_appearance_preferences from public,anon,authenticated;
grant select on public.participant_appearance_preferences to authenticated;
grant all on public.participant_appearance_preferences to service_role;
drop policy if exists "Own participant appearance" on public.participant_appearance_preferences;
create policy "Own participant appearance" on public.participant_appearance_preferences
  for select to authenticated using(user_id=auth.uid());

create or replace function public.xelay_get_participant_appearance()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'PARTICIPANT_AUTH_REQUIRED' using errcode='42501'; end if;
  if public.xelay_has_participant_access(auth.uid()) then
    select jsonb_build_object('profile_cover',profile_cover,'chat_theme',chat_theme,'chat_wallpaper',chat_wallpaper)
      into v_result from public.participant_appearance_preferences where user_id=auth.uid();
  end if;
  return coalesce(v_result,jsonb_build_object('profile_cover','default','chat_theme','default','chat_wallpaper','default'));
end;
$$;

create or replace function public.xelay_set_participant_appearance(p_cover text,p_theme text,p_wallpaper text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.xelay_has_participant_access(auth.uid()) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if p_cover is null or p_cover not in ('default','rose','ocean','forest','lavender','sunrise')
    or p_theme is null or p_theme not in ('default','rose','ocean','forest','lavender')
    or p_wallpaper is null or p_wallpaper not in ('default','dots','grid','waves') then
    raise exception 'PARTICIPANT_APPEARANCE_INVALID' using errcode='22023';
  end if;
  insert into public.participant_appearance_preferences(user_id,profile_cover,chat_theme,chat_wallpaper)
    values(auth.uid(),p_cover,p_theme,p_wallpaper)
    on conflict(user_id) do update set profile_cover=excluded.profile_cover,chat_theme=excluded.chat_theme,
      chat_wallpaper=excluded.chat_wallpaper,updated_at=now();
  return public.xelay_get_participant_appearance();
end;
$$;

create or replace function public.xelay_public_appearance(p_user_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_user_ids is null or cardinality(p_user_ids)>100 then raise exception 'PARTICIPANT_APPEARANCE_INVALID' using errcode='22023'; end if;
  -- Only a predefined decorative cover is public. Private chat preferences never leave the owner scope.
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',p.id,'profile_cover',
    case when public.xelay_has_participant_access(p.id) then coalesce(a.profile_cover,'default') else 'default' end))
    from public.profiles p left join public.participant_appearance_preferences a on a.user_id=p.id
    where p.id=any(p_user_ids)),'[]'::jsonb);
end;
$$;

create table if not exists public.participant_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check(length(endpoint) between 20 and 2048),
  p256dh text not null check(length(p256dh) between 80 and 100),
  auth_key text not null check(length(auth_key) between 20 and 30),
  device_label text not null default '' check(length(device_label)<=120),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.participant_push_subscriptions enable row level security;
revoke all on public.participant_push_subscriptions from public,anon,authenticated;
grant all on public.participant_push_subscriptions to service_role;
create index if not exists participant_push_owner_idx on public.participant_push_subscriptions(user_id) where enabled;

create table if not exists public.participant_push_outbox (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.participant_push_subscriptions(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','processing','sent','skipped','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(subscription_id,notification_id)
);
alter table public.participant_push_outbox enable row level security;
revoke all on public.participant_push_outbox from public,anon,authenticated;
grant all on public.participant_push_outbox to service_role;
create index if not exists participant_push_pending_idx on public.participant_push_outbox(next_attempt_at,id) where status in ('pending','processing');

create or replace function public.xelay_register_participant_push(p_user_id uuid,p_endpoint text,p_p256dh text,p_auth text,p_label text default '')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  if p_user_id is null or not public.xelay_has_participant_access(p_user_id) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if p_endpoint is null or length(p_endpoint)>2048
    or p_endpoint !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|([a-zA-Z0-9-]+[.])*push[.]apple[.]com|([a-zA-Z0-9-]+[.])+notify[.]windows[.]com)/'
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}=?$'
    or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}(==)?$' then
    raise exception 'PUSH_SUBSCRIPTION_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:push-owner:'||p_user_id::text,0));
  if exists(select 1 from public.participant_push_subscriptions where endpoint=p_endpoint and user_id<>p_user_id) then
    raise exception 'PUSH_DEVICE_OTHER_ACCOUNT' using errcode='42501';
  end if;
  if (select count(*) from public.participant_push_subscriptions where user_id=p_user_id)>=8
    and not exists(select 1 from public.participant_push_subscriptions where user_id=p_user_id and endpoint=p_endpoint) then
    raise exception 'PUSH_DEVICE_LIMIT' using errcode='22023';
  end if;
  insert into public.participant_push_subscriptions(user_id,endpoint,p256dh,auth_key,device_label)
    values(p_user_id,p_endpoint,p_p256dh,p_auth,left(coalesce(p_label,''),120))
    on conflict(endpoint) do update set p256dh=excluded.p256dh,auth_key=excluded.auth_key,device_label=excluded.device_label,
      enabled=true,updated_at=now() where participant_push_subscriptions.user_id=p_user_id
    returning id into v_id;
  if v_id is null then raise exception 'PUSH_DEVICE_OTHER_ACCOUNT' using errcode='42501'; end if;
  return v_id;
end;
$$;

create or replace function public.xelay_queue_participant_push()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.type is distinct from 'organizer_reminder' or new.organizer_task_id is null or new.is_read
    or not public.xelay_has_participant_access(new.recipient_id::uuid)
    or not coalesce((select notifications_enabled from public.notification_preferences where user_id::text=new.recipient_id::text),true) then return new; end if;
  insert into public.participant_push_outbox(subscription_id,notification_id)
    select id,new.id from public.participant_push_subscriptions where user_id::text=new.recipient_id::text and enabled
    on conflict(subscription_id,notification_id) do nothing;
  return new;
end;
$$;
drop trigger if exists xelay_participant_push_queue on public.notifications;
create trigger xelay_participant_push_queue after insert on public.notifications for each row execute function public.xelay_queue_participant_push();

create or replace function public.xelay_claim_participant_push(p_limit integer default 20)
returns table(job_id uuid,lock_token uuid,subscription_id uuid,user_id uuid,notification_id uuid,endpoint text,p256dh text,auth_key text)
language plpgsql security definer set search_path='' as $$
declare v_job record; v_token uuid; v_sub public.participant_push_subscriptions%rowtype; v_notification public.notifications%rowtype; v_returned integer:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  update public.participant_push_outbox o set status='failed',lease_token=null,lease_until=null where o.id in
    (select q.id from public.participant_push_outbox q where q.status='processing' and q.attempts>=5
      and q.lease_until<now() order by q.lease_until limit 50 for update skip locked);
  delete from public.participant_push_outbox o where o.id in
    (select q.id from public.participant_push_outbox q where q.status in ('sent','skipped','failed')
      and q.created_at<now()-interval '7 days' order by q.created_at limit 100 for update skip locked);
  for v_job in select o.* from public.participant_push_outbox o where o.attempts<5
    and ((o.status='pending' and o.next_attempt_at<=now()) or (o.status='processing' and o.lease_until<now()))
    order by o.next_attempt_at,o.id limit 50 for update skip locked
  loop
    select * into v_sub from public.participant_push_subscriptions s where s.id=v_job.subscription_id;
    select * into v_notification from public.notifications n where n.id=v_job.notification_id;
    if not found or v_sub.id is null or not v_sub.enabled or v_notification.is_read
      or v_notification.type is distinct from 'organizer_reminder' or v_notification.organizer_task_id is null
      or v_notification.recipient_id::text is distinct from v_sub.user_id::text
      or not exists(select 1 from public.organizer_tasks t where t.id=v_notification.organizer_task_id and t.user_id=v_sub.user_id and not t.completed)
      or not exists(select 1 from public.organizer_task_reminders r where r.notification_id=v_notification.id and r.reminder_at>=now()-interval '24 hours')
      or v_job.created_at<now()-interval '24 hours' or not public.xelay_has_participant_access(v_sub.user_id)
      or not coalesce((select notifications_enabled from public.notification_preferences where notification_preferences.user_id=v_sub.user_id),true) then
      update public.participant_push_outbox o set status='skipped',lease_token=null,lease_until=null where o.id=v_job.id;
      continue;
    end if;
    v_token:=gen_random_uuid();
    update public.participant_push_outbox o set status='processing',attempts=o.attempts+1,
      lease_token=v_token,lease_until=now()+interval '2 minutes' where o.id=v_job.id;
    job_id:=v_job.id; lock_token:=v_token; subscription_id:=v_sub.id; user_id:=v_sub.user_id;
    notification_id:=v_notification.id; endpoint:=v_sub.endpoint; p256dh:=v_sub.p256dh; auth_key:=v_sub.auth_key;
    return next;
    v_returned:=v_returned+1;
    exit when v_returned>=least(greatest(coalesce(p_limit,20),1),50);
  end loop;
end;
$$;

create or replace function public.xelay_participant_push_delivery_allowed(p_job_id uuid,p_token uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  return exists(select 1 from public.participant_push_outbox o
    join public.participant_push_subscriptions s on s.id=o.subscription_id
    join public.notifications n on n.id=o.notification_id and n.recipient_id::text=s.user_id::text
    join public.organizer_tasks t on t.id=n.organizer_task_id and t.user_id=s.user_id
    join public.organizer_task_reminders r on r.notification_id=n.id and r.task_id=t.id
    where o.id=p_job_id and o.lease_token=p_token and o.status='processing' and o.lease_until>now()
      and s.enabled and not t.completed and not n.is_read and n.type='organizer_reminder'
      and r.reminder_at>=now()-interval '24 hours' and o.created_at>=now()-interval '24 hours'
      and public.xelay_has_participant_access(s.user_id)
      and coalesce((select notifications_enabled from public.notification_preferences p where p.user_id=s.user_id),true));
end;
$$;

create or replace function public.xelay_finish_participant_push(p_job_id uuid,p_token uuid,p_status text,p_remove_device boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_job public.participant_push_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  if p_status not in ('sent','skipped','retry') or p_status is null then raise exception 'PUSH_RESULT_INVALID' using errcode='22023'; end if;
  select * into v_job from public.participant_push_outbox where id=p_job_id and lease_token=p_token and status='processing' for update;
  if not found then return false; end if;
  update public.participant_push_outbox set status=case when p_status='retry' then case when attempts>=5 then 'failed' else 'pending' end else p_status end,
    next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,attempts)::integer)),
    lease_token=null,lease_until=null,delivered_at=case when p_status='sent' then now() else null end where id=p_job_id;
  if p_remove_device then delete from public.participant_push_subscriptions where id=v_job.subscription_id; end if;
  return true;
end;
$$;

revoke all on function public.xelay_get_participant_appearance(),public.xelay_set_participant_appearance(text,text,text),public.xelay_public_appearance(uuid[]),
  public.xelay_register_participant_push(uuid,text,text,text,text),public.xelay_queue_participant_push(),public.xelay_claim_participant_push(integer),
  public.xelay_participant_push_delivery_allowed(uuid,uuid),public.xelay_finish_participant_push(uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_get_participant_appearance(),public.xelay_set_participant_appearance(text,text,text) to authenticated;
grant execute on function public.xelay_public_appearance(uuid[]) to anon,authenticated;
grant execute on function public.xelay_register_participant_push(uuid,text,text,text,text),public.xelay_claim_participant_push(integer),
  public.xelay_participant_push_delivery_allowed(uuid,uuid),public.xelay_finish_participant_push(uuid,uuid,text,boolean) to service_role;
comment on table public.participant_push_subscriptions is 'Private opt-in endpoint capability and encryption keys; never exposed through browser table grants. At most 8 devices per owner.';
comment on table public.participant_push_outbox is 'Organizer-only push, atomic claim leases and bounded retries. Provider and service-worker tags suppress duplicate display; external delivery is not exactly-once.';
notify pgrst,'reload schema';
commit;
