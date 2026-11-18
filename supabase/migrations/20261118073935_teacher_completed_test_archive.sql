-- A personal filing preference only. No test, attempt, publication, score,
-- student admission or colleague's archive/list is changed by these RPCs.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regprocedure('xelay_teacher_private.entitlement(uuid)')is null
 or to_regprocedure('xelay_student_private.caller()')is null
 or to_regprocedure('public.xelay_private_test_staff(public.teaching_tests,uuid,text,boolean)')is null
 or to_regprocedure('public.xelay_private_publication_tests(uuid)')is null
 or to_regclass('public.teaching_test_retake_grants')is null
 or to_regclass('xelay_teacher_private.test_archives')is not null then raise exception 'TEST_ARCHIVE_PREREQUISITE_OR_DRIFT';end if;
end$$;
create table xelay_teacher_private.test_archives(
 user_id uuid not null references public.profiles(id)on delete cascade,
 test_id uuid not null references public.teaching_tests(id)on delete restrict,
 archived_at timestamptz,version integer not null check(version between 1 and 1000000),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 primary key(user_id,test_id)
);
alter table xelay_teacher_private.test_archives enable row level security;
revoke all on xelay_teacher_private.test_archives from public,anon,authenticated,service_role;
create function xelay_teacher_private.test_archive_scope(p_course uuid,p_group uuid,p_user uuid)returns void
language plpgsql stable security definer set search_path=''as $$begin
 if not public.xelay_teaching_has_current_access(p_user)then raise exception 'TEST_ARCHIVE_TEACHER_REQUIRED'using errcode='42501';end if;
 if p_course is not null and not exists(select 1 from public.teaching_courses c where c.id=p_course
  and public.xelay_teaching_permissions(c.id,p_user)&&array['assignments','grades']::text[])then raise exception 'TEST_ARCHIVE_SCOPE_FORBIDDEN'using errcode='42501';end if;
 if p_group is not null and not exists(select 1 from public.teaching_course_groups link
  where link.group_id=p_group and link.status='accepted'and(p_course is null or link.course_id=p_course)
  and public.xelay_teaching_group_permissions(link.course_id,p_group,p_user)&&array['assignments','grades']::text[])
 and not exists(select 1 from public.teaching_tests t cross join lateral jsonb_array_elements(t.targets)target
  where(p_course is null or t.course_id=p_course)and(target->>'group_id')::uuid=p_group
  and public.xelay_teaching_group_permissions(t.course_id,p_group,p_user)&&array['assignments','grades']::text[]
  and(public.xelay_private_test_staff(t,p_user,'assignments')or public.xelay_private_test_staff(t,p_user,'grades')))then raise exception 'TEST_ARCHIVE_SCOPE_FORBIDDEN'using errcode='42501';end if;
end$$;
create function xelay_teacher_private.test_archive_allowed(t public.teaching_tests,p_user uuid,p_group uuid)
returns boolean language sql stable security definer set search_path=''as $$
 select public.xelay_teaching_has_current_access(p_user)
 and(public.xelay_private_test_staff(t,p_user,'assignments')or public.xelay_private_test_staff(t,p_user,'grades'))
 and(p_group is null or exists(select 1 from jsonb_array_elements(t.targets)target where(target->>'group_id')::uuid=p_group
  and public.xelay_teaching_group_permissions(t.course_id,p_group,p_user)&&array['assignments','grades']::text[]));
$$;
create function xelay_teacher_private.test_archive_completed(t public.teaching_tests,p_user uuid)
returns boolean language sql stable security definer set search_path=''as $$
 select t.status<>'draft'and not exists(
  select 1 from public.teaching_tests related where related.id in(select public.xelay_private_publication_tests(t.id))
  and xelay_teacher_private.test_archive_allowed(related,p_user,null)
  and not exists(select 1 from public.teaching_test_retake_grants r where r.child_test_id=related.id and r.revoked_at is not null)
  and(related.status='draft'or(related.status='published'and greatest(related.closes_at,
   (select max((o->>'closes_at')::timestamptz)from jsonb_array_elements(related.overrides)o
    where coalesce((o->>'excluded')::boolean,false)=false
    and public.xelay_teaching_group_permissions(related.course_id,(o->>'group_id')::uuid,p_user)&&array['assignments','grades']::text[]))>clock_timestamp()))
 )and not exists(
  select 1 from public.teaching_test_attempts a join public.teaching_tests related on related.id=a.test_id
  where a.test_id in(select public.xelay_private_publication_tests(t.id))and a.status='in_progress'and a.expires_at>clock_timestamp()
  and xelay_teacher_private.test_archive_allowed(related,p_user,a.group_id)
 );
$$;
create function xelay_teacher_private.test_archive_item(a xelay_teacher_private.test_archives,p_course uuid)
returns jsonb language sql stable set search_path=''as $$select jsonb_build_object('testId',a.test_id,'courseId',p_course,'archivedAt',a.archived_at,'version',a.version);$$;
create function public.xelay_teaching_test_archive_state(p_course_id uuid default null,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();a record;items jsonb:='[]';item jsonb;bytes integer:=2;entitlement jsonb;begin
 perform xelay_teacher_private.test_archive_scope(p_course_id,p_group_id,u);
 entitlement:=xelay_teacher_private.entitlement(u);
 for a in select own as archive,t.course_id from xelay_teacher_private.test_archives own join public.teaching_tests t on t.id=own.test_id
 where own.user_id=u and(p_course_id is null or t.course_id=p_course_id)
 and xelay_teacher_private.test_archive_allowed(t,u,p_group_id)order by own.updated_at desc,own.test_id loop
  item:=xelay_teacher_private.test_archive_item(a.archive,a.course_id);bytes:=bytes+octet_length(item::text)+1;
  if bytes>2097152 then raise exception 'TEST_ARCHIVE_SCOPE_TOO_LARGE'using errcode='PT413';end if;
  items:=items||jsonb_build_array(item);
 end loop;
 return jsonb_build_object('userId',u,'canArchive',coalesce(entitlement->>'planId'in('teacher_start','teacher_plus','teacher_max'),false),
  'items',items,'serverNow',clock_timestamp());
end$$;
create function public.xelay_teaching_test_archive_set(p_test_id uuid,p_course_id uuid,p_group_id uuid,p_archived boolean,p_expected_version integer,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();t public.teaching_tests;a xelay_teacher_private.test_archives;e jsonb;begin
 if u is distinct from p_expected_user_id then raise exception 'TEST_ARCHIVE_ACTOR_CHANGED'using errcode='42501';end if;
 if p_test_id is null or p_course_id is null or p_archived is null or p_expected_version is null or p_expected_version not between 0 and 999999 then raise exception 'TEST_ARCHIVE_INVALID'using errcode='22023';end if;
 -- Serialize with the existing timed-test mutation boundary without invoking it.
 perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||p_test_id::text,0));
 select*into t from public.teaching_tests where id=p_test_id for share;
 if not found or t.course_id<>p_course_id then raise exception 'TEST_ARCHIVE_SCOPE_FORBIDDEN'using errcode='42501';end if;
 perform public.xelay_private_assert_teacher_current_access(u);
 perform 1 from public.teacher_verification_requests where user_id=u for share;
 perform 1 from public.teaching_course_teachers where course_id=t.course_id and user_id=u for share;
 if not xelay_teacher_private.test_archive_allowed(t,u,p_group_id)then raise exception 'TEST_ARCHIVE_SCOPE_FORBIDDEN'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('xelay:test-archive:'||u::text||':'||p_test_id::text,0));
 select*into a from xelay_teacher_private.test_archives where user_id=u and test_id=p_test_id for update;
 -- A repeat of the same filing state makes no new mutation or paid entitlement.
 if found and(a.archived_at is not null)=p_archived then return xelay_teacher_private.test_archive_item(a,t.course_id);end if;
 if coalesce(a.version,0)<>p_expected_version then raise exception 'TEST_ARCHIVE_CONFLICT'using errcode='PT409';end if;
 if not p_archived and a.user_id is null then raise exception 'TEST_ARCHIVE_NOT_FOUND'using errcode='42501';end if;
 if p_archived then
  e:=xelay_teacher_private.entitlement(u);
  if(e->>'planId'in('teacher_start','teacher_plus','teacher_max'))is not true then raise exception 'TEST_ARCHIVE_PLAN_REQUIRED'using errcode='42501';end if;
  if t.status='draft'or exists(select 1 from public.teaching_courses c where c.id=t.course_id and c.archived_at is not null)
   or not xelay_teacher_private.test_archive_completed(t,u)then raise exception 'TEST_ARCHIVE_NOT_COMPLETED'using errcode='PT409';end if;
 end if;
 insert into xelay_teacher_private.test_archives(user_id,test_id,archived_at,version)
 values(u,p_test_id,case when p_archived then clock_timestamp()else null end,1)
 on conflict(user_id,test_id)do update set archived_at=excluded.archived_at,version=test_archives.version+1,updated_at=clock_timestamp()returning*into a;
 return xelay_teacher_private.test_archive_item(a,t.course_id);
end$$;
revoke all on function xelay_teacher_private.test_archive_scope(uuid,uuid,uuid),xelay_teacher_private.test_archive_allowed(public.teaching_tests,uuid,uuid),
 xelay_teacher_private.test_archive_completed(public.teaching_tests,uuid),xelay_teacher_private.test_archive_item(xelay_teacher_private.test_archives,uuid)
 from public,anon,authenticated,service_role;
revoke all on function public.xelay_teaching_test_archive_state(uuid,uuid),public.xelay_teaching_test_archive_set(uuid,uuid,uuid,boolean,integer,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_archive_state(uuid,uuid),public.xelay_teaching_test_archive_set(uuid,uuid,uuid,boolean,integer,uuid)to authenticated;
notify pgrst,'reload schema';
commit;
