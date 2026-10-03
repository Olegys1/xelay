-- Seven days of server-authoritative access for each newly created study group.
-- Requires the functional study-group/annual/deputy/timetable schema through
-- 202610030003. Also compatible with the later security migrations: their
-- private-media guards are not changed or required by this group-only feature.
-- Existing free/lifetime/annual licenses and all group data are preserved.
-- No card collection, recurring charge or automatic renewal.
begin;

do $$
declare
  v_required record;
  v_column text;
  v_signature text;
  v_relation regclass;
  v_missing text[] := '{}';
begin
  -- Check the objects this migration actually uses, rather than a marker for
  -- unrelated chat/storage remediation. Refuse before any DDL and name every
  -- missing dependency, including the cleanup receipt columns used below.
  for v_required in select * from (values
    ('public.study_groups',array['id','representative_id']),
    ('public.study_group_members',array['group_id','user_id','status']),
    ('public.study_group_schedule',array['group_id']),
    ('public.study_group_homework',array['group_id']),
    ('public.study_group_seminars',array['resource_attachments']),
    ('public.study_group_seminar_file_cleanup',array['storage_path','cleanup_user_id','owner_id']),
    ('public.study_group_timetable_photos',array['storage_path']),
    ('public.study_group_timetable_photo_cleanup',array['storage_path','group_id','cleanup_user_id','owner_id']),
    ('public.billing_settings',array['singleton','enforce_group_payment']),
    ('public.group_entitlements',array['group_id','source','order_id','revoked_at','created_at']),
    ('public.group_annual_entitlements',array['id','group_id','order_id','term_months','valid_from','valid_until','revoked_at','created_at']),
    ('public.participant_entitlements',array['id','user_id','order_id','source','term_months','valid_from','valid_until','revoked_at','created_at']),
    ('public.billing_orders',array['id','user_id','product','group_id','order_reference','amount','currency','mode','status','provider_status','provider_fee','approved_at','updated_at','group_term_months']),
    ('public.billing_payment_events',array['order_id','fingerprint','provider_status','amount','mode']),
    ('public.billing_audit_log',array['action','target_user_id','group_id','detail']),
    ('storage.objects',array['bucket_id','name'])
  ) as required(table_name,column_names)
  loop
    v_relation := to_regclass(v_required.table_name);
    if v_relation is null or not exists(select 1 from pg_catalog.pg_class
      where oid=v_relation and relkind in ('r','p')) then
      v_missing := array_append(v_missing,'table ' || v_required.table_name);
      continue;
    end if;
    foreach v_column in array v_required.column_names loop
      if not exists(select 1 from pg_catalog.pg_attribute
        where attrelid=v_relation and attname=v_column and attnum>0 and not attisdropped) then
        v_missing := array_append(v_missing,'column ' || v_required.table_name || '.' || v_column);
      end if;
    end loop;
  end loop;

  foreach v_signature in array array[
    'auth.uid()',
    'auth.role()',
    'public.xelay_create_study_group(uuid)',
    'public.xelay_can_view_study_group(uuid)',
    'public.xelay_is_study_group_representative(uuid)',
    'public.xelay_study_group_permissions(uuid)',
    'public.xelay_has_study_group_permission(uuid,text)',
    'public.xelay_homework_file_group(text)',
    'public.xelay_timetable_image_group(text)',
    'public.xelay_reflow_participant_access(uuid)',
    'public.xelay_reflow_group_access(uuid)',
    'public.xelay_group_has_access(uuid)',
    'public.xelay_group_billing_status(uuid)',
    'public.xelay_validate_group_license_write()',
    'public.xelay_lock_study_group_permission(uuid,text,boolean)',
    'public.xelay_lock_seminar_group(uuid,boolean)',
    'public.xelay_validate_study_group_delegated_content()',
    'public.xelay_validate_seminar_resources()',
    'public.xelay_validate_study_group_timetable_photo()',
    'public.xelay_can_edit_homework_resources(uuid)',
    'public.xelay_can_upload_seminar_file(text)',
    'public.xelay_can_remove_seminar_file(text)',
    'public.xelay_can_upload_timetable_image(text)',
    'public.xelay_can_remove_timetable_image(text)',
    'public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'
  ] loop
    if to_regprocedure(v_signature) is null then
      v_missing := array_append(v_missing,'function ' || v_signature);
    end if;
  end loop;

  -- Replacing the license helpers only closes direct writes when the existing
  -- enabled mutation triggers still invoke them. This also covers DELETE via
  -- the delegated permission/photo guards; an incomplete schema must not pass.
  for v_required in select * from (values
    ('public.study_group_members','study_group_members_license','public.xelay_validate_group_license_write()',23),
    ('public.study_group_schedule','study_group_schedule_license','public.xelay_validate_group_license_write()',23),
    ('public.study_group_homework','study_group_homework_license','public.xelay_validate_group_license_write()',23),
    ('public.study_group_schedule','study_group_schedule_delegated_guard','public.xelay_validate_study_group_delegated_content()',31),
    ('public.study_group_homework','study_group_homework_delegated_guard','public.xelay_validate_study_group_delegated_content()',31),
    ('public.study_group_seminars','study_group_seminars_resources_validate','public.xelay_validate_seminar_resources()',31),
    ('public.study_group_timetable_photos','study_group_timetable_photo_guard','public.xelay_validate_study_group_timetable_photo()',31)
  ) as required(table_name,trigger_name,function_signature,event_mask)
  loop
    if not exists(select 1 from pg_catalog.pg_trigger t
      where t.tgrelid=to_regclass(v_required.table_name)
        and t.tgname=v_required.trigger_name and not t.tgisinternal
        and t.tgenabled in ('O','A')
        and t.tgfoid=to_regprocedure(v_required.function_signature)
        and (t.tgtype::integer & v_required.event_mask)=v_required.event_mask) then
      v_missing := array_append(v_missing,'enabled trigger ' || v_required.table_name || '.' || v_required.trigger_name
        || ' -> ' || v_required.function_signature);
    end if;
  end loop;

  if cardinality(v_missing)>0 then
    raise exception 'GROUP_TRIAL_PREREQUISITES_MISSING: %',array_to_string(v_missing,', ')
      using errcode='P0001',
        hint='Install or repair the listed functional study-group, annual-billing, deputy and timetable dependencies through 202610030003 before retrying. Do not apply unrelated security migrations merely to satisfy a version marker.';
  end if;
end;
$$;

-- A missing row means a pre-trial group, not an invitation to start a new week.
-- No backfill and no user-facing start/reset endpoint are provided. Group
-- creation requires an approved representative request and is idempotent by
-- that request. Members cannot create/delete study-group rows directly.
create table if not exists public.group_trial_entitlements (
  group_id uuid primary key references public.study_groups(id) on delete cascade,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  constraint group_trial_duration_check check (
    isfinite(started_at) and isfinite(expires_at)
    and expires_at=started_at+interval '168 hours'
  )
);
alter table public.group_trial_entitlements enable row level security;
revoke all on public.group_trial_entitlements from public,anon,authenticated,service_role;
grant select on public.group_trial_entitlements to service_role;

create or replace function public.xelay_guard_group_trial_immutable()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  -- Owner maintenance without a caller JWT is reserved for migration/recovery.
  -- No application role has INSERT/UPDATE/DELETE privileges on this table.
  if auth.uid() is not null or auth.role() in ('anon','authenticated','service_role') then
    raise exception 'GROUP_TRIAL_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end;
$$;
drop trigger if exists group_trial_immutable on public.group_trial_entitlements;
create trigger group_trial_immutable before update on public.group_trial_entitlements
  for each row execute function public.xelay_guard_group_trial_immutable();

-- Stop the old one-off global free promotion for future groups. Its existing
-- grants and the historical claimed flag are deliberately left untouched.
drop trigger if exists study_group_first_license on public.study_groups;
create or replace function public.xelay_claim_first_group_license()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  return new;
end;
$$;

create or replace function public.xelay_claim_group_trial()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_started_at timestamptz := clock_timestamp();
begin
  if not exists(select 1 from public.group_entitlements
    where group_id=new.id and revoked_at is null) then
    insert into public.group_trial_entitlements(group_id,started_at,expires_at)
      values(new.id,v_started_at,v_started_at+interval '168 hours')
      on conflict(group_id) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_trial_license on public.study_groups;
create trigger study_group_trial_license after insert on public.study_groups
  for each row execute function public.xelay_claim_group_trial();

-- Use the database clock at each access check, including in an already open
-- transaction. Local time, a changed group.created_at or a stale browser cannot
-- lengthen the interval. Existing lifetime grants always remain effective.
create or replace function public.xelay_group_has_access(p_group_id uuid)
returns boolean language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_now timestamptz := clock_timestamp();
begin
  return exists(select 1 from public.group_entitlements
      where group_id=p_group_id and revoked_at is null)
    or exists(select 1 from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null
        and valid_from<=v_now and valid_until>v_now)
    or exists(select 1 from public.group_trial_entitlements
      where group_id=p_group_id and started_at<=v_now and expires_at>v_now);
end;
$$;

-- The historical global switch still controls pre-trial groups. New trial
-- group expiry closes writes even while that old switch is false.
create or replace function public.xelay_group_enforcement_required(p_group_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp
as $$
  select exists(select 1 from public.group_trial_entitlements where group_id=p_group_id)
    or coalesce((select enforce_group_payment from public.billing_settings where singleton),true);
$$;
create or replace function public.xelay_group_write_access(p_group_id uuid)
returns boolean language sql volatile security definer set search_path=public,pg_temp
as $$
  select exists(select 1 from public.study_groups where id=p_group_id)
    and (public.xelay_group_has_access(p_group_id)
      or not public.xelay_group_enforcement_required(p_group_id));
$$;

create or replace function public.xelay_group_billing_status(p_group_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_active boolean; v_enforced boolean; v_source text; v_rep boolean;
  v_lifetime boolean; v_expires_at timestamptz; v_trial public.group_trial_entitlements%rowtype;
  v_paid_expires_at timestamptz; v_now timestamptz := clock_timestamp(); v_trial_current boolean;
begin
  if auth.uid() is null or not public.xelay_can_view_study_group(p_group_id) then
    raise exception 'Permission denied' using errcode='42501';
  end if;
  select * into v_trial from public.group_trial_entitlements where group_id=p_group_id;
  v_trial_current := coalesce(v_trial.started_at<=v_now and v_trial.expires_at>v_now,false);
  select source into v_source from public.group_entitlements
    where group_id=p_group_id and revoked_at is null;
  v_lifetime := v_source is not null;
  if not v_lifetime then
    select max(valid_until) into v_paid_expires_at from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null;
    v_expires_at := greatest(v_paid_expires_at,v_trial.expires_at);
    -- An annual payment during trial reserves the full paid year after the
    -- remaining free time. Display it as a paid, renewable group.
    if exists(select 1 from public.group_annual_entitlements
      where group_id=p_group_id and revoked_at is null and valid_until>v_now
        and (valid_from<=v_now or v_trial_current)) then
      v_source := 'payment';
    elsif v_trial_current then v_source := 'trial';
    end if;
  end if;
  v_active := public.xelay_group_has_access(p_group_id);
  v_enforced := public.xelay_group_enforcement_required(p_group_id);
  v_rep := public.xelay_is_study_group_representative(p_group_id);
  return jsonb_build_object('is_active',v_active,'source',v_source,'price',750,
    'is_representative',v_rep,'enforcement_enabled',v_enforced,
    'payment_required',v_enforced and not v_active,
    'can_edit',v_rep and (v_active or not v_enforced),
    'can_participate',v_active or not v_enforced,
    'expires_at',v_expires_at,'is_lifetime',v_lifetime,
    'can_renew',v_rep and not v_lifetime,'billing_period_months',12,
    'trial_days',7,'trial_used',v_trial.group_id is not null,
    'trial_started_at',v_trial.started_at,'trial_expires_at',v_trial.expires_at,
    'server_now',v_now,
    'remaining_seconds',case when v_expires_at is null then null
      else greatest(0,floor(extract(epoch from (v_expires_at-v_now)))::bigint) end);
end;
$$;

-- Self-removal retains established ACL/exception. Accepted content stays
-- readable after expiry; invitations/content changes require write access.
create or replace function public.xelay_validate_group_license_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if not public.xelay_group_write_access(new.group_id) then
    if tg_table_name='study_group_members' then
      if new.user_id=auth.uid() and new.status='accepted'
        and public.xelay_is_study_group_representative(new.group_id) then return new; end if;
      if tg_op='UPDATE' and new.status in ('rejected','removed') then return new; end if;
    end if;
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
  return new;
end;
$$;

-- Preserve role locks and deputy permissions. For trial groups academic DELETE
-- also needs active access; deputy appointments retain administrative ACL.

create or replace function public.xelay_lock_study_group_permission(
  p_group_id uuid,p_permission text,p_require_license boolean default true
)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists (select 1 from public.study_groups where id=p_group_id) then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  if not public.xelay_has_study_group_permission(p_group_id,p_permission) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  if (p_require_license or (exists(select 1 from public.group_trial_entitlements where group_id=p_group_id)
    and p_permission in ('schedule','homework','seminars','seminar_resources')))
    and not public.xelay_group_write_access(p_group_id) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
end;
$$;

create or replace function public.xelay_lock_seminar_group(p_group_id uuid,p_representative boolean)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'SEMINAR_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if p_representative then
    perform public.xelay_lock_study_group_permission(p_group_id,'seminars',true);
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists (select 1 from public.study_groups where id=p_group_id) then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if not exists (select 1 from public.study_groups g where g.id=p_group_id and (
    g.representative_id=auth.uid() or exists (select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=auth.uid() and m.status='accepted')
  )) then raise exception 'SEMINAR_MEMBER_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_group_write_access(p_group_id) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
end;
$$;

-- Existing owner/path/permission/link/cleanup guards remain in place. Only
-- the license gate changes; detached private garbage can still be removed.
create or replace function public.xelay_can_edit_homework_resources(p_group_id uuid)
returns boolean language sql volatile security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and 'homework'=any(public.xelay_study_group_permissions(p_group_id))
    and public.xelay_group_write_access(p_group_id);
$$;

create or replace function public.xelay_can_upload_seminar_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null or split_part(p_name,'/',2)<>auth.uid()::text then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  return public.xelay_has_study_group_permission(v_group_id,'seminar_resources') and public.xelay_group_write_access(v_group_id);
end;
$$;

create or replace function public.xelay_can_remove_seminar_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_name,0));
  if exists (select 1 from public.study_group_seminars s
    where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))) then return false; end if;
  -- An existing own cleanup receipt only grants deletion of detached garbage.
  -- It survives role/group removal and can never edit/reveal an attached file.
  if exists (select 1 from public.study_group_seminar_file_cleanup c
    where c.storage_path=p_name and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid())) then return true; end if;
  if split_part(p_name,'/',2)=auth.uid()::text and exists (select 1 from storage.objects o
    where o.bucket_id='xelay-seminar-files' and o.name=p_name
    and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then return true; end if;
  return public.xelay_has_study_group_permission(v_group_id,'seminar_resources')
    and public.xelay_group_write_access(v_group_id);
end;
$$;

create or replace function public.xelay_can_upload_timetable_image(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_timetable_image_group(p_name);
begin
  if auth.uid() is null or v_group_id is null
    or split_part(p_name,'/',2)<>auth.uid()::text then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || p_name,0));
  return public.xelay_has_study_group_permission(v_group_id,'schedule')
    and public.xelay_group_write_access(v_group_id);
end;
$$;

create or replace function public.xelay_can_remove_timetable_image(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_timetable_image_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || p_name,0));
  if exists (select 1 from public.study_group_timetable_photos p
    where p.storage_path=p_name) then return false; end if;
  -- A replacement actor's receipt survives role loss and grants only this
  -- detached path. It cannot expose or remove a currently attached photo.
  if exists (select 1 from public.study_group_timetable_photo_cleanup c
    where c.storage_path=p_name and c.group_id=v_group_id
      and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid())) then
    return true;
  end if;
  -- Real owners can clean up detached uploads after losing their group role.
  if split_part(p_name,'/',2)=auth.uid()::text
    and exists (select 1 from storage.objects o
      where o.bucket_id='xelay-timetable-images' and o.name=p_name
        and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then
    return true;
  end if;
  return public.xelay_has_study_group_permission(v_group_id,'schedule')
    and public.xelay_group_write_access(v_group_id);
end;
$$;

-- Refunding queued/current paid years never consumes or restarts the week.
create or replace function public.xelay_reflow_group_access(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_entitlement record; v_cursor timestamptz := now(); v_until timestamptz;
begin
  if p_group_id is null then raise exception 'Group required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || p_group_id::text,0));
  select greatest(v_cursor,coalesce(expires_at,v_cursor)) into v_until
    from public.group_trial_entitlements where group_id=p_group_id;
  v_cursor := greatest(v_cursor,v_until);
  for v_entitlement in
    select id,valid_from,valid_until,term_months from public.group_annual_entitlements
    where group_id=p_group_id and revoked_at is null and valid_until>now()
    order by valid_from,created_at,id for update
  loop
    if v_entitlement.valid_from<=now() then
      v_cursor := greatest(v_cursor,v_entitlement.valid_until);
    else
      v_until := ((v_cursor at time zone 'Europe/Kyiv')
        + make_interval(months=>v_entitlement.term_months)) at time zone 'Europe/Kyiv';
      update public.group_annual_entitlements
        set valid_from=v_cursor,valid_until=v_until where id=v_entitlement.id;
      v_cursor := v_until;
    end if;
  end loop;
end;
$$;

-- Callback verification, event idempotency, test/live separation, old
-- lifetime settlement, refunds and participant purchases are unchanged.
create or replace function public.xelay_apply_billing_event(
  p_reference text,p_mode text,p_fingerprint text,p_status text,p_amount numeric,p_currency text,p_fee numeric default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_order public.billing_orders%rowtype; v_from timestamptz; v_rows integer;
  v_duplicate_group boolean := false;
begin
  select * into v_order from public.billing_orders where order_reference=p_reference for update;
  if not found or v_order.mode is distinct from p_mode
    or v_order.amount is distinct from p_amount or p_currency is distinct from 'UAH' then
    raise exception 'Payment order mismatch';
  end if;
  if p_fingerprint is null or length(p_fingerprint)<>64 or p_status is null then
    raise exception 'Payment event required';
  end if;
  if v_order.product='participant' then
    perform pg_advisory_xact_lock(hashtextextended('xelay:premium:' || v_order.user_id::text,0));
  else
    perform pg_advisory_xact_lock(hashtextextended('xelay:group-order:' || v_order.group_id::text,0));
  end if;
  insert into public.billing_payment_events(order_id,fingerprint,provider_status,amount,mode)
    values(v_order.id,p_fingerprint,p_status,p_amount,p_mode) on conflict(fingerprint) do nothing;
  get diagnostics v_rows=row_count;
  if v_rows=0 then return jsonb_build_object('duplicate',true,'status',v_order.status); end if;
  if p_status='Approved' and v_order.status not in('approved','refunded','voided') then
    update public.billing_orders set status='approved',provider_status=p_status,
      provider_fee=p_fee,approved_at=now(),updated_at=now() where id=v_order.id;
    -- Test orders remain history entries and never grant production access.
    if p_mode='live' then
      if v_order.product='participant' then
        perform public.xelay_reflow_participant_access(v_order.user_id);
        select greatest(now(),coalesce(max(valid_until),now())) into v_from
          from public.participant_entitlements
          where user_id=v_order.user_id and revoked_at is null and valid_until>now();
        insert into public.participant_entitlements(user_id,order_id,source,term_months,valid_from,valid_until)
          values(v_order.user_id,v_order.id,'payment',1,v_from,
            ((v_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv')
          on conflict(order_id) do nothing;
      elsif exists(select 1 from public.group_entitlements
        where group_id=v_order.group_id and revoked_at is null) then
        v_duplicate_group := true;
        insert into public.billing_audit_log(action,target_user_id,group_id,detail)
          values('duplicate_group_payment',v_order.user_id,v_order.group_id,
            jsonb_build_object('order_id',v_order.id,'order_reference',p_reference,
              'reason','Група вже має безстроковий доступ. Перевірте повторну оплату та повернення коштів.'));
      elsif v_order.group_term_months=12 then
        perform public.xelay_reflow_group_access(v_order.group_id);
        select greatest(now(),coalesce(max(valid_until),now()),
          coalesce((select expires_at from public.group_trial_entitlements
            where group_id=v_order.group_id),now())) into v_from
          from public.group_annual_entitlements
          where group_id=v_order.group_id and revoked_at is null and valid_until>now();
        insert into public.group_annual_entitlements(group_id,order_id,term_months,valid_from,valid_until)
          values(v_order.group_id,v_order.id,12,v_from,
            ((v_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')
          on conflict(order_id) do nothing;
      else
        -- A checkout opened before this migration keeps its lifetime contract.
        insert into public.group_entitlements(group_id,source,order_id)
          values(v_order.group_id,'payment',v_order.id)
          on conflict(group_id) do update set source='payment',order_id=excluded.order_id,
            revoked_at=null,created_at=now() where group_entitlements.revoked_at is not null;
      end if;
    end if;
  elsif p_status in('Refunded','Voided') then
    update public.billing_orders
      set status=case when p_status='Refunded' or v_order.status='refunded' then 'refunded' else 'voided' end,
        provider_status=case when v_order.status='refunded' then 'Refunded' else p_status end,updated_at=now()
      where id=v_order.id;
    update public.participant_entitlements set revoked_at=now()
      where order_id=v_order.id and revoked_at is null;
    update public.group_entitlements set revoked_at=now()
      where order_id=v_order.id and source='payment' and revoked_at is null;
    update public.group_annual_entitlements set revoked_at=now()
      where order_id=v_order.id and revoked_at is null;
    if p_mode='live' and v_order.product='participant' then
      perform public.xelay_reflow_participant_access(v_order.user_id);
    elsif p_mode='live' and v_order.product='group' then
      perform public.xelay_reflow_group_access(v_order.group_id);
    end if;
  elsif p_status in('Declined','Expired') and v_order.status<>'approved'
    and v_order.status not in('refunded','voided') then
    update public.billing_orders set status=case when p_status='Expired' then 'expired' else 'declined' end,
      provider_status=p_status,updated_at=now() where id=v_order.id;
  else
    update public.billing_orders set provider_status=p_status,updated_at=now() where id=v_order.id;
  end if;
  return jsonb_build_object('duplicate',false,'mode',p_mode,'duplicate_group_payment',v_duplicate_group);
end;
$$;

revoke all on function public.xelay_guard_group_trial_immutable(),
  public.xelay_claim_group_trial(),public.xelay_claim_first_group_license(),
  public.xelay_group_enforcement_required(uuid),public.xelay_group_write_access(uuid),
  public.xelay_validate_group_license_write(),
  public.xelay_lock_study_group_permission(uuid,text,boolean),public.xelay_lock_seminar_group(uuid,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_group_has_access(uuid),public.xelay_group_billing_status(uuid)
  to authenticated,service_role;
revoke all on function public.xelay_can_edit_homework_resources(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_edit_homework_resources(uuid) to authenticated;
revoke all on function public.xelay_can_upload_seminar_file(text),public.xelay_can_remove_seminar_file(text),
  public.xelay_can_upload_timetable_image(text),public.xelay_can_remove_timetable_image(text)
  from public,anon,authenticated,service_role;
-- Storage may evaluate unrelated bucket policies for anonymous requests.
grant execute on function public.xelay_can_upload_seminar_file(text),public.xelay_can_remove_seminar_file(text),
  public.xelay_can_upload_timetable_image(text),public.xelay_can_remove_timetable_image(text)
  to anon,authenticated;
revoke all on function public.xelay_reflow_group_access(uuid),
  public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_reflow_group_access(uuid),
  public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric) to service_role;

comment on table public.group_trial_entitlements is
  'One immutable server-timed 168-hour trial per newly created study-group ID. No retroactive trial/backfill, manual reset or recurring payment. Expiry gates academic writes without deleting group data; pre-existing lifetime grants retain their contract.';
comment on function public.xelay_group_billing_status(uuid) is
  'Member-scoped group billing state. Trial dates and remaining_seconds come from the server; paid annual periods purchased during trial start after remaining free time. Entitlement availability never replaces membership or academic permission checks.';

commit;
