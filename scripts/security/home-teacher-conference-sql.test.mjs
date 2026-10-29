// Actual calendar SQL and new migration, synthetic rows, in-memory PostgreSQL.
// No Supabase client, network, real accounts or persistent database is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { PGlite } from '@electric-sql/pglite'

const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/202610290001_home_teacher_conference.sql')
const base = await read('supabase/migrations/202610220005_teaching_calendar.sql')
const teacherName = await read('supabase/migrations/202610230003_timetable_teacher_name.sql')
const timetableOnly = await read('supabase/migrations/202610240006_teacher_calendar_timetable.sql')
let calendar = base.match(/create function public\.xelay_teaching_calendar\(p_from date,p_to date\)[\s\S]*?end \$\$;/)?.[0]
assert.ok(calendar, 'Read the actual repository calendar, not a hand-written projection')
const namePatches = [...teacherName.matchAll(/xelay_timetable_teacher_patch\('public\.xelay_teaching_calendar\(date,date\)',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/g)]
assert.equal(namePatches.length, 2)
for (const [, before, after] of namePatches) { assert.ok(calendar.includes(before)); calendar = calendar.replace(before, after) }
const removedUnion = timetableOnly.match(/v_old:=\$old\$([\s\S]*?)\$old\$/)?.[1]
assert.ok(removedUnion && calendar.includes(removedUnion))
calendar = calendar.replace(removedUnion, '')
calendar = calendar.replaceAll('public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)')
  .replaceAll('public.xelay_teaching_permissions(o.course_id,v_uid)', 'public.xelay_teaching_group_permissions(o.course_id,o.group_id,v_uid)')

const id = number => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const teacher = id(1), colleague = id(2), student = id(3), course = id(10), otherCourse = id(11), groupA = id(20), groupB = id(21)
const row = result => result.rows[0]

test('migration extends only the existing authorized timetable SELECT and fails closed on source or ACL drift', () => {
  const oldProjection = migration.match(/v_old text:=\$old\$([\s\S]*?)\$old\$/)?.[1]
  const newProjection = migration.match(/v_new text:=\$new\$([\s\S]*?)\$new\$/)?.[1]
  assert.equal(calendar.split(oldProjection).length, 2, 'Current source must contain exactly the intended projection')
  assert.equal(newProjection, oldProjection.replace(",'timetable'::text source", ",s.online_url,s.online_url_secondary,s.conference_id,s.conference_access_code,'timetable'::text source"))
  const patched = calendar.replace(oldProjection, newProjection)
  assert.equal(patched.replace(newProjection, oldProjection), calendar)
  assert.ok(patched.includes('public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)'))
  assert.ok(patched.includes('public.xelay_teaching_group_permissions(o.course_id,o.group_id,v_uid)'))
  assert.ok(patched.includes("l.status='accepted'"))
  assert.ok(patched.includes('d.lesson_date between a.starts_on and a.ends_on'))
  assert.ok(patched.includes('not(d.lesson_date=any(s.excluded_dates))'))
  assert.ok(patched.includes('limit 3001'))
  assert.equal(patched.includes('study_group_seminar_schedule'), false)
  assert.equal(patched.includes('study_group_seminars'), false)
  assert.equal(/^\s*(?:grant|revoke|insert|update|delete|alter|create\s+table)\b/im.test(migration), false)
  assert.ok(migration.includes('v_acl_after is distinct from v_acl_before'))
  assert.ok(migration.includes('replace(v_after,v_new,v_old) is distinct from v_before'))
  assert.ok(migration.includes('HOME_TEACHER_CONFERENCE_SOURCE_DRIFT'))
})

test('teacher conference migration preserves exact calendar recipients, ACL and all timetable guards', {
  skip: process.env.XELAY_HOME_SQL_INTEGRATION !== '1' ? 'Opt-in in-memory PostgreSQL; its128MiB minimum WASM plus initdb exceeds this laptop\'s300MiB RSS budget.' : false,
  timeout: 60_000,
}, async t => {
  const rssBudgetMiB = Number(process.env.XELAY_HOME_SQL_RSS_CAP_MIB || 300)
  assert.ok([300, 600].includes(rssBudgetMiB), 'Only the default300MiB or explicit600MiB isolated-test budget is allowed')
  const freeBeforeMiB = freemem() / 1024 ** 2
  if (rssBudgetMiB === 600 && freeBeforeMiB <= 1400) {
    t.skip(`Isolated SQL test requires over1400MiB free memory; currently${Math.round(freeBeforeMiB)}MiB.`)
    return
  }
  let peakRssMiB = 0
  const guard = setInterval(() => {
    peakRssMiB = Math.max(peakRssMiB, process.memoryUsage().rss / 1024 ** 2)
    if (peakRssMiB > rssBudgetMiB) { console.error(`Synthetic SQL test stopped at its${rssBudgetMiB}MiB RSS cap.`); process.exit(77) }
  }, 50)
  guard.unref()
  const timeout = setTimeout(() => { console.error('Synthetic SQL test stopped at its60second deadline.'); process.exit(78) }, 60_000)
  timeout.unref()
  const db = new PGlite({ initialMemory: 128 * 1024 ** 2,
    postgresqlconf: ['shared_buffers=4MB', 'work_mem=1MB', 'maintenance_work_mem=4MB'] })
  const asUser = async (user, sql, role = 'authenticated') => {
    await db.exec('begin')
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user])
      await db.exec(`set local role ${role}`)
      return await db.query(sql)
    } finally { await db.exec('rollback') }
  }
  const query = "select public.xelay_teaching_calendar('2026-10-28','2026-10-28') as calendar"
  try {
    await db.exec(`
      create role anon;create role authenticated;create role service_role;
      grant usage on schema public to anon,authenticated,service_role;
      create schema fixture;
      create table fixture.teachers(id uuid primary key,current_access boolean not null);
      create table fixture.scopes(user_id uuid,course_id uuid,group_id uuid,permissions text[]);
      create function public.xelay_teaching_assert_user() returns uuid language plpgsql stable security definer set search_path='' as $$
      declare actor uuid:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      begin
        if not exists(select 1 from fixture.teachers t where t.id=actor and t.current_access) then
          raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
        return actor;
      end $$;
      create function public.xelay_teaching_group_permissions(c uuid,g uuid,u uuid) returns text[] language sql stable security definer set search_path='' as $$
        select coalesce((select s.permissions from fixture.scopes s where s.user_id=u and s.course_id=c and s.group_id=g),'{}'::text[]) $$;
      create function public.xelay_academic_subject_key(text) returns text language sql immutable as $$ select lower(trim($1)) $$;
      create function public.xelay_schedule_occurs_on_date(integer,date,date,text,date,date) returns boolean language sql immutable as $$
        select $6 between $2 and $3 and extract(isodow from $6)::integer=$1 $$;
      create table public.teaching_courses(id uuid primary key,title text,starts_on date,ends_on date,archived_at timestamptz);
      create table public.teaching_course_groups(course_id uuid,group_id uuid,subject_id uuid,status text);
      create table public.study_groups(id uuid primary key,group_name text);
      create table public.study_group_seminar_subjects(id uuid,group_id uuid,name text);
      create table public.study_group_schedule(id uuid primary key,group_id uuid,subject text,weekday integer,valid_from date,valid_until date,
        week_pattern text,week_anchor_date date,excluded_dates date[] default '{}',starts_at time,ends_at time,lesson_type text,
        location text,teacher_name text,online_url text,online_url_secondary text,conference_id text,conference_access_code text);
      create table public.teaching_calendar_assignments(user_id uuid,course_id uuid,group_id uuid,schedule_id uuid,source text);
      ${calendar}
      revoke all on function public.xelay_teaching_calendar(date,date) from public,anon,authenticated,service_role;
      grant execute on function public.xelay_teaching_calendar(date,date) to authenticated;
      insert into fixture.teachers values('${teacher}',true),('${colleague}',true);
      insert into fixture.scopes values('${teacher}','${course}','${groupA}',array['assignments']),('${colleague}','${course}','${groupB}',array['materials']);
      insert into public.teaching_courses values('${course}','Mathematics','2026-09-01','2027-01-31',null),('${otherCourse}','History','2026-09-01','2027-01-31',null);
      insert into public.study_groups values('${groupA}','Synthetic A'),('${groupB}','Synthetic B');
      insert into public.teaching_course_groups values('${course}','${groupA}',null,'accepted'),('${course}','${groupB}',null,'accepted'),('${otherCourse}','${groupA}',null,'accepted');
      insert into public.study_group_schedule(id,group_id,subject,weekday,valid_from,valid_until,week_pattern,starts_at,ends_at,lesson_type,online_url,online_url_secondary,conference_id,conference_access_code) values
        ('${id(30)}','${groupA}','Mathematics',3,'2026-09-01','2027-01-31','every','09:40','11:00','lecture','https://zoom.us/j/123456789',null,'123 456 789','000067'),
        ('${id(31)}','${groupB}','Mathematics',3,'2026-09-01','2027-01-31','every','09:40','11:00','lecture',null,'https://meet.google.com/synthetic-other','FOREIGN_GROUP','foreign-code'),
        ('${id(32)}','${groupA}','History',3,'2026-09-01','2027-01-31','every','11:20','12:40','lecture','https://zoom.us/j/999999999',null,'FOREIGN_SUBJECT','foreign-code');
      insert into public.study_group_schedule(id,group_id,subject,weekday,valid_from,valid_until,week_pattern,excluded_dates,starts_at,ends_at,lesson_type,conference_id)
        values('${id(33)}','${groupA}','Mathematics',3,'2026-09-01','2027-01-31','every',array['2026-10-28'::date],'12:50','14:10','seminar','EXCLUDED_MEETING');
    `)
    const fingerprintSql = "select md5(string_agg(to_jsonb(s)::text,E'\\n' order by s.id)) as fingerprint from public.study_group_schedule s"
    const beforeRows = row(await db.query(fingerprintSql))
    const acl = async () => row(await db.query("select oid::text,proacl::text,proowner::text,prosecdef,proconfig,provolatile from pg_proc where oid='public.xelay_teaching_calendar(date,date)'::regprocedure"))
    const beforeAcl = await acl()
    const before = row(await asUser(teacher, query)).calendar.lessons
    assert.equal(before.length, 1)
    assert.equal(before[0].online_url, undefined)

    await db.exec(migration)
    assert.deepEqual(await acl(), beforeAcl)
    assert.deepEqual(row(await db.query(fingerprintSql)), beforeRows)
    const after = row(await asUser(teacher, query)).calendar.lessons
    assert.equal(after.length, 1)
    assert.deepEqual(after.map(({ online_url, online_url_secondary, conference_id, conference_access_code, ...rest }) => rest), before)
    assert.equal(after[0].online_url, 'https://zoom.us/j/123456789')
    assert.equal(after[0].conference_access_code, '000067')
    assert.equal(JSON.stringify(after).includes('FOREIGN_'), false)
    assert.equal(JSON.stringify(after).includes('EXCLUDED_MEETING'), false)
    const other = row(await asUser(colleague, query)).calendar.lessons
    assert.equal(other.length, 1)
    assert.equal(other[0].group_id, groupB)
    assert.equal(other[0].online_url_secondary, 'https://meet.google.com/synthetic-other')
    await assert.rejects(asUser(student, query), error => error.code === '42501')
    await assert.rejects(asUser(teacher, query, 'anon'), error => error.code === '42501')
    await assert.rejects(asUser(teacher, 'select * from public.study_group_schedule'), error => error.code === '42501')
    await db.exec(`update fixture.scopes set permissions='{}' where user_id='${teacher}'`)
    assert.deepEqual(row(await asUser(teacher, query)).calendar.lessons, [])
    await db.exec(`update fixture.teachers set current_access=false where id='${colleague}'`)
    await assert.rejects(asUser(colleague, query), error => error.code === '42501')
    await assert.rejects(asUser(teacher, "select public.xelay_teaching_calendar('2026-10-28','2026-12-31')"), error => error.code === '22023')
    await assert.rejects(db.exec(migration), /HOME_TEACHER_CONFERENCE_SOURCE_DRIFT/)
    await db.exec('rollback')
    assert.deepEqual(await acl(), beforeAcl, 'Source drift rejection cannot change function access')
    peakRssMiB = Math.max(peakRssMiB, process.memoryUsage().rss / 1024 ** 2)
    t.diagnostic(JSON.stringify({ syntheticPostgresExecuted: true, peakRssMiB: Math.round(peakRssMiB), rssCapMiB: rssBudgetMiB, freeBeforeMiB: Math.round(freeBeforeMiB), noProductionConnections: true }))
  } finally { await db.close(); clearInterval(guard); clearTimeout(timeout) }
})
