begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A short, separately recorded trial never creates a payment or changes the
-- original student/teacher billing identity. The private tables retain RLS.
alter table xelay_teacher_private.grants
  alter column order_id drop not null,
  add column source text not null default 'payment',
  add column trial_reference uuid unique,
  add column issued_by uuid references public.profiles(id) on delete restrict,
  add column reason text,
  add constraint teacher_grant_source check (
    (source = 'payment' and order_id is not null and trial_reference is null
      and issued_by is null and reason is null)
    or (source = 'trial' and order_id is null and trial_reference is not null
      and issued_by is not null and reason is not null
      and length(btrim(reason)) between 5 and 500
      and valid_until - valid_from <= interval '7 days')
  );

do $trial_access$
declare
  definition text;
  original constant text := 'if a=''teacher''and access then';
begin
  select pg_get_functiondef('xelay_teacher_private.entitlement(uuid)'::regprocedure)
    into definition;
  if md5(replace(definition, chr(13), '')) <> '85663495aaa7b6cbbd2bc57953379806'
    or cardinality(string_to_array(definition, original)) <> 2 then
    raise exception 'TEACHER_TRIAL_ENTITLEMENT_DRIFT';
  end if;
  execute replace(definition, original, $body$
if access and (a = 'teacher' or exists (
  select 1 from xelay_teacher_private.grants tg
  join xelay_teacher_private.periods tp on tp.grant_id = tg.id
  where tg.user_id = p_user_id and tg.source = 'trial'
    and tg.revoked_at is null
    and tp.valid_from <= clock_timestamp() and tp.valid_until > clock_timestamp()
)) then
  a := 'teacher';
$body$);
end $trial_access$;

commit;
