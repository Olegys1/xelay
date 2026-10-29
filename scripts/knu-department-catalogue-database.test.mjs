import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const catalogue = JSON.parse(readFileSync(new URL('../src/data/knuAcademicDepartments.json', import.meta.url), 'utf8'))
const migration = readFileSync(new URL('../supabase/migrations/202610290006_knu_department_catalogue.sql', import.meta.url), 'utf8')
const quote = value => "'" + value.replaceAll("'", "''") + "'"
async function fixture(skip) {
  const db = new PGlite()
  await db.exec(`
    create table public.universities(id uuid primary key, slug text unique);
    create table public.academic_units(id uuid primary key default gen_random_uuid(), university_id uuid, slug text);
    create table public.academic_departments(id uuid primary key default gen_random_uuid(), university_id uuid, academic_unit_id uuid, slug text, name text, source_url text, is_active boolean, unique(academic_unit_id,slug));
    create table public.teacher_academic_profiles(user_id uuid primary key, department text);
    insert into public.universities values ('11111111-1111-4111-8111-111111111111','knu');
    insert into public.academic_units(university_id,slug) values ${catalogue.units.filter(unit => unit.unit_slug !== skip).map(unit => `('11111111-1111-4111-8111-111111111111',${quote(unit.unit_slug)})`).join(',')};
    insert into public.teacher_academic_profiles values ('22222222-2222-4222-8222-222222222222','Попередня збережена кафедра');
    insert into public.academic_departments(id, university_id, academic_unit_id,slug,name,source_url,is_active)
      select '33333333-3333-4333-8333-333333333333', university_id,id,'finance','Кафедра фінансів','https://econom.knu.ua/departments/',true from public.academic_units where slug='economics';
  `)
  return db
}

test('catalogue migration is repeatable, source dates persist and old department/profile IDs survive', async () => {
  const db = await fixture()
  try {
    await db.exec(migration)
    await db.exec(migration)
    const result = await db.query('select count(*)::int as count,count(distinct academic_unit_id)::int as scopes,count(source_verified_on)::int as verified from public.academic_departments')
    assert.deepEqual(result.rows[0], { count: 213, scopes: 22, verified: 213 })
    assert.equal((await db.query("select id from public.academic_departments where slug='finance'")).rows[0].id, '33333333-3333-4333-8333-333333333333')
    assert.equal((await db.query('select department from public.teacher_academic_profiles')).rows[0].department, 'Попередня збережена кафедра')
  } finally { await db.close() }
})

test('a missing academic unit fails the seed atomically instead of putting departments in another faculty', async () => {
  const db = await fixture('chemistry')
  try {
    await assert.rejects(db.exec(migration), /KNU_DEPARTMENT_UNIT_MISSING/)
    await db.exec('rollback')
    assert.equal((await db.query('select count(*)::int as count from public.academic_departments')).rows[0].count, 1)
  } finally { await db.close() }
})
