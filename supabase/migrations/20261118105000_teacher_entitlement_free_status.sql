begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Preserve the deployed function's OID, privileges and execution settings.
-- A first call by a student can skip the SELECT entirely. Typed locals
-- still have a known null value when PostgreSQL plans the response.
do $fix_entitlement$
declare
  body_hash text;
  definition text;
begin
  select md5(replace(p.prosrc, chr(13), '')), pg_get_functiondef(p.oid)
    into body_hash, definition
  from pg_proc p
  where p.oid = to_regprocedure('xelay_teacher_private.entitlement(uuid)');
  if body_hash is distinct from '35148ac66d950463ac33e07801a60dae' then
    raise exception 'TEACHER_ENTITLEMENT_STATUS_DRIFT';
  end if;

  definition := replace(definition, 'chosen record;',
    'v_grant_id uuid; v_plan_id text; v_period_start timestamptz; v_period_end timestamptz;');
  definition := replace(definition, 'into chosen from', 'into v_grant_id, v_plan_id, v_period_start, v_period_end from');
  definition := replace(definition, 'chosen.id', 'v_grant_id');
  definition := replace(definition, 'chosen.plan_id', 'v_plan_id');
  definition := replace(definition, 'chosen.valid_from', 'v_period_start');
  definition := replace(definition, 'chosen.valid_until', 'v_period_end');
  execute definition;
end $fix_entitlement$;
commit;
