begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Personal filing only: never edits tests, attempts, answers or published grades.
create schema if not exists xelay_student_private;
create table xelay_student_private.completed_test_archives (
  user_id uuid not null references public.profiles(id) on delete cascade,
  attempt_id uuid not null references public.teaching_test_attempts(id) on delete cascade,
  submitted_at timestamptz not null,
  archived_at timestamptz not null default clock_timestamp(),
  primary key(user_id,attempt_id)
);
alter table xelay_student_private.completed_test_archives enable row level security;
revoke all on xelay_student_private.completed_test_archives from public,anon,authenticated,service_role;

alter function public.xelay_teaching_tests(uuid,uuid) rename to xelay_private_tests_before_student_archive_20261119;
revoke all on function public.xelay_private_tests_before_student_archive_20261119(uuid,uuid) from public,anon,authenticated,service_role;
create function public.xelay_teaching_tests(p_course_id uuid default null,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid:=public.xelay_teaching_assert_user();result jsonb;
begin
  result:=public.xelay_private_tests_before_student_archive_20261119(p_course_id,p_group_id);
  return jsonb_set(result,'{tests}',coalesce((select jsonb_agg(item||jsonb_build_object('my_archived',
    coalesce(item->'my_attempt'->>'status','')='submitted'
    and not coalesce((item->>'can_edit')::boolean,false)
    and not coalesce((item->>'can_review')::boolean,false)
    and not coalesce((item->>'qa_own_attempt')::boolean,false)
    and exists(select 1 from xelay_student_private.completed_test_archives own
      join public.teaching_test_attempts a on a.id=own.attempt_id and a.user_id=u
      where own.user_id=u and a.id=(item->'my_attempt'->>'id')::uuid and a.status='submitted'
        and a.submitted_at=own.submitted_at
        and a.submitted_at=(item->'my_attempt'->>'submitted_at')::timestamptz)) order by ordinal)
    from jsonb_array_elements(result->'tests')with ordinality as listed(item,ordinal)),'[]'::jsonb));
end;
$$;
revoke all on function public.xelay_teaching_tests(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_tests(uuid,uuid) to authenticated;

create function public.xelay_student_test_archive(
  p_action text,p_group_id uuid,p_expected_user_id uuid,p_attempt_id uuid default null,p_course_id uuid default null
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=public.xelay_teaching_assert_user();visible jsonb;item jsonb;a public.teaching_test_attempts%rowtype;
begin
  if p_expected_user_id is distinct from u then raise exception 'STUDENT_TEST_ARCHIVE_ACTOR_CHANGED' using errcode='42501';end if;
  if p_group_id is null or p_action is null or p_action not in ('archive','archive_all','restore')
    or (p_action='archive_all' and p_attempt_id is not null)
    or (p_action<>'archive_all' and p_attempt_id is null) then
    raise exception 'STUDENT_TEST_ARCHIVE_INVALID' using errcode='22023';end if;
  -- Reuse current group, subgroup, admission and publication visibility rules.
  visible:=public.xelay_teaching_tests(p_course_id,p_group_id);
  if p_action<>'archive_all' and not exists(select 1 from jsonb_array_elements(visible->'tests')v
    where v->'my_attempt'->>'id'=p_attempt_id::text) then
    raise exception 'STUDENT_TEST_ARCHIVE_FORBIDDEN' using errcode='42501';end if;
  for item in select value from jsonb_array_elements(visible->'tests') where
    (p_action='archive_all' or value->'my_attempt'->>'id'=p_attempt_id::text)
    and value->'my_attempt'->>'status'='submitted'
    and not coalesce((value->>'can_edit')::boolean,false)
    and not coalesce((value->>'can_review')::boolean,false)
    and not coalesce((value->>'qa_own_attempt')::boolean,false) loop
    -- The attempt, identity and completion timestamp are authoritative. A concurrent
    -- reset/retake must not hide a new attempt or change someone else's preference.
    select * into a from public.teaching_test_attempts where id=(item->'my_attempt'->>'id')::uuid
      and user_id=u and group_id=p_group_id and status='submitted' and submitted_at is not null for share;
    if found then
      if p_action='restore' then
        delete from xelay_student_private.completed_test_archives where user_id=u and attempt_id=a.id;
      else
        insert into xelay_student_private.completed_test_archives(user_id,attempt_id,submitted_at)
        values(u,a.id,a.submitted_at) on conflict(user_id,attempt_id) do update
          set submitted_at=excluded.submitted_at,archived_at=clock_timestamp()
          where completed_test_archives.submitted_at is distinct from excluded.submitted_at;
      end if;
    elsif p_action<>'archive_all' then
      raise exception 'STUDENT_TEST_ARCHIVE_NOT_COMPLETED' using errcode='22023';
    end if;
  end loop;
  if p_action<>'archive_all' and a.id is null then
    raise exception 'STUDENT_TEST_ARCHIVE_NOT_COMPLETED' using errcode='22023';end if;
  return public.xelay_teaching_tests(p_course_id,p_group_id)||jsonb_build_object('archive_user_id',u);
end;
$$;
revoke all on function public.xelay_student_test_archive(text,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_student_test_archive(text,uuid,uuid,uuid,uuid) to authenticated;
commit;
