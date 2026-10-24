-- Weekend copies retain their source for online links. Their dates, times,
-- classroom and homework stay independent; explicitly edited links opt out.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $prerequisites$
begin
  if to_regclass('public.study_group_schedule') is null
    or to_regprocedure('public.xelay_academic_subject_key(text)') is null
    or to_regprocedure('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)') is null
    or to_regprocedure('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)') is null
    or exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='study_group_schedule' and column_name in('copied_from_schedule_id','inherit_source_links')) then
    raise exception 'SCHEDULE_COPY_LINK_INHERITANCE_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $prerequisites$;

create temporary table xelay_schedule_copy_link_baseline on commit drop as
select jsonb_build_object(
  'schedule_count',(select count(*) from public.study_group_schedule),
  'schedule_hash',(select md5(string_agg(to_jsonb(s)::text,E'\n' order by s.id)) from public.study_group_schedule s),
  'homework_count',(select count(*) from public.study_group_homework),
  'seminar_count',(select count(*) from public.study_group_seminars),
  'question_count',(select count(*) from public.study_group_seminar_questions),
  'team_count',(select count(*) from public.study_group_seminar_teams),
  'reservation_count',(select count(*) from public.study_group_seminar_reservations),
  'grade_count',(select count(*) from public.teaching_grades),
  'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
  'schedule_access',(select jsonb_build_object('rls',c.relrowsecurity,'acl',c.relacl::text)
    from pg_class c where c.oid='public.study_group_schedule'::regclass),
  'schedule_policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,
    'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
    order by p.polname) from pg_policy p where p.polrelid='public.study_group_schedule'::regclass),
  'copy_acl',(select jsonb_agg(jsonb_build_object('id',p.oid,'acl',p.proacl::text) order by p.oid)
    from pg_proc p where p.oid in(
      'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure,
      'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'::regprocedure)),
  'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure)
) data;
alter table xelay_schedule_copy_link_baseline enable row level security;

alter table public.study_group_schedule
  add column copied_from_schedule_id uuid references public.study_group_schedule(id) on delete set null,
  add column inherit_source_links boolean not null default false,
  add constraint study_group_schedule_copy_link_parent_required
    check(not inherit_source_links or copied_from_schedule_id is not null);
create index study_group_schedule_copy_link_parent_idx
  on public.study_group_schedule(copied_from_schedule_id) where copied_from_schedule_id is not null;
comment on column public.study_group_schedule.copied_from_schedule_id is
  'Source timetable row for a copied occurrence; same-group, acyclic provenance. Deleting the source preserves copied links.';
comment on column public.study_group_schedule.inherit_source_links is
  'True while both online links and labels follow the source. Manually editing copied links opts out.';

create function public.xelay_private_schedule_copy_link_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_parent public.study_group_schedule%rowtype;
  v_cursor public.study_group_schedule%rowtype;
  v_group uuid;v_next uuid;v_seen uuid[];v_depth integer;
  v_rebind boolean;v_identity_matches boolean;v_links_changed boolean;
begin
  v_group:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  -- This trigger runs before the existing delegated guard. A competing edit
  -- must release its row lock instead of waiting on a source that may need to
  -- update that same child during propagation. Existing RPCs already hold this
  -- group lock; the reentrant try-lock succeeds for them and nested updates.
  if not pg_try_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_group::text,0)) then
    raise exception 'STUDY_GROUP_SCHEDULE_LINKS_BUSY' using errcode='40001';
  end if;
  -- Authorize before the definer-owned source lookup. The existing delegated
  -- guard repeats this check later, including its homework/identity safeguards.
  -- Preserve its narrow privileged parent-deletion cascade exception.
  if tg_op='DELETE' and not exists(select 1 from public.study_groups where id=v_group) then return old;end if;
  perform public.xelay_lock_study_group_permission(v_group,'schedule',tg_op<>'DELETE');
  if tg_op='DELETE' then return old;end if;
  if tg_op='UPDATE' and(new.id is distinct from old.id or new.group_id is distinct from old.group_id) then
    raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
  end if;
  if new.copied_from_schedule_id is null then
    -- Includes the FK's ON DELETE SET NULL. Retain the last saved link values.
    new.inherit_source_links:=false;
    return new;
  end if;
  v_next:=new.copied_from_schedule_id;v_seen:=array[new.id];
  for v_depth in 1..32 loop
    if v_next=any(v_seen) then raise exception 'STUDY_GROUP_SCHEDULE_COPY_CYCLE' using errcode='23514';end if;
    select * into v_cursor from public.study_group_schedule where id=v_next;
    if not found or v_cursor.group_id is distinct from new.group_id then
      raise exception 'STUDY_GROUP_SCHEDULE_COPY_SOURCE_INVALID' using errcode='23514';
    end if;
    if v_depth=1 then v_parent:=v_cursor;end if;
    v_seen:=array_append(v_seen,v_next);
    v_next:=v_cursor.copied_from_schedule_id;
    exit when v_next is null;
    if v_depth=32 then raise exception 'STUDY_GROUP_SCHEDULE_COPY_CHAIN_TOO_LONG' using errcode='23514';end if;
  end loop;
  if not new.inherit_source_links then return new;end if;
  v_identity_matches:=public.xelay_academic_subject_key(new.subject)=public.xelay_academic_subject_key(v_parent.subject)
    and new.lesson_type=v_parent.lesson_type
    and public.xelay_academic_subject_key(new.teacher_name)=public.xelay_academic_subject_key(v_parent.teacher_name);
  v_rebind:=tg_op='INSERT';
  if tg_op='UPDATE' then
    v_rebind:=not old.inherit_source_links or new.copied_from_schedule_id is distinct from old.copied_from_schedule_id;
    v_links_changed:=row(new.online_url,new.online_url_secondary,new.online_url_label,new.online_url_secondary_label)
      is distinct from row(old.online_url,old.online_url_secondary,old.online_url_label,old.online_url_secondary_label);
  end if;
  if not v_identity_matches then
    if v_rebind then raise exception 'STUDY_GROUP_SCHEDULE_COPY_SOURCE_MISMATCH' using errcode='23514';end if;
    new.inherit_source_links:=false;
    return new;
  end if;
  if tg_op='UPDATE' and not v_rebind and v_links_changed and not(
    pg_trigger_depth()>1 and row(new.online_url,new.online_url_secondary,new.online_url_label,new.online_url_secondary_label)
      is not distinct from row(v_parent.online_url,v_parent.online_url_secondary,v_parent.online_url_label,v_parent.online_url_secondary_label)) then
    -- A user's custom or cleared links are an independent choice. Nested
    -- propagation only retains inheritance when it exactly equals this parent.
    new.inherit_source_links:=false;
    return new;
  end if;
  new.online_url:=v_parent.online_url;
  new.online_url_secondary:=v_parent.online_url_secondary;
  new.online_url_label:=v_parent.online_url_label;
  new.online_url_secondary_label:=v_parent.online_url_secondary_label;
  return new;
end $$;
revoke all on function public.xelay_private_schedule_copy_link_guard() from public,anon,authenticated,service_role;
create trigger study_group_schedule_copy_link_guard before insert or update or delete on public.study_group_schedule
  for each row execute function public.xelay_private_schedule_copy_link_guard();

create function public.xelay_private_schedule_copy_link_propagate()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- A subject/type/teacher edit must not turn lecture links into seminar links
  -- in a previously copied occurrence. Such copies retain their saved values.
  update public.study_group_schedule child set inherit_source_links=false
    where child.copied_from_schedule_id=new.id and child.group_id=new.group_id and child.inherit_source_links
      and(public.xelay_academic_subject_key(child.subject) is distinct from public.xelay_academic_subject_key(new.subject)
        or child.lesson_type is distinct from new.lesson_type
        or public.xelay_academic_subject_key(child.teacher_name) is distinct from public.xelay_academic_subject_key(new.teacher_name));
  if row(new.online_url,new.online_url_secondary,new.online_url_label,new.online_url_secondary_label)
      is not distinct from row(old.online_url,old.online_url_secondary,old.online_url_label,old.online_url_secondary_label) then return new;end if;
  update public.study_group_schedule child
    set online_url=new.online_url,online_url_secondary=new.online_url_secondary,
      online_url_label=new.online_url_label,online_url_secondary_label=new.online_url_secondary_label
    where child.copied_from_schedule_id=new.id and child.group_id=new.group_id and child.inherit_source_links
      and public.xelay_academic_subject_key(child.subject)=public.xelay_academic_subject_key(new.subject)
      and child.lesson_type=new.lesson_type
      and public.xelay_academic_subject_key(child.teacher_name)=public.xelay_academic_subject_key(new.teacher_name)
      and row(child.online_url,child.online_url_secondary,child.online_url_label,child.online_url_secondary_label)
        is distinct from row(new.online_url,new.online_url_secondary,new.online_url_label,new.online_url_secondary_label);
  return new;
end $$;
revoke all on function public.xelay_private_schedule_copy_link_propagate() from public,anon,authenticated,service_role;
create trigger study_group_schedule_copy_link_sync after update of online_url,online_url_secondary,online_url_label,online_url_secondary_label,subject,lesson_type,teacher_name,copied_from_schedule_id,inherit_source_links
  on public.study_group_schedule for each row execute function public.xelay_private_schedule_copy_link_propagate();

do $copy_facades$
declare v_signature text;v_body text;v_old text;v_new text;
begin
  foreach v_signature in array array[
    'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
    'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'] loop
    select replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'') into v_body;
    v_old:=$old$valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by$old$;
    v_new:=$new$valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by,copied_from_schedule_id,inherit_source_links$new$;
    if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'SCHEDULE_COPY_LINK_COLUMNS_SOURCE_DRIFT: %',v_signature;end if;
    v_body:=replace(v_body,v_old,v_new);
    v_old:=$old$p_target_date,p_target_date,'every',null,v_source.lesson_number,auth.uid()$old$;
    v_new:=$new$p_target_date,p_target_date,'every',null,v_source.lesson_number,auth.uid(),v_source.id,true$new$;
    if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'SCHEDULE_COPY_LINK_VALUES_SOURCE_DRIFT: %',v_signature;end if;
    execute replace(v_body,v_old,v_new);
  end loop;
end $copy_facades$;

do $unchanged$
declare v_before jsonb;v_after jsonb;
begin
  select data into v_before from xelay_schedule_copy_link_baseline;
  select jsonb_build_object(
    'schedule_count',(select count(*) from public.study_group_schedule),
    'schedule_hash',(select md5(string_agg((to_jsonb(s)-array['copied_from_schedule_id','inherit_source_links'])::text,E'\n' order by s.id)) from public.study_group_schedule s),
    'homework_count',(select count(*) from public.study_group_homework),
    'seminar_count',(select count(*) from public.study_group_seminars),
    'question_count',(select count(*) from public.study_group_seminar_questions),
    'team_count',(select count(*) from public.study_group_seminar_teams),
    'reservation_count',(select count(*) from public.study_group_seminar_reservations),
    'grade_count',(select count(*) from public.teaching_grades),
    'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
    'schedule_access',(select jsonb_build_object('rls',c.relrowsecurity,'acl',c.relacl::text)
      from pg_class c where c.oid='public.study_group_schedule'::regclass),
    'schedule_policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles,
      'cmd',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
      order by p.polname) from pg_policy p where p.polrelid='public.study_group_schedule'::regclass),
    'copy_acl',(select jsonb_agg(jsonb_build_object('id',p.oid,'acl',p.proacl::text) order by p.oid)
      from pg_proc p where p.oid in(
        'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure,
        'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'::regprocedure)),
    'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure)
  ) into v_after;
  if v_before is distinct from v_after then raise exception 'SCHEDULE_COPY_LINK_UNEXPECTED_DATA_OR_ACCESS_CHANGE';end if;
  if exists(select 1 from public.study_group_schedule where copied_from_schedule_id is not null or inherit_source_links) then
    raise exception 'SCHEDULE_COPY_LINK_UNEXPECTED_BACKFILL';
  end if;
end $unchanged$;
notify pgrst,'reload schema';
select jsonb_build_object('release','schedule-copy-link-inheritance-20261024','receipt',gen_random_uuid(),
  'applied_at',clock_timestamp(),'existing_data_unchanged',true,'rls_and_function_access_unchanged',true,
  'automatic_backfill',false,'schedule_count',(select data->'schedule_count' from xelay_schedule_copy_link_baseline),
  'private_helpers_closed',not has_function_privilege('authenticated','public.xelay_private_schedule_copy_link_guard()','execute')
    and not has_function_privilege('anon','public.xelay_private_schedule_copy_link_guard()','execute')
    and not has_function_privilege('authenticated','public.xelay_private_schedule_copy_link_propagate()','execute')
    and not has_function_privilege('anon','public.xelay_private_schedule_copy_link_propagate()','execute')) as schedule_copy_link_release;
commit;
