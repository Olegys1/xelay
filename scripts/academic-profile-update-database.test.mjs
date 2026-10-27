// Small single-process migration fixture. No network, live DB or audit tooling.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const read = file => readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8').replaceAll('\r', '')
function fn(source, signature) { const start = source.indexOf(signature); assert.ok(start >= 0, signature); return source.slice(start, source.indexOf('$$;', start) + 3) }
const teaching = read('202610130002_teaching_workspace.sql'), academic = read('202610240002_teacher_academic_profile.sql'), contact = read('202610260004_teacher_request_contact.sql')
const db = new PGlite()
let checks = 0
const ensure = (value, message) => { assert.ok(value, message); checks++ }
const one = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0]
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
try {
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('app.uid',true),'')::uuid$$;
    create table public.universities(id uuid primary key,slug text,name text,is_active boolean default true);
    create table public.academic_units(id uuid primary key,university_id uuid references universities(id),slug text,name text,is_active boolean default true,unique(id,university_id));
    create table public.academic_specialties(id uuid primary key,university_id uuid,academic_unit_id uuid,name text,is_active boolean default true);
    create table public.profiles(id uuid primary key,full_name text,username text,email text,country text not null default '',city text,bio text,experience text,categories text[],university_id uuid,academic_unit_id uuid,specialty_id uuid,specialty text,faculty text,avatar_url text,created_at timestamptz,account_type text default 'student');
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',created_at timestamptz default now());
    create table public.teacher_verification_requests(id uuid primary key default gen_random_uuid(),user_id uuid unique,full_name text,university_id uuid,academic_unit_id uuid,department text,position text,note text,status text default 'pending',review_reason text,reviewed_by uuid,reviewed_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),contact_telegram text,contact_phone text);
    create table public.user_roles(user_id uuid,role text);
    create function public.xelay_teaching_assert_user() returns uuid language plpgsql as $$begin if auth.uid() is null then raise exception 'TEACHING_AUTH_REQUIRED';end if;return auth.uid();end$$;
    create function public.xelay_teaching_is_verified(uuid) returns boolean language sql as $$select true$$;
    create function public.xelay_teaching_has_current_access(uuid) returns boolean language sql as $$select true$$;
    create function public.xelay_teaching_notify(uuid,text,text) returns void language sql as $$select$$;`)
  const tableStart = academic.indexOf('create table public.teacher_academic_profiles(')
  await db.exec(academic.slice(tableStart, academic.indexOf('\n);', tableStart) + 3))
  await db.exec(fn(teaching, 'create or replace function public.xelay_create_registration_profile()'))
  await db.exec(fn(academic, 'create function public.xelay_teacher_position_label('))
  await db.exec(fn(academic, 'create function public.xelay_private_teacher_academic_json('))
  await db.exec(fn(academic, 'create function public.xelay_teacher_academic_profile_save('))
  await db.exec(fn(contact, 'create function public.xelay_teacher_request(p_department text,p_position text,p_note text,p_contact_telegram text,p_contact_phone text)'))
  await db.exec(fn(academic, 'create function public.xelay_teacher_contacts('))
  await db.exec(`create trigger registration after insert or update on auth.users for each row execute function public.xelay_create_registration_profile();
    insert into universities values('${uid(1)}','knu','КНУ',true),('${uid(2)}','other','Інший університет',true);
    insert into academic_units values('${uid(11)}','${uid(1)}','economics','Економічний факультет',true),('${uid(12)}','${uid(1)}','history','Історичний факультет',true);
    insert into academic_specialties values('${uid(31)}','${uid(1)}','${uid(11)}','Економіка',true);
    insert into profiles(id,full_name,country,account_type,university_id,academic_unit_id) values('${uid(21)}','Legacy teacher','Україна','teacher','${uid(1)}','${uid(11)}');
    insert into teacher_verification_requests(user_id,university_id,academic_unit_id,department,status) values('${uid(21)}','${uid(1)}','${uid(11)}','Стара кафедра','approved');
    insert into teacher_academic_profiles(user_id) values('${uid(21)}');`)
  await db.exec(read('202610270005_profile_country_departments.sql'))
  await db.exec(read('202610270006_teacher_department_profile.sql'))
  ensure(Number((await one('select count(*) count from academic_departments')).count) === 12, 'Twelve official departments seeded')
  const department = (await one('select name from academic_departments order by name limit 1')).name
  const metadata = { xelay_registration_version: 1, full_name: 'New teacher', username: 'new.teacher', account_type: 'teacher', teacher_department: department, teacher_position: '', university_id: uid(1), academic_unit_id: uid(11), categories: [] }
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [uid(22), 'teacher@example.test', metadata])
  ensure((await one('select country from profiles where id=$1', [uid(22)])).country === '', 'Email signup works without a country and infers no country')
  const student = { ...metadata, full_name: 'New student', username: 'new.student', account_type: 'student', experience: 'bachelor', specialty_id: uid(31), categories: ['Learning'] }
  await db.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)', [uid(23), 'google@example.test', { provider: 'google' }])
  await db.query('update auth.users set raw_user_meta_data=$2 where id=$1', [uid(23), student])
  ensure((await one('select country from profiles where id=$1', [uid(23)])).country === '', 'Shared creator handles completion data without a country')
  ensure((await one('select country from profiles where id=$1', [uid(21)])).country === 'Україна', 'Old country stays intact')
  await assert.rejects(db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [uid(24), 'bad@example.test', { ...metadata, teacher_department: 'Вигадана кафедра' }]), /TEACHER_DEPARTMENT_INVALID/); checks++
  await db.query("select set_config('app.uid',$1,false)", [uid(21)])
  const current = (await one('select xelay_private_teacher_academic_json($1) data', [uid(21)])).data
  ensure(current.department === 'Стара кафедра' && current.department_options.length === 12, 'Legacy department and scoped selection are returned together')
  const payload = { expected_user_id: uid(21), department: current.department, position_code: '', position_other: '', is_postgraduate: false, requested_valid_until: null, contact_email: 'private@example.test', contact_phone: '', contact_telegram: '', email_visible_to_groups: false, email_visible_public: false, phone_visible_to_groups: false, phone_visible_public: false, telegram_visible_to_groups: false, telegram_visible_public: false, expected_updated_at: current.updated_at }
  const preserved = (await one('select xelay_teacher_academic_profile_save($1) data', [payload])).data
  ensure(preserved.department === 'Стара кафедра', 'An unrelated profile edit preserves its historical department')
  const updated = (await one('select xelay_teacher_academic_profile_save($1) data', [{ ...payload, department, expected_updated_at: preserved.updated_at }])).data
  ensure(updated.department === department, 'Teacher may choose a current department in the same faculty')
  ensure((await one('select status from teacher_verification_requests where user_id=$1', [uid(21)])).status === 'approved', 'Department metadata changes no approved role')
  await assert.rejects(db.query('select xelay_teacher_academic_profile_save($1)', [{ ...payload, department: 'Вигадана кафедра', expected_updated_at: updated.updated_at }]), /TEACHER_DEPARTMENT_INVALID/); checks++
  const projection = (await one('select xelay_teacher_contacts($1,null) data', [uid(21)])).data
  ensure(projection.department === department && projection.contact_email === null, 'Public department projection preserves private contact visibility')
  await assert.rejects(db.query('select xelay_teacher_request($1,$2,$3,$4,$5)', ['Вигадана кафедра', '', '', 'valid_user', '']), /TEACHER_DEPARTMENT_INVALID/); checks++
  console.log(JSON.stringify({ passed: checks, failed: 0, fixture: 'single-process synthetic PGlite; no live data or network' }))
} finally { await db.close() }
