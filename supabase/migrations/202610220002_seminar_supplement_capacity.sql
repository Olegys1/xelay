-- Configurable supplement seats. Group defaults affect new questions only;
-- saved questions keep their own snapshot, including an explicit zero.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
declare v_signature text;
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_seminar_questions') is null
    or to_regclass('public.study_group_seminar_reservations') is null then
    raise exception 'Apply study group and seminar migrations before supplement capacity';
  end if;
  foreach v_signature in array array[
    'public.xelay_lock_seminar_group(uuid,boolean)',
    'public.xelay_lock_study_group_permission(uuid,text,boolean)',
    'public.xelay_seminar_items_valid(jsonb,text)',
    'public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)',
    'public.xelay_reserve_seminar(uuid,text,uuid)',
    'public.xelay_assert_seminar_streaks(uuid,uuid)',
    'public.xelay_classroom_seminars(uuid,uuid)',
    'public.xelay_classroom_seminar_mutate(text,jsonb)'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'Missing supplement capacity prerequisite: %',v_signature;
    end if;
  end loop;
  -- Do not replace an older or independently edited authorization/date contract.
  if position('xelay_lock_study_group_permission(p_group_id,''seminars'',true)'
      in pg_get_functiondef('public.xelay_lock_seminar_group(uuid,boolean)'::regprocedure))=0
    or position('Rotation of primary/supplement roles is advisory'
      in pg_get_functiondef('public.xelay_assert_seminar_streaks(uuid,uuid)'::regprocedure))=0
    or position('academic_projection_date_contract'
      in pg_get_functiondef('public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)'::regprocedure))=0
    or position('academic_projection_date_contract'
      in pg_get_functiondef('public.xelay_classroom_seminar_mutate(text,jsonb)'::regprocedure))=0
    or position('academic_projection_retained_schedule_contract'
      in pg_get_functiondef('public.xelay_classroom_seminars(uuid,uuid)'::regprocedure))=0 then
    raise exception 'Unexpected seminar permission, rotation or academic projection contract';
  end if;
  if exists(select 1 from pg_attribute where attrelid in(
      'public.study_groups'::regclass,'public.study_group_seminar_questions'::regclass)
      and attname='supplement_capacity' and not attisdropped)
    or to_regprocedure('public.xelay_set_seminar_supplement_capacity(uuid,integer)') is not null then
    raise exception 'Supplement capacity already exists; inspect migration history before continuing';
  end if;
end;
$preflight$;

-- Constant defaults backfill existing rows as 3 without firing question content
-- or notification triggers. No reservation, question ID or version is rewritten.
alter table public.study_groups
  add column supplement_capacity integer not null default 3
    constraint study_groups_supplement_capacity_check check(supplement_capacity between 0 and 30);
alter table public.study_group_seminar_questions
  add column supplement_capacity integer not null default 3
    constraint study_group_seminar_questions_supplement_capacity_check check(supplement_capacity between 0 and 30);

create function public.xelay_set_seminar_supplement_capacity(p_group_id uuid,p_capacity integer)
returns integer language plpgsql volatile security definer set search_path='' as $setter$
begin
  -- The exact management lock used by the existing head/deputy seminar editor.
  -- Platform-admin status alone does not grant the academic 'seminars' right.
  perform public.xelay_lock_seminar_group(p_group_id,true);
  if p_capacity is null or p_capacity not between 0 and 30 then
    raise exception 'SEMINAR_SUPPLEMENT_CAPACITY_INVALID' using errcode='22023';
  end if;
  update public.study_groups set supplement_capacity=p_capacity where id=p_group_id;
  return p_capacity;
end;
$setter$;
revoke all on function public.xelay_set_seminar_supplement_capacity(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_set_seminar_supplement_capacity(uuid,integer) to authenticated;

-- Preserve every installed function's signature, owner, EXECUTE ACL and current
-- access/chronology/version/resource checks. Each exact old fragment must occur
-- once; any drift rolls back this whole migration rather than skipping a guard.
do $patches$
declare v_patch record;v_body text;
begin
  for v_patch in select * from (values
    (
      'public.xelay_seminar_items_valid(jsonb,text)',
      $old$if (v_item - array['id', 'body', 'primary_capacity']) <> '{}'::jsonb$old$,
      $new$if (v_item - array['id', 'body', 'primary_capacity', 'supplement_capacity']) <> '{}'::jsonb$new$
    ),
    (
      'public.xelay_seminar_items_valid(jsonb,text)',
      $old$      if v_capacity::integer not between 1 and 30 then return false; end if;
    else$old$,
      $new$      if v_capacity::integer not between 1 and 30 then return false; end if;
      -- supplement_capacity_contract: optional for existing clients; zero disables supplements.
      if v_item ? 'supplement_capacity' then
        if jsonb_typeof(v_item -> 'supplement_capacity') is distinct from 'number' then return false; end if;
        v_capacity := v_item ->> 'supplement_capacity';
        if v_capacity !~ '^[0-9]{1,2}$' then return false; end if;
        if v_capacity::integer not between 0 and 30 then return false; end if;
      end if;
    else$new$
    ),
    (
      'public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)',
      $old$  v_capacity integer;
begin$old$,
      $new$  v_capacity integer;
  v_supplement_capacity integer;
begin$new$
    ),
    (
      'public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb)',
      $old$      insert into public.study_group_seminar_questions(id, seminar_id, position, body, primary_capacity)
        values (v_item_id, v_id, v_position, btrim(v_item ->> 'body'), v_capacity)
        on conflict (id) do update set position = excluded.position, body = excluded.body,
          primary_capacity = excluded.primary_capacity, updated_at = now();$old$,
      $new$      -- supplement_capacity_contract: retain saved snapshots; only new rows inherit the group default.
      v_supplement_capacity := coalesce((v_item ->> 'supplement_capacity')::integer,
        (select q.supplement_capacity from public.study_group_seminar_questions q where q.id=v_item_id and q.seminar_id=v_id),
        (select g.supplement_capacity from public.study_groups g where g.id=p_group_id));
      if (select count(*) from public.study_group_seminar_reservations
          where question_id=v_item_id and role='supplement') > v_supplement_capacity then
        raise exception 'SEMINAR_SUPPLEMENT_CAPACITY_BELOW_MEMBERS';
      end if;
      insert into public.study_group_seminar_questions(id, seminar_id, position, body, primary_capacity, supplement_capacity)
        values (v_item_id, v_id, v_position, btrim(v_item ->> 'body'), v_capacity, v_supplement_capacity)
        on conflict (id) do update set position = excluded.position, body = excluded.body,
          primary_capacity = excluded.primary_capacity, supplement_capacity = excluded.supplement_capacity, updated_at = now();$new$
    ),
    (
      'public.xelay_reserve_seminar(uuid,text,uuid)',
      $old$select case when p_role = 'supplement' then 3 else primary_capacity end into v_capacity$old$,
      $new$select case when p_role = 'supplement' then supplement_capacity else primary_capacity end into v_capacity$new$
    ),
    (
      'public.xelay_classroom_seminar_mutate(text,jsonb)',
      $old$v_position integer:=0;v_capacity integer;
  v_recipient$old$,
      $new$v_position integer:=0;v_capacity integer;v_supplement_capacity integer;
  v_recipient$new$
    ),
    (
      'public.xelay_classroom_seminar_mutate(text,jsonb)',
      $old$      insert into public.study_group_seminar_questions(id,seminar_id,position,body,primary_capacity) values(v_child,v_id,v_position,btrim(v_item->>'body'),v_capacity)
        on conflict(id) do update set position=excluded.position,body=excluded.body,primary_capacity=excluded.primary_capacity,updated_at=now();$old$,
      $new$      -- supplement_capacity_contract: teacher saves use the same persisted seats and group default.
      v_supplement_capacity:=coalesce((v_item->>'supplement_capacity')::integer,
        (select q.supplement_capacity from public.study_group_seminar_questions q where q.id=v_child and q.seminar_id=v_id),
        (select g.supplement_capacity from public.study_groups g where g.id=v_group));
      if(select count(*) from public.study_group_seminar_reservations
          where question_id=v_child and role='supplement')>v_supplement_capacity then
        raise exception 'SEMINAR_SUPPLEMENT_CAPACITY_BELOW_MEMBERS'; end if;
      insert into public.study_group_seminar_questions(id,seminar_id,position,body,primary_capacity,supplement_capacity)
        values(v_child,v_id,v_position,btrim(v_item->>'body'),v_capacity,v_supplement_capacity)
        on conflict(id) do update set position=excluded.position,body=excluded.body,primary_capacity=excluded.primary_capacity,
          supplement_capacity=excluded.supplement_capacity,updated_at=now();$new$
    ),
    (
      'public.xelay_classroom_seminars(uuid,uuid)',
      $old$select jsonb_build_object('subject_id',v_subject,'can_edit','assignments'=any(v_permissions) and v_course.archived_at is null,$old$,
      $new$select jsonb_build_object('subject_id',v_subject,'can_edit','assignments'=any(v_permissions) and v_course.archived_at is null,
      'supplement_capacity',(select g.supplement_capacity from public.study_groups g where g.id=p_group_id),$new$
    )
  ) as patches(signature,old_fragment,new_fragment) loop
    select pg_get_functiondef(to_regprocedure(v_patch.signature)) into v_body;
    if v_body is null or cardinality(string_to_array(v_body,v_patch.old_fragment))<>2 then
      raise exception 'Unexpected supplement capacity contract in %',v_patch.signature;
    end if;
    execute replace(v_body,v_patch.old_fragment,v_patch.new_fragment);
  end loop;
end;
$patches$;

comment on column public.study_groups.supplement_capacity is
  'Default supplement seats (0..30) for newly saved seminar questions; changing it never rewrites existing questions or reservations.';
comment on column public.study_group_seminar_questions.supplement_capacity is
  'Persisted supplement seats (0..30). Zero disables new supplement reservations; locked save RPCs reject shrinking below occupied supplement seats.';
comment on function public.xelay_set_seminar_supplement_capacity(uuid,integer) is
  'Head/deputy seminars permission only, under the existing group lock. Changes the default for new seminar questions and returns it; existing questions and reservations are untouched.';

notify pgrst,'reload schema';
commit;
