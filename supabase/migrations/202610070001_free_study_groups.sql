-- All existing and future study groups are free, with no trial or expiry.
-- Requires participant billing plus academic/deputy permissions through
-- 202610030002. Trial 202610030016 and unrelated security migrations are optional.
-- Historical purchases, entitlements, events, files and academic data stay intact.
-- This changes price availability only: membership, RLS and delegated permissions
-- remain authoritative for every read and write.
begin;

do $free_groups_preflight$
declare
  v_required record;
  v_signature text;
  v_relation regclass;
  v_missing text[] := '{}';
begin
  for v_required in select * from (values
    ('public.study_groups',array['id','representative_id']),
    ('public.study_group_members',array['group_id','user_id','status']),
    ('public.study_group_deputy_requests',array['group_id','user_id','status','permissions']),
    ('public.study_group_schedule',array['group_id']),
    ('public.study_group_homework',array['group_id']),
    ('public.billing_settings',array['singleton','enforce_group_payment','updated_at']),
    ('public.billing_orders',array['id','user_id','product','group_id','order_reference','amount','mode','status','created_at']),
    ('public.billing_audit_log',array['actor_id','action','detail']),
    ('public.profiles',array['id'])
  ) as required(name,columns)
  loop
    v_relation := to_regclass(v_required.name);
    if v_relation is null then
      v_missing := array_append(v_missing,v_required.name);
    elsif exists(select 1 from unnest(v_required.columns) as required_column(name)
      where not exists(select 1 from pg_attribute a
        where a.attrelid=v_relation and a.attname=required_column.name
          and a.attnum>0 and not a.attisdropped)) then
      v_missing := array_append(v_missing,v_required.name || ' required columns');
    end if;
  end loop;
  foreach v_signature in array array[
    'public.xelay_can_view_study_group(uuid)',
    'public.xelay_is_study_group_representative(uuid)',
    'public.xelay_is_platform_admin()',
    'public.xelay_study_group_permissions(uuid)',
    'public.xelay_has_study_group_permission(uuid,text)',
    'public.xelay_lock_study_group_permission(uuid,text,boolean)',
    'public.xelay_validate_study_group_delegated_content()',
    'public.xelay_group_has_access(uuid)',
    'public.xelay_group_billing_status(uuid)',
    'public.xelay_create_billing_order(uuid,text,text,text,uuid)',
    'public.xelay_admin_set_group_enforcement(boolean,text)'
  ] loop
    if to_regprocedure(v_signature) is null then
      v_missing := array_append(v_missing,v_signature);
    end if;
  end loop;
  -- Price removal must not accidentally ship with unprotected academic tables.
  for v_required in select * from (values
    ('public.study_group_schedule','study_group_schedule_delegated_guard'),
    ('public.study_group_homework','study_group_homework_delegated_guard')
  ) as required(name,trigger_name)
  loop
    v_relation := to_regclass(v_required.name);
    if v_relation is not null and not exists(select 1 from pg_class
      where oid=v_relation and relrowsecurity) then
      v_missing := array_append(v_missing,v_required.name || ' RLS');
    end if;
    if not exists(select 1 from pg_trigger
      where tgrelid=v_relation and tgname=v_required.trigger_name
        and not tgisinternal and tgenabled in('O','A')
        and tgfoid=to_regprocedure('public.xelay_validate_study_group_delegated_content()')) then
      v_missing := array_append(v_missing,v_required.name || '.' || v_required.trigger_name);
    end if;
  end loop;
  if cardinality(v_missing)>0 then
    raise exception 'FREE_GROUPS_PREREQUISITES_MISSING: %',array_to_string(v_missing,', ')
      using hint='Apply the functional billing/deputy/academic permission migrations through 202610030002 first. This migration is atomic and has made no changes.';
  end if;
end;
$free_groups_preflight$;

-- Retain historical first-free/trial records without issuing more trial grants.
drop trigger if exists study_group_first_license on public.study_groups;
drop trigger if exists study_group_trial_license on public.study_groups;

-- These are financial availability predicates, not authorization predicates.
-- Callers retain their existing membership and role checks in policies/triggers.
create or replace function public.xelay_group_has_access(p_group_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $free_group_access$
  select exists(select 1 from public.study_groups where id=p_group_id);
$free_group_access$;

create or replace function public.xelay_group_enforcement_required(p_group_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $free_group_enforcement$
  select false;
$free_group_enforcement$;

create or replace function public.xelay_group_write_access(p_group_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $free_group_write_access$
  select exists(select 1 from public.study_groups where id=p_group_id);
$free_group_write_access$;

create or replace function public.xelay_group_billing_status(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $free_group_status$
declare v_rep boolean;
begin
  if auth.uid() is null or not public.xelay_can_view_study_group(p_group_id) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  v_rep := public.xelay_is_study_group_representative(p_group_id);
  return jsonb_build_object(
    'is_active',true,'is_free',true,'source','free','price',0,
    'is_representative',v_rep,'enforcement_enabled',false,
    'payment_required',false,'can_edit',v_rep,'can_participate',true,
    'expires_at',null,'is_lifetime',true,'can_renew',false,
    'billing_period_months',0,'trial_days',0,'trial_used',false,
    'trial_started_at',null,'trial_expires_at',null,
    'server_now',now(),'remaining_seconds',null);
end;
$free_group_status$;

-- Authenticated, content-free readiness signal for the one-time announcement.
-- It exists only after the database pricing policy has been installed.
create or replace function public.xelay_free_groups_available()
returns boolean language sql stable set search_path = ''
as $free_groups_available$ select true; $free_groups_available$;

-- Older academic helpers still join the singleton settings row. Preserve its
-- historical flags, and safely recreate it if it was removed administratively.
insert into public.billing_settings(singleton,enforce_group_payment)
  values(true,false) on conflict(singleton) do update
    set enforce_group_payment=false,updated_at=now();

-- Keep the historical administrative RPC, but prevent stale clients/settings
-- from re-enabling a group paywall under the current free public terms.
create or replace function public.xelay_admin_set_group_enforcement(p_enabled boolean,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $free_group_admin_enforcement$
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Admin permission required' using errcode='42501';
  end if;
  if p_enabled is null or length(btrim(coalesce(p_reason,''))) not between 5 and 500 then
    raise exception 'Provide an audit reason';
  end if;
  if p_enabled then raise exception 'GROUPS_ARE_FREE' using errcode='22023'; end if;
  update public.billing_settings set enforce_group_payment=false,updated_at=now() where singleton;
  insert into public.billing_audit_log(actor_id,action,detail)
    values(auth.uid(),'set_group_enforcement',jsonb_build_object('enabled',false,'reason',btrim(p_reason)));
end;
$free_group_admin_enforcement$;

-- Participant ordering retains the existing price, pending-order reuse and rate
-- limit. Historical group orders are never altered or deleted by this migration.
create or replace function public.xelay_create_billing_order(
  p_user_id uuid,p_product text,p_mode text,p_order_reference text,p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path = ''
as $free_group_billing_order$
declare v_order public.billing_orders%rowtype; v_count integer;
begin
  if p_product='group' then raise exception 'GROUPS_ARE_FREE' using errcode='22023'; end if;
  if p_user_id is null or p_mode is null or p_product is null
    or p_mode not in('test','live') or p_product<>'participant' then
    raise exception 'Invalid billing product/mode';
  end if;
  if p_group_id is not null then raise exception 'Participant order cannot include group'; end if;
  if p_order_reference is null or length(p_order_reference)>100 then raise exception 'Order reference required'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Profile required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));
  select * into v_order from public.billing_orders
    where user_id=p_user_id and product='participant' and mode=p_mode and group_id is null
      and status='pending' and created_at>now()-interval '1 hour'
    order by created_at desc limit 1;
  if found then return to_jsonb(v_order); end if;
  select count(*) into v_count from public.billing_orders
    where user_id=p_user_id and created_at>now()-interval '1 hour';
  if v_count>=10 then raise exception 'CHECKOUT_RATE_LIMIT'; end if;
  insert into public.billing_orders(user_id,product,group_id,order_reference,amount,mode)
    values(p_user_id,'participant',null,p_order_reference,100,p_mode)
    returning * into v_order;
  return to_jsonb(v_order);
end;
$free_group_billing_order$;

-- Also block direct server inserts or conversion of a participant order into a
-- group order. Updates to an unchanged historical group order (status, consent,
-- reconciliation or refund) remain supported.
create or replace function public.xelay_reject_new_paid_group_order()
returns trigger language plpgsql set search_path = ''
as $free_group_order_guard$
begin
  if new.product='group' then
    if tg_op='INSERT' then raise exception 'GROUPS_ARE_FREE' using errcode='22023'; end if;
    if old.product is distinct from new.product or old.group_id is distinct from new.group_id then
      raise exception 'GROUPS_ARE_FREE' using errcode='22023';
    end if;
  end if;
  return new;
end;
$free_group_order_guard$;
drop trigger if exists billing_orders_free_group_guard on public.billing_orders;
create trigger billing_orders_free_group_guard before insert or update of product,group_id
  on public.billing_orders for each row execute function public.xelay_reject_new_paid_group_order();

revoke all on function public.xelay_group_has_access(uuid),
  public.xelay_group_enforcement_required(uuid),public.xelay_group_write_access(uuid),
  public.xelay_group_billing_status(uuid),public.xelay_free_groups_available(),
  public.xelay_admin_set_group_enforcement(boolean,text),
  public.xelay_create_billing_order(uuid,text,text,text,uuid),
  public.xelay_reject_new_paid_group_order() from public,anon,authenticated,service_role;
grant execute on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid)
  to authenticated,service_role;
grant execute on function public.xelay_free_groups_available(),public.xelay_admin_set_group_enforcement(boolean,text)
  to authenticated;
grant execute on function public.xelay_create_billing_order(uuid,text,text,text,uuid) to service_role;

comment on function public.xelay_group_has_access(uuid) is
  'Permanent free financial availability for every existing study group. Does not grant membership or academic editing permissions.';
comment on function public.xelay_group_billing_status(uuid) is
  'Member-scoped free group state: no price, trial, expiry or paid renewal. Role and membership checks remain separate and authoritative. Historical orders and entitlements are preserved.';
comment on function public.xelay_free_groups_available() is
  'Authenticated readiness signal for the permanent free study-group announcement.';

commit;
