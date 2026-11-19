-- Notifications only: never modifies payment application, entitlements, answers or grades.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema xelay_admin_notifications;
revoke all on schema xelay_admin_notifications from public,anon,authenticated,service_role;
create table xelay_admin_notifications.purchases (
 order_id uuid primary key references public.billing_orders(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),
 status text not null default 'pending' check(status in('pending','sent','skipped')),
 attempts integer not null default 0 check(attempts>=0),
 next_attempt_at timestamptz not null default clock_timestamp(),
 lease_token uuid unique, lease_until timestamptz, sent_at timestamptz,
 last_error_code text check(last_error_code in('telegram_rate_limited','telegram_rejected','telegram_unavailable','delivery_unavailable','invalid_context'))
);
create index admin_purchase_due on xelay_admin_notifications.purchases(next_attempt_at,created_at) where status='pending';
alter table xelay_admin_notifications.purchases enable row level security;
revoke all on xelay_admin_notifications.purchases from public,anon,authenticated,service_role;

create function xelay_admin_notifications.enqueue_purchase() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.mode='live' and new.status='approved' and new.product in('participant','group') and new.amount>0
   and (tg_op='INSERT' or old.status is distinct from 'approved') then
  insert into xelay_admin_notifications.purchases(order_id) values(new.id) on conflict do nothing;
 end if;
 return new;
end$$;
revoke all on function xelay_admin_notifications.enqueue_purchase() from public,anon,authenticated,service_role;
create trigger xelay_admin_purchase_paid after insert or update of status on public.billing_orders
 for each row execute function xelay_admin_notifications.enqueue_purchase();
-- Deliberately no historical backfill, no notifications for test payments or gifts.

create function xelay_admin_notifications.purchase_context(p_token uuid) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('lease_token',q.lease_token,'order_id',o.id,
  'plan_id',case when o.product='group' then 'group' else coalesce(o.teacher_plan_id,o.student_plan_id,'participant') end,
  'amount',o.amount,'currency',o.currency,'approved_at',o.approved_at,
  'username',case when p.username ~ '^[A-Za-z0-9_]{3,40}$' then p.username else null end)
 from xelay_admin_notifications.purchases q join public.billing_orders o on o.id=q.order_id
 join public.profiles p on p.id=o.user_id
 where q.lease_token=p_token and q.status='pending' and q.lease_until>clock_timestamp()
 and o.mode='live' and o.status='approved' and o.approved_at is not null;
$$;
revoke all on function xelay_admin_notifications.purchase_context(uuid) from public,anon,authenticated,service_role;

create function public.xelay_claim_admin_purchase_alert() returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid;v_token uuid:=gen_random_uuid();v_now timestamptz:=clock_timestamp();
begin
 if not public.xelay_security_is_trusted_backend() then raise exception 'ADMIN_PURCHASE_SERVICE_REQUIRED' using errcode='42501';end if;
 -- One delivery at a time, even when the worker is invoked concurrently.
 if not pg_try_advisory_xact_lock(hashtextextended('admin-purchase-delivery',0)) then return null;end if;
 if exists(select 1 from xelay_admin_notifications.purchases where status='pending' and lease_until>v_now)
 or exists(select 1 from xelay_admin_notifications.purchases where status='pending' and last_error_code='telegram_rate_limited' and next_attempt_at>v_now) then return null;end if;
 update xelay_admin_notifications.purchases q set status='skipped',lease_token=null,lease_until=null
 where status='pending' and not exists(select 1 from public.billing_orders o where o.id=q.order_id and o.status='approved' and o.mode='live');
 select order_id into v_id from xelay_admin_notifications.purchases where status='pending' and next_attempt_at<=v_now
 and (lease_until is null or lease_until<=v_now) order by next_attempt_at,created_at,order_id limit 1 for update skip locked;
 if not found then return null;end if;
 update xelay_admin_notifications.purchases set lease_token=v_token,lease_until=v_now+interval '2 minutes',attempts=attempts+1 where order_id=v_id;
 return xelay_admin_notifications.purchase_context(v_token);
end$$;
create function public.xelay_admin_purchase_alert_delivery_context(p_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.xelay_security_is_trusted_backend() then raise exception 'ADMIN_PURCHASE_SERVICE_REQUIRED' using errcode='42501';end if;
 return xelay_admin_notifications.purchase_context(p_token);
end$$;
create function public.xelay_finish_admin_purchase_alert(p_token uuid,p_status text,p_error_code text default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare q xelay_admin_notifications.purchases;v_now timestamptz:=clock_timestamp();v_retry integer;
begin
 if not public.xelay_security_is_trusted_backend() then raise exception 'ADMIN_PURCHASE_SERVICE_REQUIRED' using errcode='42501';end if;
 if p_status is null or p_status not in('sent','failed','skipped')
 or p_error_code is not null and p_error_code not in('telegram_rate_limited','telegram_rejected','telegram_unavailable','delivery_unavailable','invalid_context')
 or p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 86400
 or p_status='sent' and (p_error_code is not null or coalesce(p_retry_after_seconds,0)>0) then
  raise exception 'ADMIN_PURCHASE_INVALID_RECEIPT' using errcode='22023';end if;
 select * into q from xelay_admin_notifications.purchases where lease_token=p_token and status='pending' and lease_until>v_now for update;
 if not found then return false;end if;
 v_retry:=greatest(coalesce(p_retry_after_seconds,0),least(21600,60*(2^least(q.attempts,8))::integer));
 update xelay_admin_notifications.purchases set status=case when p_status='failed' then 'pending' else p_status end,
 sent_at=case when p_status='sent' then v_now else sent_at end,lease_token=null,lease_until=null,last_error_code=p_error_code,
 next_attempt_at=v_now+make_interval(secs=>v_retry) where order_id=q.order_id;
 return true;
end$$;
revoke all on function public.xelay_claim_admin_purchase_alert(),public.xelay_admin_purchase_alert_delivery_context(uuid),
 public.xelay_finish_admin_purchase_alert(uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_claim_admin_purchase_alert(),public.xelay_admin_purchase_alert_delivery_context(uuid),
 public.xelay_finish_admin_purchase_alert(uuid,text,text,integer) to service_role;
comment on schema xelay_admin_notifications is 'Private administrator purchase receipts. No email, card details or provider secrets. No historic purchases are enqueued.';
notify pgrst,'reload schema';
commit;
