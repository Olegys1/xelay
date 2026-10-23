-- Optional display-only teacher names on group schedule rows. Existing group
-- membership, representative/deputy permissions and all RPC ACLs stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_import_study_group_timetable(uuid,jsonb)',
    'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
    'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
    'public.xelay_private_first_shift_projection(jsonb,jsonb)',
    'public.xelay_android_widget_snapshot(uuid)',
    'public.xelay_teaching_calendar(date,date)'
  ] loop
    if to_regprocedure(v_signature) is null then raise exception 'TIMETABLE_TEACHER_PREREQUISITE: %',v_signature; end if;
  end loop;
  if to_regclass('public.study_group_schedule') is null
    or exists(select 1 from pg_attribute where attrelid=to_regclass('public.study_group_schedule')
      and attname='teacher_name' and not attisdropped)
    or to_regprocedure('public.xelay_normalize_study_group_schedule_teacher()') is not null then
    raise exception 'TIMETABLE_TEACHER_SCHEMA_DRIFT';
  end if;
end $$;

-- A blank value is intentionally independent of any profile, verified teacher
-- status or teaching-course permission. No existing names are inferred/backfilled.
alter table public.study_group_schedule
  add column teacher_name text not null default '',
  add constraint study_group_schedule_teacher_name_check check(
    char_length(teacher_name)<=180 and teacher_name !~ '[[:cntrl:]]'
    and teacher_name !~ U&'[\0080-\009F\202A-\202E\2066-\2069]');
comment on column public.study_group_schedule.teacher_name is
  'Optional unverified display text (0-180 Unicode characters), entered by a member with schedule editing permission; no account or role assignment.';

create function public.xelay_normalize_study_group_schedule_teacher()
returns trigger language plpgsql set search_path='' as $$
begin
  new.teacher_name:=coalesce(new.teacher_name,'');
  -- Reject control and directional override/isolate characters before whitespace
  -- normalization; never let tabs/newlines disappear into an accepted name.
  if new.teacher_name ~ '[[:cntrl:]]'
    or new.teacher_name ~ U&'[\0080-\009F\202A-\202E\2066-\2069]' then
    raise exception 'STUDY_GROUP_SCHEDULE_TEACHER_INVALID' using errcode='22023';
  end if;
  new.teacher_name:=btrim(regexp_replace(new.teacher_name,
    U&'[[:space:]\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if char_length(new.teacher_name)>180 then
    raise exception 'STUDY_GROUP_SCHEDULE_TEACHER_INVALID' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.xelay_normalize_study_group_schedule_teacher()
  from public,anon,authenticated,service_role;
create trigger study_group_schedule_teacher_name
  before insert or update of teacher_name on public.study_group_schedule
  for each row execute function public.xelay_normalize_study_group_schedule_teacher();

-- Preserve installed definitions, owners and ACLs. Do not replace schedule
-- permission logic from a local historical migration. Every anchor must match
-- exactly once; CRLF is normalized on both installed code and patch literals.
create function pg_temp.xelay_timetable_teacher_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_old text;v_new text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'Missing timetable function: %',p_signature; end if;
  v_definition:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  v_old:=replace(p_old,chr(13),'');v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'Empty timetable teacher anchor'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'Timetable teacher anchor mismatch for % (matches: %)',p_signature,v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

-- Import remains atomic and additive. Its existing duplicate predicate does
-- not use this descriptive field: a changed name cannot create a second copy
-- of an otherwise identical lesson. Old payloads get a blank name on new rows
-- and never clear or overwrite an already saved row.
select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$  v_location text;$old$,
$new$  v_location text;
  v_teacher_name text;$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$'weekday','starts_at','ends_at','subject','lesson_type','location','online_url',$old$,
$new$'weekday','starts_at','ends_at','subject','lesson_type','location','teacher_name','online_url',$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$['lesson_type','location','online_url','online_url_secondary',$old$,
$new$['lesson_type','location','teacher_name','online_url','online_url_secondary',$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$    v_location := btrim(coalesce(v_item->>'location',''));$old$,
$new$    v_location := btrim(coalesce(v_item->>'location',''));
    -- The table trigger validates and canonicalizes this optional display text.
    v_teacher_name := coalesce(v_item->>'teacher_name','');$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,$old$,
$new$      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,online_url,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
$old$      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_online_url,$old$,
$new$      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_teacher_name,v_online_url,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),$old$,
$new$is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),source.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$      and btrim(s.location)=btrim(v_source.location)$old$,
$new$      and btrim(s.location)=btrim(v_source.location)
      and s.teacher_name=v_source.teacher_name$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$        group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,online_url_secondary,$old$,
$new$        group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,online_url,online_url_secondary,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
$old$        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.online_url,v_source.online_url_secondary,$old$,
$new$        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.teacher_name,v_source.online_url,v_source.online_url_secondary,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),$old$,
$new$where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),s.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),$old$,
$new$is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),source.teacher_name,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$      and btrim(s.location)=btrim(v_source.location)$old$,
$new$      and btrim(s.location)=btrim(v_source.location)
      and s.teacher_name=v_source.teacher_name$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$        group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,online_url_secondary,$old$,
$new$        group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,online_url,online_url_secondary,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
$old$        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.online_url,v_source.online_url_secondary,$old$,
$new$        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.teacher_name,v_source.online_url,v_source.online_url_secondary,$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_private_first_shift_projection(jsonb,jsonb)',
$old$select distinct on(s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),$old$,
$new$select distinct on(s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),s->>'teacher_name',$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_private_first_shift_projection(jsonb,jsonb)',
$old$order by s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),$old$,
$new$order by s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),s->>'teacher_name',$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_android_widget_snapshot(uuid)',
$old$
    select s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location
$old$,
$new$
    select s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location,s.teacher_name
$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_android_widget_snapshot(uuid)',
$old$    select d.lesson_date,s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location
$old$,
$new$    select d.lesson_date,s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location,s.teacher_name
$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_android_widget_snapshot(uuid)',
$old$
      select s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location
$old$,
$new$
      select s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location,s.teacher_name
$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_android_widget_snapshot(uuid)',
$old$      'location',coalesce(s.location,''),'url',v_base||p_group_id::text||'?tab=schedule&date='||s.lesson_date::text)$old$,
$new$      'location',coalesce(s.location,''),'teacher_name',s.teacher_name,'url',v_base||p_group_id::text||'?tab=schedule&date='||s.lesson_date::text)$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_android_widget_snapshot(uuid)',
$old$      'location',coalesce(s.location,''),'url',v_base||p_group_id::text||'?tab=schedule&date='||v_tomorrow::text)$old$,
$new$      'location',coalesce(s.location,''),'teacher_name',s.teacher_name,'url',v_base||p_group_id::text||'?tab=schedule&date='||v_tomorrow::text)$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_teaching_calendar(date,date)',
$old$s.id,d.lesson_date,s.starts_at,s.ends_at,s.lesson_type,coalesce(s.location,'') location,'timetable'::text source$old$,
$new$s.id,d.lesson_date,s.starts_at,s.ends_at,s.lesson_type,coalesce(s.location,'') location,s.teacher_name,'timetable'::text source$new$);

select pg_temp.xelay_timetable_teacher_patch('public.xelay_teaching_calendar(date,date)',
$old$s.id,d.lesson_date,coalesce(se.starts_at,s.starts_at),coalesce(se.ends_at,s.ends_at),'seminar'::text,''::text,'seminar'::text$old$,
$new$s.id,d.lesson_date,coalesce(se.starts_at,s.starts_at),coalesce(se.ends_at,s.ends_at),'seminar'::text,''::text,''::text,'seminar'::text$new$);

-- Day-copy sources and first-shift projections include the name in content
-- equality. A destination with a different name remains a conflict. Signatures
-- already use complete source row JSON, so teacher-only edits invalidate stale
-- previews automatically; sequence RPCs delegate to the patched day RPCs.
-- Read projections add display text only, with identical recipients and checks.
notify pgrst,'reload schema';
commit;
