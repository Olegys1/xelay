-- Read-only prerequisite check, extracted from the current group-trial migration.
-- Run in the intended project. No schema, permissions or application data change.
-- Passing this check does not certify the separate security rollout or install trials.
begin;
set transaction read only;
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
select 'GROUP_TRIAL_PREREQUISITES_OK' as status,
  to_regclass('public.group_trial_entitlements') is not null as trial_table_exists;
rollback;
