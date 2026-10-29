// Deterministic academic-group identity checks; synthetic data, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const source = await readFile(new URL('../../src/lib/teachingGroupDirectory.ts', import.meta.url), 'utf8')
const form = await readFile(new URL('../../src/components/teaching/TeachingCourseForms.tsx', import.meta.url), 'utf8')
const workspaceUi = await readFile(new URL('../../src/components/teaching/TeachingWorkspace.tsx', import.meta.url), 'utf8')
const migration = await readFile(new URL('../../supabase/migrations/202610180005_teaching_group_directory.sql', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports })
const { teachingGroupDirectoryLabel: label, teachingGroupDirectoryFullLabel: fullLabel, teachingGroupDirectoryMatches: matches } = module.exports
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`

test('same-named groups expose their own course, degree, faculty, program and representative', () => {
  const group = { id: uuid(1), group_name: 'МА-2', study_year: 1, study_level: 'bachelor', specialty: 'Економічна теорія', academic_unit_name: 'Економічний факультет', representative_name: 'Анастасія Прикладенко' }
  assert.equal(label(group), 'МА-2 · ЕТ · 1 курс · бак. · ЕФ · Ст.: Анастасія Прикладенко')
  assert.equal(label(group,false), 'ЕТ · 1 курс · бак. · ЕФ · Ст.: Анастасія Прикладенко')
  assert.equal(fullLabel(group), 'МА-2 · 1 курс · Бакалаврат · Економічний факультет · Економічна теорія · Староста: Анастасія Прикладенко')
  assert.notEqual(label(group), label({ ...group, study_year: 2, representative_name: 'Ірина Прикладенко' }))
  for (const query of ['  ма-2  ', '1 курс', 'бакалаврат', 'Економічний', 'Анастасія', 'Економічна теорія']) assert.equal(matches(group, query), true, query)
  assert.equal(matches(group, '2 курс'), false)
  assert.equal(matches(group, ''), true)
  assert.match(label({ ...group, study_level: 'master' }), /маг\./)
  assert.match(label({ ...group, study_level: 'postgraduate' }), /асп\./)
})

test('unknown or malformed academic identity is explicit and never guessed from a representative', () => {
  for (const year of [undefined, null, 0, 7, -1, 1.5, '2']) {
    assert.match(label({ id: uuid(1), group_name: 'МА-2', study_year: year }), /Курс \?/)
    assert.match(fullLabel({ id: uuid(1), group_name: 'МА-2', study_year: year }), /Курс не уточнено/)
  }
  assert.equal(label({ id: uuid(1), group_name: 'МА-2' }), 'МА-2 · Курс ? · Рівень ?')
  assert.match(form, /<TeachingGroupDirectoryPicker groups=\{groups\} groupId=\{groupId\} disabled=\{busy\}/)
  assert.match(form, /onSelect=\{id => \{ setGroupId\(id\); setSubjectId\(''\) \}\}/)
  assert.match(workspaceUi, /value=\{classroom\.group_id\}>\{classroomLabel\(classroom\)\}/)
  assert.match(workspaceUi, /<p>\{classroomLabel\(classroom, false\)\}<\/p>/)
  assert.match(workspaceUi, /linkedGroupLabel\(link\)/)
})

test('directory migration identifies cohorts and preserves existing RPC visibility and grants', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable set search_path=public,auth as $$ select nullif(current_setting('request.uid',true),'')::uuid $$;
    create table profiles(id uuid primary key,university_id uuid,full_name text,verified boolean default false);
    create table academic_units(id uuid primary key,university_id uuid,name text);
    create table study_groups(id uuid primary key,group_name text,specialty text,representative_id uuid,university_id uuid,academic_unit_id uuid,cohort_start_year integer,study_level text);
    create table study_group_members(group_id uuid,user_id uuid,status text);
    create table study_group_seminar_subjects(id uuid,group_id uuid,name text);
    create table teaching_courses(id uuid primary key,owner_id uuid,starts_on date,title text,semester text);
    create table teaching_course_teachers(id uuid,course_id uuid,user_id uuid,status text);
    create table teaching_course_groups(id uuid,course_id uuid,group_id uuid,status text,subject_id uuid);
    create table teacher_verification_requests(user_id uuid,university_id uuid,academic_unit_id uuid,department text,position text);
    create table teaching_entries(id uuid,group_id uuid,course_id uuid,full_name text);
    create table teaching_roster_claims(id uuid,entry_id uuid,user_id uuid,status text);
    create function xelay_teaching_assert_user() returns uuid language plpgsql stable set search_path=public,auth as $$ begin
      if auth.uid() is null then raise exception 'TEACHING_AUTH_REQUIRED'; end if; return auth.uid(); end $$;
    create function xelay_current_academic_year() returns integer language sql stable set search_path=public,auth as $$ select 2026 $$;
    create function xelay_teaching_is_verified(uuid) returns boolean language sql stable set search_path=public,auth as $$ select coalesce((select verified from profiles where id=$1),false) $$;
    create function xelay_teacher_status() returns jsonb language sql stable set search_path=public,auth as $$ select jsonb_build_object('verified',xelay_teaching_is_verified(auth.uid())) $$;
    create function xelay_teaching_is_member(uuid,uuid) returns boolean language sql stable set search_path=public,auth as $$
      select exists(select 1 from study_groups where id=$1 and representative_id=$2)
        or exists(select 1 from study_group_members where group_id=$1 and user_id=$2 and status='accepted') $$;
    create function xelay_teaching_permissions(uuid,uuid) returns text[] language sql stable set search_path=public,auth as $$
      select case when xelay_teaching_is_verified($2) and exists(select 1 from teaching_courses where id=$1 and owner_id=$2)
        then array['manage','assignments','materials','grades']::text[] else '{}'::text[] end $$;
    create function xelay_teaching_can_read_course(uuid,uuid) returns boolean language sql stable set search_path=public,auth as $$
      select cardinality(xelay_teaching_permissions($1,$2))>0 or exists(select 1 from teaching_course_groups where course_id=$1 and status='accepted' and xelay_teaching_is_member(group_id,$2)) $$;
    create function xelay_teaching_workspace() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function xelay_teaching_course(p_course_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
    declare v_uid uuid:=public.xelay_teaching_assert_user();v_staff boolean;
    begin
      if not public.xelay_teaching_can_read_course(p_course_id,v_uid) then raise exception 'TEACHING_FORBIDDEN'; end if;
      v_staff:=cardinality(public.xelay_teaching_permissions(p_course_id,v_uid))>0;
      return jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('group_name',g.group_name,'specialty',g.specialty,'representative_id',g.representative_id))
        from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id where l.course_id=p_course_id
          and (v_staff or(l.status='accepted' and public.xelay_teaching_is_member(l.group_id,v_uid)))),'[]'::jsonb));
    end $$;
    create function xelay_classroom_workspace() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function xelay_teaching_group_context(uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
    revoke all on function xelay_teaching_workspace(),xelay_teaching_course(uuid),xelay_classroom_workspace(),xelay_teaching_group_context(uuid) from public,anon;
    grant execute on function xelay_teaching_workspace(),xelay_teaching_course(uuid),xelay_classroom_workspace(),xelay_teaching_group_context(uuid) to authenticated;
  `)
  const teacher = uuid(1), student = uuid(2), head = uuid(3), foreignTeacher = uuid(4), uni = uuid(10), foreignUni = uuid(11), faculty = uuid(12), foreignFaculty = uuid(13), course = uuid(20)
  for (const [id, university, name, verified] of [[teacher,uni,'Teacher',true],[student,uni,'Student',false],[head,uni,'Representative',false],[foreignTeacher,foreignUni,'Foreign teacher',true]]) await db.query('insert into profiles values($1,$2,$3,$4)',[id,university,name,verified])
  await db.query("insert into academic_units values($1,$2,'Economic faculty'),($3,$4,'Other faculty')",[faculty,uni,foreignFaculty,foreignUni])
  for (const [id, year, level, university, unit] of [[31,2026,'bachelor',uni,faculty],[32,2025,'bachelor',uni,faculty],[33,null,null,uni,faculty],[34,2010,'master',uni,faculty],[35,2026,'bachelor',foreignUni,foreignFaculty]]) await db.query("insert into study_groups values($1,'МА-2','Economics',$2,$3,$4,$5,$6)",[uuid(id),head,university,unit,year,level])
  await db.query("insert into study_group_members values($1,$2,'accepted')",[uuid(31),student])
  await db.query("insert into teaching_courses values($1,$2,'2026-09-01','Economics','2026')",[course,teacher])
  await db.query("insert into teaching_course_groups values($1,$2,$3,'accepted',null),($4,$2,$5,'pending_group',null)",[uuid(40),course,uuid(31),uuid(41),uuid(32)])
  await db.query("insert into teaching_courses values($1,$2,'2026-09-01','Other subject','2026')",[uuid(21),foreignTeacher])
  await db.query("insert into teaching_course_groups values($1,$2,$3,'pending_group',null)",[uuid(42),uuid(21),uuid(33)])
  const acl = async () => (await db.query("select oid::regprocedure::text as name,proacl::text as acl from pg_proc where proname in('xelay_teaching_workspace','xelay_teaching_course','xelay_classroom_workspace','xelay_teaching_group_context') order by proname")).rows
  const originalAcl = await acl()
  await db.exec(migration)
  await db.exec(migration)
  assert.deepEqual(await acl(), originalAcl)
  const as = async (id, query, params = []) => { await db.query("select set_config('request.uid',$1,false)",[id || '']); return (await db.query(query,params)).rows[0].data }
  const workspace = await as(teacher,'select xelay_teaching_workspace() as data')
  assert.equal(workspace.groups.length,4)
  const groups = new Map(workspace.groups.map(group => [group.id,group]))
  assert.equal(groups.get(uuid(31)).study_year,1)
  assert.equal(groups.get(uuid(32)).study_year,2)
  assert.equal(groups.get(uuid(33)).study_year,null)
  assert.equal(groups.get(uuid(34)).study_year,null)
  assert.equal(groups.get(uuid(31)).academic_unit_name,'Economic faculty')
  assert.equal(groups.get(uuid(31)).representative_name,'Representative')
  assert.equal(groups.get(uuid(31)).study_level,'bachelor')
  assert.equal(groups.has(uuid(35)),false)
  assert.equal(workspace.pending_invites.length,1)
  assert.equal(workspace.pending_invites[0].course_id,course)
  assert.equal(workspace.pending_invites[0].group_id,uuid(32))
  assert.equal(workspace.pending_invites[0].status,'pending_group')
  assert.equal((await as(student,'select xelay_teaching_workspace() as data')).groups.length,1)
  assert.equal((await as(student,'select xelay_teaching_workspace() as data')).pending_invites.length,0)
  const foreignWorkspace = await as(foreignTeacher,'select xelay_teaching_workspace() as data')
  assert.equal(foreignWorkspace.groups.length,1)
  assert.equal(foreignWorkspace.pending_invites.length,1)
  assert.equal(foreignWorkspace.pending_invites[0].course_id,uuid(21))
  const headWorkspace = await as(head,'select xelay_teaching_workspace() as data')
  assert.equal(headWorkspace.pending_invites.length,2)
  const classrooms = await as(teacher,'select xelay_classroom_workspace() as data')
  assert.equal(classrooms.classrooms.length,1)
  assert.equal(classrooms.classrooms[0].study_year,1)
  assert.equal((await as(student,'select xelay_classroom_workspace() as data')).classrooms.length,0)
  const context = await as(teacher,'select xelay_teaching_group_context($1) as data',[uuid(31)])
  assert.equal(context.group.study_year,1)
  assert.equal(context.group.academic_unit_name,'Economic faculty')
  const teacherCourse = await as(teacher,'select xelay_teaching_course($1) as data',[course])
  assert.equal(teacherCourse.groups.length,2)
  assert.equal(teacherCourse.groups.find(group => group.group_id === uuid(31)).study_year,1)
  assert.equal(teacherCourse.groups.find(group => group.group_id === uuid(32)).study_year,2)
  assert.equal(teacherCourse.groups[0].representative_name,'Representative')
  const studentCourse = await as(student,'select xelay_teaching_course($1) as data',[course])
  assert.equal(studentCourse.groups.length,1)
  assert.equal(studentCourse.groups[0].group_id,uuid(31))
  await assert.rejects(as(teacher,'select xelay_teaching_group_context($1) as data',[uuid(32)]),/TEACHING_FORBIDDEN/)
  await assert.rejects(as(student,'select xelay_teaching_group_context($1) as data',[uuid(31)]),/TEACHING_FORBIDDEN/)
  await assert.rejects(as(null,'select xelay_teaching_workspace() as data'),/TEACHING_AUTH_REQUIRED/)
  assert.doesNotMatch(migration,/grant\s+|create\s+policy\s+|alter\s+table\s+/i)
})
