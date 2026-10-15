-- Preserve the explicitly selected current course in the server-created signup
-- profile, including email-confirmation flows without an authenticated client.
-- Old cached forms may omit the field; no course or history is guessed for them.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
declare v_body text; v_old text; v_new text;
begin
  if to_regprocedure('public.xelay_create_registration_profile()') is null
    or to_regprocedure('public.xelay_apply_profile_study_year()') is null
    or not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass
      and tgname='xelay_registration_profile' and not tgisinternal
      and tgfoid='public.xelay_create_registration_profile()'::regprocedure) then
    raise exception 'Apply registration, academic course progression and teacher workspace migrations first';
  end if;
  select pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure) into v_body;
  if position('registration_study_year_contract' in v_body)>0 then return; end if;

  v_old:='v_attempt integer;';
  v_new:='v_study_year smallint := null;
  v_attempt integer;';
  if cardinality(string_to_array(v_body,v_old))<>2 then
    raise exception 'Unexpected registration course variable contract'; end if;
  v_body:=replace(v_body,v_old,v_new);

  v_old:='then raise exception ''Invalid registration profile''; end if;';
  v_new:=v_old||'

  -- registration_study_year_contract: current course, never an academic anchor.
  -- Missing/JSON-null remains compatible with previously cached forms. Only
  -- active students use the field; teacher and graduate profiles have no course.
  if not coalesce(v_teacher,false) and v_meta->>''experience'' in(''bachelor'',''master'',''postgraduate'')
    and v_meta ? ''study_year'' and v_meta->''study_year''<>''null''::jsonb then
    if jsonb_typeof(v_meta->''study_year'') not in(''number'',''string'')
      or (v_meta->>''study_year'') !~ ''^[1-6]$'' then
      raise exception ''STUDY_YEAR_INVALID'' using errcode=''23514'';
    end if;
    v_study_year:=(v_meta->>''study_year'')::smallint;
  end if;';
  if cardinality(string_to_array(v_body,v_old))<>2 then
    raise exception 'Unexpected registration course validation contract'; end if;
  v_body:=replace(v_body,v_old,v_new);

  v_old:='specialty, faculty, avatar_url, created_at, account_type';
  v_new:='specialty, faculty, avatar_url, created_at, study_year, account_type';
  if cardinality(string_to_array(v_body,v_old))<>2 then
    raise exception 'Unexpected registration course columns contract'; end if;
  v_body:=replace(v_body,v_old,v_new);

  v_old:='v_faculty, '''', new.created_at, case when coalesce(v_teacher,false) then ''teacher'' else ''student'' end';
  v_new:='v_faculty, '''', new.created_at, v_study_year, case when coalesce(v_teacher,false) then ''teacher'' else ''student'' end';
  if cardinality(string_to_array(v_body,v_old))<>2 then
    raise exception 'Unexpected registration course values contract'; end if;
  v_body:=replace(v_body,v_old,v_new);

  v_old:='faculty = excluded.faculty, account_type = excluded.account_type;';
  v_new:='faculty = excluded.faculty, account_type = excluded.account_type, study_year = excluded.study_year;';
  if cardinality(string_to_array(v_body,v_old))<>2 then
    raise exception 'Unexpected registration course conflict contract'; end if;
  v_body:=replace(v_body,v_old,v_new);

  -- CREATE OR REPLACE retains function owner, existing ACL and Auth trigger.
  -- Existing profile guards derive the server-owned academic-year baseline,
  -- keep automatic progression, and respect fifth/sixth-year programs through
  -- their effective max(default duration,current course) fallback.
  execute v_body;
end $$;

notify pgrst,'reload schema';
commit;
