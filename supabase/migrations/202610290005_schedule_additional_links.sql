-- Additional meeting URLs use the timetable's existing audience and edit
-- permissions. The first two legacy URLs and conference ID/code remain intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$begin
  if to_regclass('public.study_group_schedule') is null
    or to_regprocedure('public.xelay_import_study_group_timetable(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_calendar(date,date)') is null
    or exists(select 1 from pg_attribute where attrelid='public.study_group_schedule'::regclass
      and attname='online_links_extra' and not attisdropped) then
    raise exception 'SCHEDULE_EXTRA_LINKS_PREREQUISITE_OR_SCHEMA_DRIFT';end if;
end $$;

create function public.xelay_normalize_schedule_extra_links(p_links jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_item jsonb;v_url text;v_label text;v_result jsonb:='[]'::jsonb;
begin
  if p_links is null or p_links='null'::jsonb then return v_result;end if;
  if jsonb_typeof(p_links) is distinct from 'array' or jsonb_array_length(p_links)>18
    or octet_length(p_links::text)>65536 then
    raise exception 'STUDY_GROUP_EXTRA_LINKS_INVALID' using errcode='22023';end if;
  for v_item in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in('url','label'))
      or jsonb_typeof(v_item->'url') is distinct from 'string'
      or(v_item ? 'label' and jsonb_typeof(v_item->'label') not in('string','null')) then
      raise exception 'STUDY_GROUP_EXTRA_LINKS_INVALID' using errcode='22023';end if;
    v_url:=v_item->>'url';v_label:=coalesce(v_item->>'label','');
    if v_url ~ '[[:cntrl:]]' or v_label ~ '[[:cntrl:]]'
      or v_url ~ U&'[\0080-\009F\202A-\202E\2066-\2069]'
      or v_label ~ U&'[\0080-\009F\202A-\202E\2066-\2069]' then
      raise exception 'STUDY_GROUP_EXTRA_LINKS_INVALID' using errcode='22023';end if;
    v_url:=btrim(v_url);v_label:=btrim(v_label);
    if v_url='' and v_label='' then continue;end if;
    if char_length(v_url)>2000 or char_length(v_label)>80
      or v_url !~* '^https?://[^/?#[:space:]@]+([/?#][^[:space:]]*)?$' then
      raise exception 'STUDY_GROUP_EXTRA_LINKS_INVALID' using errcode='22023';end if;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('url',v_url,'label',v_label));
  end loop;
  return v_result;
end $$;
revoke all on function public.xelay_normalize_schedule_extra_links(jsonb) from public,anon,authenticated,service_role;
-- Pure validation only; no table, role, token or access lookup is performed.
grant execute on function public.xelay_normalize_schedule_extra_links(jsonb) to authenticated;

alter table public.study_group_schedule add column online_links_extra jsonb not null default '[]'::jsonb,
  add constraint study_group_schedule_extra_links_check
    check(online_links_extra=public.xelay_normalize_schedule_extra_links(online_links_extra));
comment on column public.study_group_schedule.online_links_extra is
  'Up to18 additional {url,label} links after the two established URLs, using the same private timetable permissions. No meeting provider or credentials are inferred.';
create function public.xelay_private_schedule_extra_links_normalize()
returns trigger language plpgsql set search_path='' as $$
begin new.online_links_extra:=public.xelay_normalize_schedule_extra_links(new.online_links_extra);return new;end $$;
revoke all on function public.xelay_private_schedule_extra_links_normalize() from public,anon,authenticated,service_role;
-- Runs before the inheritance guard, which must compare normalized values.
create trigger study_group_schedule_00_extra_links before insert or update of online_links_extra
  on public.study_group_schedule for each row execute function public.xelay_private_schedule_extra_links_normalize();

-- Replace only guarded body anchors, preserving exact LF/CRLF, OID, owner,
-- signature, execute ACL, volatility and every other pg_proc metadata field.
create function pg_temp.xelay_extra_links_patch(p_signature text,p_old text,p_new text,p_count integer default 1)
returns void language plpgsql as $$
declare v_oid oid:=to_regprocedure(p_signature);v_raw text;v_definition text;v_before jsonb;v_after jsonb;
  v_old text;v_new text;v_expected text;v_matches integer;
begin
  if v_oid is null then raise exception 'SCHEDULE_EXTRA_LINKS_ROUTINE_MISSING: %',p_signature;end if;
  select p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' into v_raw,v_definition,v_before from pg_proc p where p.oid=v_oid;
  v_old:=replace(p_old,E'\r\n',E'\n');v_new:=replace(p_new,E'\r\n',E'\n');
  if strpos(v_raw,E'\r\n')>0 then v_old:=replace(v_old,E'\n',E'\r\n');v_new:=replace(v_new,E'\n',E'\r\n');end if;
  if v_old='' then raise exception 'SCHEDULE_EXTRA_LINKS_EMPTY_ANCHOR';end if;
  v_matches:=(length(v_raw)-length(replace(v_raw,v_old,'')))/length(v_old);
  if v_matches<>p_count or strpos(v_definition,v_raw)=0 then
    raise exception 'SCHEDULE_EXTRA_LINKS_SOURCE_DRIFT: % (% matches, expected %)',p_signature,v_matches,p_count;end if;
  v_expected:=replace(v_raw,v_old,v_new);
  execute replace(v_definition,v_raw,v_expected);
  select to_jsonb(p)-'prosrc' into v_after from pg_proc p where p.oid=v_oid;
  if v_before is distinct from v_after or (select prosrc from pg_proc where oid=v_oid) is distinct from v_expected then
    raise exception 'SCHEDULE_EXTRA_LINKS_UNEXPECTED_METADATA_CHANGE: %',p_signature;end if;
end $$;

select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '  v_location text;',E'  v_location text;\n  v_online_links_extra jsonb;');
select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '''online_url_secondary'',''online_url_label'',''online_url_secondary_label'',',
  '''online_url_secondary'',''online_url_label'',''online_url_secondary_label'',''online_links_extra'',');
select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '    v_location := btrim(coalesce(v_item->>''location'',''''));',
  E'    v_location := btrim(coalesce(v_item->>''location'',''''));\n    v_online_links_extra := public.xelay_normalize_schedule_extra_links(v_item->''online_links_extra'');');
select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '        and s.online_url_secondary_label is not distinct from v_online_url_secondary_label',
  E'        and s.online_url_secondary_label is not distinct from v_online_url_secondary_label\n        and s.online_links_extra=v_online_links_extra');
select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,conference_id,conference_access_code,online_url,',
  '      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,conference_id,conference_access_code,online_links_extra,online_url,');
select pg_temp.xelay_extra_links_patch('public.xelay_import_study_group_timetable(uuid,jsonb)',
  '      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_teacher_name,v_conference_id,v_conference_access_code,v_online_url,',
  '      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_teacher_name,v_conference_id,v_conference_access_code,v_online_links_extra,v_online_url,');

do $copy_tuple$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)',
    'public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)',
    'public.xelay_private_copy_schedule_day_custom(uuid,date,date,boolean,text,text,jsonb,text,integer,boolean)'] loop
    perform pg_temp.xelay_extra_links_patch(v_signature,
      's.online_url_label,s.online_url_secondary_label,s.conference_id,s.conference_access_code,s.lesson_number',
      's.online_url_label,s.online_url_secondary_label,s.conference_id,s.conference_access_code,s.online_links_extra,s.lesson_number',3);
    perform pg_temp.xelay_extra_links_patch(v_signature,
      'source.online_url_label,source.online_url_secondary_label,source.conference_id,source.conference_access_code,source.lesson_number',
      'source.online_url_label,source.online_url_secondary_label,source.conference_id,source.conference_access_code,source.online_links_extra,source.lesson_number');
    perform pg_temp.xelay_extra_links_patch(v_signature,
      '      and s.online_url_secondary_label is not distinct from v_source.online_url_secondary_label',
      E'      and s.online_url_secondary_label is not distinct from v_source.online_url_secondary_label\n      and s.online_links_extra=v_source.online_links_extra');
    perform pg_temp.xelay_extra_links_patch(v_signature,
      '        online_url_label,online_url_secondary_label,conference_id,conference_access_code,',
      '        online_url_label,online_url_secondary_label,conference_id,conference_access_code,online_links_extra,');
    perform pg_temp.xelay_extra_links_patch(v_signature,
      '        v_source.online_url_label,v_source.online_url_secondary_label,v_source.conference_id,v_source.conference_access_code,',
      '        v_source.online_url_label,v_source.online_url_secondary_label,v_source.conference_id,v_source.conference_access_code,v_source.online_links_extra,');
  end loop;
end $copy_tuple$;
select pg_temp.xelay_extra_links_patch('public.xelay_private_first_shift_projection(jsonb,jsonb)',
  's->>''online_url_secondary_label'',s->>''conference_id'',s->>''conference_access_code'',s->>''lesson_number''',
  's->>''online_url_secondary_label'',s->>''conference_id'',s->>''conference_access_code'',s->''online_links_extra'',s->>''lesson_number''',2);

do $inherit_tuple$
declare v_signature text;v_prefix text;v_old text;v_new text;v_expected integer;
begin
  foreach v_signature in array array['public.xelay_private_schedule_copy_link_guard()',
    'public.xelay_private_schedule_copy_link_propagate()'] loop
    foreach v_prefix in array array['new','old','v_parent','child'] loop
      v_expected:=case when v_signature='public.xelay_private_schedule_copy_link_guard()' then
        case v_prefix when 'new' then 2 when 'old' then 1 when 'v_parent' then 1 else 0 end
        else case v_prefix when 'new' then 2 when 'old' then 1 when 'child' then 1 else 0 end end;
      if v_expected=0 then continue;end if;
      v_old:=format('row(%1$s.online_url,%1$s.online_url_secondary,%1$s.online_url_label,%1$s.online_url_secondary_label,%1$s.conference_id,%1$s.conference_access_code)',v_prefix);
      v_new:=format('row(%1$s.online_url,%1$s.online_url_secondary,%1$s.online_url_label,%1$s.online_url_secondary_label,%1$s.conference_id,%1$s.conference_access_code,%1$s.online_links_extra)',v_prefix);
      perform pg_temp.xelay_extra_links_patch(v_signature,v_old,v_new,v_expected);
    end loop;
  end loop;
end $inherit_tuple$;
select pg_temp.xelay_extra_links_patch('public.xelay_private_schedule_copy_link_guard()',
  '  new.conference_access_code:=v_parent.conference_access_code;',
  E'  new.conference_access_code:=v_parent.conference_access_code;\n  new.online_links_extra:=v_parent.online_links_extra;');
select pg_temp.xelay_extra_links_patch('public.xelay_private_schedule_copy_link_propagate()',
  '      conference_id=new.conference_id,conference_access_code=new.conference_access_code',
  '      conference_id=new.conference_id,conference_access_code=new.conference_access_code,online_links_extra=new.online_links_extra');
drop trigger study_group_schedule_copy_link_sync on public.study_group_schedule;
create trigger study_group_schedule_copy_link_sync after update of online_url,online_url_secondary,online_url_label,online_url_secondary_label,conference_id,conference_access_code,online_links_extra,subject,lesson_type,teacher_name,copied_from_schedule_id,inherit_source_links
  on public.study_group_schedule for each row execute function public.xelay_private_schedule_copy_link_propagate();

do $repair_tuple$
declare v_signature text;
begin
  foreach v_signature in array array['public.xelay_admin_schedule_copy_link_repair(uuid,boolean,text,uuid)',
    'public.xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)'] loop
    perform pg_temp.xelay_extra_links_patch(v_signature,
      'and t.conference_id is null and t.conference_access_code is null',
      'and t.conference_id is null and t.conference_access_code is null and t.online_links_extra=''[]''::jsonb',2);
    perform pg_temp.xelay_extra_links_patch(v_signature,
      'or s.conference_id is not null or s.conference_access_code is not null)',
      'or s.conference_id is not null or s.conference_access_code is not null or s.online_links_extra<>''[]''::jsonb)');
  end loop;
end $repair_tuple$;

-- The authorized timetable projection used by the teacher home dashboard.
-- Adding display data does not expose student seminar planning or add grants.
select pg_temp.xelay_extra_links_patch('public.xelay_teaching_calendar(date,date)',
  's.teacher_name,s.online_url,s.online_url_secondary,s.conference_id,s.conference_access_code,''timetable''::text source',
  's.teacher_name,s.online_url,s.online_url_secondary,s.conference_id,s.conference_access_code,s.online_links_extra,''timetable''::text source');

notify pgrst,'reload schema';
commit;
