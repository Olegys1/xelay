-- Optional conference identifiers/passcodes use the timetable's existing
-- private group permissions. No old values, memberships or ACLs are changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.study_group_schedule
  add column conference_id text,
  add column conference_access_code text,
  add constraint study_group_schedule_conference_id_check check(conference_id is null or (
    char_length(conference_id) between 1 and 120 and conference_id !~ '[[:cntrl:]]'
    and conference_id !~ U&'[\0080-\009F\202A-\202E\2066-\2069]')),
  add constraint study_group_schedule_conference_access_code_check check(conference_access_code is null or (
    char_length(conference_access_code) between 1 and 120 and conference_access_code !~ '[[:cntrl:]]'
    and conference_access_code !~ U&'[\0080-\009F\202A-\202E\2066-\2069]'));
comment on column public.study_group_schedule.conference_id is
  'Optional conference/meeting ID entered by a schedule editor, visible only to the existing permitted group audience. No URL required.';
comment on column public.study_group_schedule.conference_access_code is
  'Optional meeting passcode, preserving case and interior spaces; follows the same private timetable permissions as conference_id.';

create function public.xelay_normalize_schedule_conference_access()
returns trigger language plpgsql set search_path='' as $$
begin
  -- Validate before trimming so control characters cannot disappear silently.
  if coalesce(new.conference_id,'') ~ '[[:cntrl:]]'
    or coalesce(new.conference_access_code,'') ~ '[[:cntrl:]]'
    or coalesce(new.conference_id,'') ~ U&'[\0080-\009F\202A-\202E\2066-\2069]'
    or coalesce(new.conference_access_code,'') ~ U&'[\0080-\009F\202A-\202E\2066-\2069]' then
    raise exception 'STUDY_GROUP_CONFERENCE_ACCESS_INVALID' using errcode='22023';
  end if;
  new.conference_id:=nullif(btrim(new.conference_id),'');
  new.conference_access_code:=nullif(btrim(new.conference_access_code),'');
  if char_length(new.conference_id)>120 or char_length(new.conference_access_code)>120 then
    raise exception 'STUDY_GROUP_CONFERENCE_ACCESS_INVALID' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.xelay_normalize_schedule_conference_access() from public,anon,authenticated,service_role;
create trigger study_group_schedule_conference_access before insert or update of conference_id,conference_access_code
  on public.study_group_schedule for each row execute function public.xelay_normalize_schedule_conference_access();

-- Patch the installed bodies with guarded anchors, retaining every permission,
-- conflict/signature check and each function's owner, config and execute ACL.
create function pg_temp.xelay_conference_patch(p_signature text,p_old text,p_new text,p_count integer default 1)
returns void language plpgsql as $$
declare v_body text;v_old text;v_new text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'SCHEDULE_CONFERENCE_PREREQUISITE: %',p_signature;end if;
  v_body:=replace(pg_get_functiondef(to_regprocedure(p_signature)),E'\r\n',E'\n');
  v_old:=replace(p_old,E'\r\n',E'\n');v_new:=replace(p_new,E'\r\n',E'\n');
  if v_old='' then raise exception 'SCHEDULE_CONFERENCE_EMPTY_ANCHOR';end if;
  v_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  if v_count<>p_count then raise exception 'SCHEDULE_CONFERENCE_CONTRACT_MISMATCH: % (% matches, expected %)',p_signature,v_count,p_count;end if;
  execute replace(v_body,v_old,v_new);
end $$;

select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '  v_location text;',E'  v_location text;\n  v_conference_id text; v_conference_access_code text;');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '''weekday'',''starts_at'',''ends_at'',''subject'',''lesson_type'',''location'',''teacher_name'',''online_url'',',
  '''weekday'',''starts_at'',''ends_at'',''subject'',''lesson_type'',''location'',''teacher_name'',''conference_id'',''conference_access_code'',''online_url'',');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '[''lesson_type'',''location'',''teacher_name'',''online_url'',''online_url_secondary'',',
  '[''lesson_type'',''location'',''teacher_name'',''conference_id'',''conference_access_code'',''online_url'',''online_url_secondary'',');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '    v_location := btrim(coalesce(v_item->>''location'',''''));',
  E'    v_location := btrim(coalesce(v_item->>''location'',''''));\n    v_conference_id := v_item->>''conference_id'';\n    v_conference_access_code := v_item->>''conference_access_code'';');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '        and s.online_url_secondary_label is not distinct from v_online_url_secondary_label',
  E'        and s.online_url_secondary_label is not distinct from v_online_url_secondary_label\n        and s.conference_id is not distinct from nullif(btrim(v_conference_id),'''')\n        and s.conference_access_code is not distinct from nullif(btrim(v_conference_access_code),'''')');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,online_url,',
  '      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,conference_id,conference_access_code,online_url,');
select pg_temp.xelay_conference_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_teacher_name,v_online_url,',
  '      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_teacher_name,v_conference_id,v_conference_access_code,v_online_url,');

do $copies$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
    'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'] loop
    -- Every duplicate/conflict comparison retains the complete access tuple.
    perform pg_temp.xelay_conference_patch(v_signature,
      's.online_url_label,s.online_url_secondary_label,s.lesson_number',
      's.online_url_label,s.online_url_secondary_label,s.conference_id,s.conference_access_code,s.lesson_number',3);
    perform pg_temp.xelay_conference_patch(v_signature,
      'source.online_url_label,source.online_url_secondary_label,source.lesson_number',
      'source.online_url_label,source.online_url_secondary_label,source.conference_id,source.conference_access_code,source.lesson_number');
    perform pg_temp.xelay_conference_patch(v_signature,
      '      and s.online_url_secondary_label is not distinct from v_source.online_url_secondary_label',
      E'      and s.online_url_secondary_label is not distinct from v_source.online_url_secondary_label\n      and s.conference_id is not distinct from v_source.conference_id\n      and s.conference_access_code is not distinct from v_source.conference_access_code');
    perform pg_temp.xelay_conference_patch(v_signature,
      '        online_url_label,online_url_secondary_label,',
      '        online_url_label,online_url_secondary_label,conference_id,conference_access_code,');
    perform pg_temp.xelay_conference_patch(v_signature,
      '        v_source.online_url_label,v_source.online_url_secondary_label,',
      '        v_source.online_url_label,v_source.online_url_secondary_label,v_source.conference_id,v_source.conference_access_code,');
  end loop;
end $copies$;
select pg_temp.xelay_conference_patch('public.xelay_private_first_shift_projection(jsonb,jsonb)',
  's->>''online_url_secondary_label'',s->>''lesson_number''',
  's->>''online_url_secondary_label'',s->>''conference_id'',s->>''conference_access_code'',s->>''lesson_number''',2);

do $inheritance$
declare v_signature text;v_prefix text;v_old text;v_new text;v_body text;v_count integer;v_expected integer;
begin
  foreach v_signature in array array[
    'public.xelay_private_schedule_copy_link_guard()',
    'public.xelay_private_schedule_copy_link_propagate()'] loop
    foreach v_prefix in array array['new','old','v_parent','child'] loop
      v_old:=format('row(%1$s.online_url,%1$s.online_url_secondary,%1$s.online_url_label,%1$s.online_url_secondary_label)',v_prefix);
      v_new:=format('row(%1$s.online_url,%1$s.online_url_secondary,%1$s.online_url_label,%1$s.online_url_secondary_label,%1$s.conference_id,%1$s.conference_access_code)',v_prefix);
      select replace(pg_get_functiondef(to_regprocedure(v_signature)),E'\r\n',E'\n') into v_body;
      v_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
      v_expected:=case when v_signature='public.xelay_private_schedule_copy_link_guard()' then
        case v_prefix when 'new' then 2 when 'old' then 1 when 'v_parent' then 1 else 0 end
        else case v_prefix when 'new' then 2 when 'old' then 1 when 'child' then 1 else 0 end end;
      if v_count is distinct from v_expected then
        raise exception 'SCHEDULE_CONFERENCE_INHERITANCE_CONTRACT_MISMATCH: % %',v_signature,v_prefix;
      end if;
      if v_count>0 then perform pg_temp.xelay_conference_patch(v_signature,v_old,v_new,v_count);end if;
    end loop;
  end loop;
end $inheritance$;
select pg_temp.xelay_conference_patch('public.xelay_private_schedule_copy_link_guard()',
  '  new.online_url_secondary_label:=v_parent.online_url_secondary_label;',
  E'  new.online_url_secondary_label:=v_parent.online_url_secondary_label;\n  new.conference_id:=v_parent.conference_id;\n  new.conference_access_code:=v_parent.conference_access_code;');
select pg_temp.xelay_conference_patch('public.xelay_private_schedule_copy_link_propagate()',
  '      online_url_label=new.online_url_label,online_url_secondary_label=new.online_url_secondary_label',
  E'      online_url_label=new.online_url_label,online_url_secondary_label=new.online_url_secondary_label,\n      conference_id=new.conference_id,conference_access_code=new.conference_access_code');
drop trigger study_group_schedule_copy_link_sync on public.study_group_schedule;
create trigger study_group_schedule_copy_link_sync after update of online_url,online_url_secondary,online_url_label,online_url_secondary_label,conference_id,conference_access_code,subject,lesson_type,teacher_name,copied_from_schedule_id,inherit_source_links
  on public.study_group_schedule for each row execute function public.xelay_private_schedule_copy_link_propagate();

-- A manual credential-only weekend lesson is not an empty copy. Repair may
-- inherit from credential-only sources, but never replace custom access data.
do $repair$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_admin_schedule_copy_link_repair(uuid,boolean,text,uuid)',
    'public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)'] loop
    perform pg_temp.xelay_conference_patch(v_signature,
      'and nullif(btrim(t.online_url_label),'''') is null and nullif(btrim(t.online_url_secondary_label),'''') is null',
      'and nullif(btrim(t.online_url_label),'''') is null and nullif(btrim(t.online_url_secondary_label),'''') is null and t.conference_id is null and t.conference_access_code is null',2);
    perform pg_temp.xelay_conference_patch(v_signature,
      'and(nullif(btrim(s.online_url),'''') is not null or nullif(btrim(s.online_url_secondary),'''') is not null)',
      'and(nullif(btrim(s.online_url),'''') is not null or nullif(btrim(s.online_url_secondary),'''') is not null or s.conference_id is not null or s.conference_access_code is not null)');
  end loop;
end $repair$;

notify pgrst,'reload schema';
commit;
