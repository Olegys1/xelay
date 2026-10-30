-- Hide two verified test groups from directories without touching their rows,
-- ownership, memberships, teaching audiences or direct group-detail access.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
declare v_signature text; v_proc pg_catalog.pg_proc%rowtype; v_view oid;
begin
  if to_regclass('public.study_groups') is null then
    raise exception 'HIDDEN_TEST_GROUP_PREREQUISITES_MISSING';
  end if;
  -- Keep a transfer/rename from racing the identity check. This does not alter
  -- any group or lock out readers while the view and read functions change.
  lock table public.study_groups in share mode;
  if not exists(select 1 from public.study_groups where id='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
       and representative_id='04f587f8-1604-4f53-aabc-d1699c938b1d')
    or not exists(select 1 from public.study_groups where id='445fcadc-95e2-4f8c-bfb3-6d0998030a01'
       and representative_id='b6d61792-89c5-48af-ad52-73806352ae61') then
    raise exception 'HIDDEN_TEST_GROUP_IDENTITY_CHANGED';
  end if;
  foreach v_signature in array array[
    'public.xelay_teaching_workspace()',
    'public.xelay_classroom_workspace()',
    'public.xelay_teaching_calendar(date,date)',
    'public.xelay_admin_study_groups(text,text,integer,integer)',
    'public.xelay_android_widget_groups()'
  ] loop
    select * into v_proc from pg_catalog.pg_proc where oid=to_regprocedure(v_signature);
    if not found or v_proc.provolatile<>'s' or not v_proc.prosecdef
      or v_proc.prorettype<>'jsonb'::regtype then
      raise exception 'HIDDEN_TEST_GROUP_READ_PREREQUISITE: %',v_signature;
    end if;
  end loop;
  v_view:=to_regclass('public.xelay_listed_study_groups');
  if v_view is not null and (
    (select relkind from pg_catalog.pg_class where oid=v_view)<>'v'
    or obj_description(v_view,'pg_class') is distinct from 'xelay.hidden_test_study_groups.v1'
  ) then
    raise exception 'HIDDEN_TEST_GROUP_VIEW_COLLISION';
  end if;
end $preflight$;

-- SECURITY INVOKER is essential: direct clients must still pass every RLS
-- policy and table privilege of study_groups. This is a narrower read surface.
create or replace view public.xelay_listed_study_groups
with (security_invoker=true) as
select * from public.study_groups
where id not in (
  '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'::uuid,
  '445fcadc-95e2-4f8c-bfb3-6d0998030a01'::uuid
);
comment on view public.xelay_listed_study_groups is 'xelay.hidden_test_study_groups.v1';
revoke all on public.xelay_listed_study_groups from public,anon,authenticated,service_role;
grant select on public.xelay_listed_study_groups to authenticated,service_role;

do $patch_list_reads$
declare
  v_proc record; v_definition text; v_next text; v_old_count integer; v_new_count integer;
  v_metadata jsonb; v_after jsonb; v_seen integer:=0;
begin
  for v_proc in
    select p.* from pg_catalog.pg_proc p
    where p.pronamespace='public'::regnamespace and (
      p.oid in (
        'public.xelay_teaching_workspace()'::regprocedure,
        'public.xelay_classroom_workspace()'::regprocedure,
        'public.xelay_teaching_calendar(date,date)'::regprocedure,
        'public.xelay_admin_study_groups(text,text,integer,integer)'::regprocedure,
        'public.xelay_android_widget_groups()'::regprocedure
      )
      or (p.proname ~ '^xelay_teaching_workspace_before_[a-z0-9_]+$' and p.pronargs=0)
    ) order by p.proname,p.oid
  loop
    if v_proc.provolatile<>'s' or not v_proc.prosecdef or v_proc.prorettype<>'jsonb'::regtype then
      raise exception 'HIDDEN_TEST_GROUP_UNEXPECTED_READ_FUNCTION: %',v_proc.oid::regprocedure;
    end if;
    select count(*) into v_old_count from regexp_matches(v_proc.prosrc,
      '\m(from|join)([[:space:]]+)public[.]study_groups\M','gi');
    select count(*) into v_new_count from regexp_matches(v_proc.prosrc,
      '\m(from|join)([[:space:]]+)public[.]xelay_listed_study_groups\M','gi');
    if v_old_count=0 and v_new_count=0 then
      -- An added workspace wrapper may only delegate to an earlier read. Do
      -- not rewrite its calls or force unrelated SQL through this view.
      if v_proc.proname ~ '^xelay_teaching_workspace(_before_[a-z0-9_]+)?$'
        and v_proc.prosrc ~ 'public[.]xelay_teaching_workspace_before_' then continue; end if;
      raise exception 'HIDDEN_TEST_GROUP_READ_SOURCE_CHANGED: %',v_proc.oid::regprocedure;
    end if;
    v_seen:=v_seen+1;
    if v_old_count=0 then continue; end if;
    v_metadata:=to_jsonb(v_proc)-array['prosrc','xmin','cmin','xmax','cmax','ctid'];
    v_definition:=pg_get_functiondef(v_proc.oid);
    v_next:=regexp_replace(v_definition,
      '\m(from|join)([[:space:]]+)public[.]study_groups\M',
      '\1\2public.xelay_listed_study_groups','gi');
    if v_next=v_definition then raise exception 'HIDDEN_TEST_GROUP_PATCH_FAILED'; end if;
    execute v_next;
    select to_jsonb(p)-array['prosrc','xmin','cmin','xmax','cmax','ctid'] into v_after
      from pg_catalog.pg_proc p where p.oid=v_proc.oid;
    if v_after is distinct from v_metadata then
      raise exception 'HIDDEN_TEST_GROUP_READ_SECURITY_CHANGED: %',v_proc.oid::regprocedure;
    end if;
    if exists(select 1 from pg_catalog.pg_proc p where p.oid=v_proc.oid
      and p.prosrc ~* '\m(from|join)([[:space:]]+)public[.]study_groups\M') then
      raise exception 'HIDDEN_TEST_GROUP_UNFILTERED_READ: %',v_proc.oid::regprocedure;
    end if;
  end loop;
  if v_seen<5 then raise exception 'HIDDEN_TEST_GROUP_READ_COVERAGE_MISSING'; end if;
end $patch_list_reads$;

-- Deliberately do not rewrite teaching_course, material-library/item JSON,
-- permission/mutation functions, collision detection or direct group readers.
-- Editing an existing assignment must retain even hidden target/scope IDs.
notify pgrst,'reload schema';
commit;
