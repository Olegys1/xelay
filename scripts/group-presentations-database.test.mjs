// Executes only the prepared student-presentation migration in a minimal local PostgreSQL fixture.
// No cloud connection, real account, working files or audit environment is used.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
const root = fileURLToPath(new URL('../', import.meta.url))
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const group = id(11), otherGroup = id(12), author = id(2), classmate = id(5), teacher = id(1), head = id(3), pending = id(6)
const filePath = `${group}/${author}/${id(101)}.pdf`, presentationId = id(102)
let db
async function actor(user, operation) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false)`)
  try { return await operation() } finally { await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)") }
}
const draft = (overrides = {}) => ({ subject: 'Економічна теорія', title: 'Ринкова рівновага', lesson_date: '2026-10-27', description: 'Презентація після заняття', links: [{ label: 'Презентація', url: 'https://example.org/presentation.pdf' }], attachments: [], ...overrides })
const save = (id, version, data) => db.query('select public.xelay_save_group_presentation($1::uuid,$2::uuid,$3::integer,$4::jsonb) as item', [group, id, version, JSON.stringify(data)])

before(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table public.study_groups(id uuid primary key, representative_id uuid not null);
    create table public.study_group_members(group_id uuid,user_id uuid,status text);
    create table public.profiles(id uuid primary key,full_name text);
    create table public.study_group_material_subjects(group_id uuid,name text);
    create table public.study_group_schedule(group_id uuid,subject text);
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    create policy "Legacy permissive storage policy" on storage.objects for all to anon,authenticated using(true) with check(true);
    create function public.xelay_study_group_permissions(p_group uuid) returns text[] language sql stable security definer as $$
      select case when exists(select 1 from public.study_groups where id=p_group and representative_id=auth.uid()) then array['materials']::text[] else '{}'::text[] end $$;
    insert into public.study_groups values('${group}','${head}'),('${otherGroup}','${head}');
    insert into public.study_group_members values('${group}','${author}','accepted'),('${group}','${classmate}','accepted'),('${group}','${pending}','pending');
    insert into public.profiles values('${author}','Марія Прикладенко'),('${classmate}','Назар Прикладенко'),('${teacher}','Викладач Прикладенко'),('${head}','Староста Прикладенко');
    insert into public.study_group_schedule values('${group}','Економічна теорія');
  `)
  const source = await readFile(path.join(root, 'supabase/migrations/202610050002_study_group_materials.sql'), 'utf8')
  for (const name of ['xelay_material_file_mime', 'xelay_material_file_path_valid', 'xelay_material_links_valid', 'xelay_material_attachments_valid']) {
    const definition = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0]
    assert.ok(definition, `Existing dependency ${name} found`); await db.exec(definition)
  }
  await db.exec(await readFile(path.join(root, 'supabase/migrations/202610270010_student_group_presentations.sql'), 'utf8'))
})
after(async () => { await db?.close() })

test('migration creates a private 50 MiB presentation bucket', async () => {
  const result = await db.query("select public,file_size_limit from storage.buckets where id='xelay-group-presentations'")
  assert.equal(result.rows[0].public, false); assert.equal(Number(result.rows[0].file_size_limit), 50 * 1024 * 1024)
})
test('accepted students can share and list a presentation with server-assigned authorship', async () => {
  const result = await actor(author, () => save(presentationId, 0, draft()))
  assert.equal(result.rows[0].item.created_by, author); assert.equal(result.rows[0].item.author_name, 'Марія Прикладенко')
  const list = await actor(classmate, () => db.query('select public.xelay_group_presentations($1::uuid) as data', [group]))
  assert.equal(list.rows[0].data.presentations.length, 1); assert.equal(list.rows[0].data.can_moderate, false)
})
test('teacher-only and pending users cannot read the panel or raw presentation rows', async () => {
  for (const user of [teacher, pending]) {
    await assert.rejects(() => actor(user, () => db.query('select public.xelay_group_presentations($1::uuid)', [group])), /GROUP_PRESENTATION_ACCESS/)
    const rows = await actor(user, () => db.query('select * from public.study_group_presentations'))
    assert.equal(rows.rows.length, 0)
  }
  await assert.rejects(() => actor(author, () => db.query('select public.xelay_group_presentations($1::uuid)', [otherGroup])), /GROUP_PRESENTATION_ACCESS/)
})
test('only the author updates; old versions fail and identical creation retries are safe', async () => {
  const repeated = await actor(author, () => save(presentationId, 0, draft()))
  assert.equal(repeated.rows[0].item.version, 1)
  await assert.rejects(() => actor(classmate, () => save(presentationId, 1, draft({ title: 'Чуже оновлення' }))), /GROUP_PRESENTATION_FORBIDDEN/)
  const next = await actor(author, () => save(presentationId, 1, draft({ title: 'Оновлена презентація' })))
  assert.equal(next.rows[0].item.version, 2)
  await assert.rejects(() => actor(author, () => save(presentationId, 1, draft())), /GROUP_PRESENTATION_CONFLICT/)
})
test('storage accepts only member-owned allowed files and enforces the size cap despite legacy policies', async () => {
  await actor(author, () => db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)", [filePath, JSON.stringify({ size: 40, mimetype: 'application/pdf' })]))
  await assert.rejects(() => actor(teacher, () => db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)", [`${group}/${teacher}/${id(111)}.pdf`, JSON.stringify({ size: 40, mimetype: 'application/pdf' })])), /row-level security/)
  await assert.rejects(() => actor(classmate, () => db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)", [`${group}/${author}/${id(112)}.pdf`, JSON.stringify({ size: 40, mimetype: 'application/pdf' })])), /row-level security/)
  await assert.rejects(() => actor(author, () => db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)", [`${group}/${author}/${id(113)}.pdf`, JSON.stringify({ size: 52428801, mimetype: 'application/pdf' })])), /row-level security/)
})
test('unpublished bytes stay private to their uploader; published files are readable by classmates only', async () => {
  const before = await actor(classmate, () => db.query("select name from storage.objects where bucket_id='xelay-group-presentations'"))
  assert.equal(before.rows.length, 0)
  const attached = { path: filePath, file_name: 'Ринкова рівновага.pdf', mime_type: 'application/pdf', file_size: 40 }
  await actor(author, () => save(presentationId, 2, draft({ attachments: [attached] })))
  const after = await actor(classmate, () => db.query("select name from storage.objects where bucket_id='xelay-group-presentations'"))
  assert.equal(after.rows.length, 1)
  const forbidden = await actor(teacher, () => db.query("select name from storage.objects where bucket_id='xelay-group-presentations'"))
  assert.equal(forbidden.rows.length, 0)
})
test('shared bytes cannot be overwritten or removed while referenced', async () => {
  const changed = await actor(author, () => db.query("update storage.objects set metadata='{}' where bucket_id='xelay-group-presentations' returning id"))
  assert.equal(changed.rows.length, 0)
  const removed = await actor(author, () => db.query("delete from storage.objects where bucket_id='xelay-group-presentations' returning id"))
  assert.equal(removed.rows.length, 0)
})
test('head moderation removes a presentation and detached bytes, while classmates cannot delete it', async () => {
  await assert.rejects(() => actor(classmate, () => db.query('select public.xelay_delete_group_presentation($1::uuid,$2::uuid,3)', [group, presentationId])), /GROUP_PRESENTATION_FORBIDDEN/)
  await actor(head, () => db.query('select public.xelay_delete_group_presentation($1::uuid,$2::uuid,3)', [group, presentationId]))
  const removed = await actor(head, () => db.query("delete from storage.objects where bucket_id='xelay-group-presentations' returning id"))
  assert.equal(removed.rows.length, 1)
  const remaining = await actor(classmate, () => db.query('select * from public.study_group_presentations'))
  assert.equal(remaining.rows.length, 0)
})
test('removing membership immediately revokes list and storage access', async () => {
  await actor(author, () => save(id(150), 0, draft()))
  await db.query("update public.study_group_members set status='removed' where group_id=$1::uuid and user_id=$2::uuid", [group, classmate])
  await assert.rejects(() => actor(classmate, () => db.query('select public.xelay_group_presentations($1::uuid)', [group])), /GROUP_PRESENTATION_ACCESS/)
  assert.equal((await actor(classmate, () => db.query('select * from public.study_group_presentations'))).rows.length, 0)
})
