-- Explicit first-shift copies start at 08:00 in chronological order. Old
-- lesson numbers are display metadata, not a condition for copying a day.
-- Original-time copying and all public RPC signatures/ACLs stay unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $migration$
declare
  v_function regprocedure:=to_regprocedure('public.xelay_private_first_shift_projection(jsonb,jsonb)');
  v_definition text; v_old text; v_owner oid; v_acl aclitem[]; v_config text[];
begin
  if v_function is null then
    raise exception 'Apply schedule copy time modes before chronological first-shift copying';
  end if;
  select replace(pg_get_functiondef(oid),E'\r\n',E'\n'),proowner,proacl,proconfig
    into v_definition,v_owner,v_acl,v_config from pg_catalog.pg_proc where oid=v_function;
  if position('s->>''teacher_name''' in v_definition)=0 then
    raise exception 'Apply timetable teacher names before chronological first-shift copying';
  end if;

  v_old:=$old$  v_count integer; v_number integer; v_min integer; v_previous integer; v_rank integer:=0;$old$;
  v_old:=replace(v_old,E'\r\n',E'\n');
  if cardinality(string_to_array(v_definition,v_old))<>2 then raise exception 'FIRST_SHIFT_ORDER_CONTRACT_MISMATCH'; end if;
  v_definition:=replace(v_definition,v_old,'  v_count integer; v_number integer; v_rank integer:=0;');
  v_old:=$old$  v_all_numbered boolean; v_all_unnumbered boolean; v_auto_valid boolean:=true;$old$;
  v_old:=replace(v_old,E'\r\n',E'\n');
  if cardinality(string_to_array(v_definition,v_old))<>2 then raise exception 'FIRST_SHIFT_ORDER_CONTRACT_MISMATCH'; end if;
  v_definition:=replace(v_definition,v_old,'');

  v_old:=$old$  select bool_and((s->>'number_count')::integer=1 and not (s->>'has_null')::boolean),
    bool_and((s->>'number_count')::integer=0),min((s->>'source_number')::integer)
    into v_all_numbered,v_all_unnumbered,v_min from jsonb_array_elements(v_slots) s;
  -- Incomplete/unnumbered days use chronological intervals. Preserve numeric
  -- gaps only when every interval has one consistent, ordered known number.
  if v_all_numbered then
    for v_slot in select value from jsonb_array_elements(v_slots) loop
      v_number:=(v_slot->>'source_number')::integer;
      if v_number is null or v_number not between 1 and 12 or v_number-v_min+1>5
        or (v_previous is not null and v_number<=v_previous) then v_auto_valid:=false; end if;
      v_previous:=v_number;
    end loop;
  end if;
  if not v_auto_valid and jsonb_array_length(v_overrides)<>v_count then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_FIRST_SHIFT_UNMAPPABLE' using errcode='22023';
  end if;
$old$;
  -- A Windows SQL-editor paste can preserve CRLF inside dollar-quoted text.
  -- Normalize the anchor just like the installed definition before comparing.
  v_old:=replace(v_old,E'\r\n',E'\n');
  if cardinality(string_to_array(v_definition,v_old))<>2 then raise exception 'FIRST_SHIFT_ORDER_CONTRACT_MISMATCH'; end if;
  v_definition:=replace(v_definition,v_old,
    E'  -- Chronological source intervals become consecutive morning slots.\n'
    ||E'  -- Explicit reviewed overrides may still retain a deliberate gap.\n');

  v_old:=$old$      v_number:=case when v_all_numbered then (v_slot->>'source_number')::integer-v_min+1 else v_rank end;$old$;
  v_old:=replace(v_old,E'\r\n',E'\n');
  if cardinality(string_to_array(v_definition,v_old))<>2 then raise exception 'FIRST_SHIFT_ORDER_CONTRACT_MISMATCH'; end if;
  v_definition:=replace(v_definition,v_old,'      v_number:=v_rank;');
  execute v_definition;

  -- CREATE OR REPLACE must preserve the private helper's security contract.
  if not exists(select 1 from pg_catalog.pg_proc where oid=v_function and proowner=v_owner
      and proacl is not distinct from v_acl and proconfig is not distinct from v_config
      and prosecdef and provolatile='i') then
    raise exception 'FIRST_SHIFT_ORDER_SECURITY_CONTRACT_MISMATCH';
  end if;
end;
$migration$;

notify pgrst,'reload schema';
commit;
