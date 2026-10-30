-- Only the two explicitly verified project accounts can list the two test IDs.
-- This is a directory predicate, never a new membership, admin or group grant.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
declare v_view oid:=to_regclass('public.xelay_listed_study_groups');v_helper oid;
begin
  if v_view is null or (select relkind from pg_catalog.pg_class where oid=v_view)<>'v'
    or coalesce(obj_description(v_view,'pg_class'),'') not in('xelay.hidden_test_study_groups.v1','xelay.hidden_test_study_groups.v2')
    or not exists(select 1 from pg_catalog.pg_class where oid=v_view and 'security_invoker=true'=any(reloptions)) then
    raise exception 'TEST_GROUP_VIEWER_EXCEPTIONS_VIEW_PREREQUISITE';
  end if;
  v_helper:=to_regprocedure('public.xelay_study_group_is_listed(uuid)');
  if v_helper is not null and (obj_description(v_helper,'pg_proc') is distinct from 'xelay.test_group_viewer_exceptions.v1'
    or exists(select 1 from pg_catalog.pg_proc where oid=v_helper and(prosecdef or prorettype<>'boolean'::regtype or provolatile<>'s'))) then
    raise exception 'TEST_GROUP_VIEWER_EXCEPTIONS_HELPER_COLLISION';
  end if;
end;
$preflight$;

create or replace function public.xelay_study_group_is_listed(p_group_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select p_group_id is null
    or p_group_id not in('437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'::uuid,'445fcadc-95e2-4f8c-bfb3-6d0998030a01'::uuid)
    or coalesce(auth.uid() in('04f587f8-1604-4f53-aabc-d1699c938b1d'::uuid,'b6d61792-89c5-48af-ad52-73806352ae61'::uuid),false);
$$;
comment on function public.xelay_study_group_is_listed(uuid) is 'xelay.test_group_viewer_exceptions.v1';
revoke all on function public.xelay_study_group_is_listed(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_study_group_is_listed(uuid) to authenticated,service_role;

-- The existing view's invoker privileges keep the study_groups RLS boundary.
-- Existing list RPCs already use this view; their bodies and ACLs are untouched.
create or replace view public.xelay_listed_study_groups with(security_invoker=true) as
select * from public.study_groups where public.xelay_study_group_is_listed(id);
comment on view public.xelay_listed_study_groups is 'xelay.hidden_test_study_groups.v2';
revoke all on public.xelay_listed_study_groups from public,anon,authenticated,service_role;
grant select on public.xelay_listed_study_groups to authenticated,service_role;
notify pgrst,'reload schema';
commit;
