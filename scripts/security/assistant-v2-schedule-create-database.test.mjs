// Runs the exact proposed migration and occurrence/link validators in local
// PostgreSQL only. PGlite has one backend: queued contenders prove the SQL
// decision/state logic; they are not an independent multi-backend load test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../../supabase/migrations/202610310003_assistant_schedule_create.sql', import.meta.url), 'utf8')
const recurrenceSource = await readFile(new URL('../../supabase/migrations/202610030003_study_group_timetable.sql', import.meta.url), 'utf8')
const linksSource = await readFile(new URL('../../supabase/migrations/202610290005_schedule_additional_links.sql', import.meta.url), 'utf8')
function exactFunction(source, name) {
  const start = source.indexOf(name), end = source.indexOf('$$;', start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end + 3)
}
const id = value => `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const USER = id(1), OTHER = id(2), GROUP = id(101), FOREIGN = id(102)
const shape = (number = 201, patch = {}) => ({ id: id(number), group_id: GROUP, weekday: 2, starts_at: '11:20', ends_at: '12:40', subject: 'Synthetic lesson', teacher_name: 'Synthetic teacher', lesson_type: 'lecture', location: 'Test room',
  online_url: 'https://example.com/first', online_url_secondary: 'https://example.com/second', online_url_label: null, online_url_secondary_label: null,
  online_links_extra: [{ url: 'https://example.com/third', label: '' }], conference_id: '123 456', conference_access_code: 'synthetic-only',
  valid_from: '2026-11-03', valid_until: '2026-11-03', week_pattern: 'every', week_anchor_date: null, created_by: USER, ...patch })
const code = expected => error => error.code === expected

test('one-date assistant schedule create is caller-only, RLS-bound and occurrence-atomic', { timeout: 120000 }, async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    create table public.study_groups(id uuid primary key,representative_id uuid not null);
    insert into study_groups values('${GROUP}','${USER}'),('${FOREIGN}','${OTHER}');
    create table public.study_group_schedule(
      id uuid primary key,group_id uuid not null references study_groups(id),weekday smallint not null check(weekday between 1 and 7),
      starts_at time not null,ends_at time not null check(ends_at>starts_at),subject text not null,
      teacher_name text not null default '',lesson_type text not null,location text not null default '',
      online_url text,online_url_secondary text,online_url_label text,online_url_secondary_label text,online_links_extra jsonb not null default'[]',
      conference_id text,conference_access_code text,valid_from date not null,valid_until date not null,
      week_pattern text not null default'every',week_anchor_date date,created_by uuid not null,
      created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
      excluded_dates date[] not null default'{}',lesson_number smallint,copied_from_schedule_id uuid,inherit_source_links boolean not null default false);
    create function public.xelay_has_study_group_permission(p_group_id uuid,p_permission text) returns boolean
      language sql stable security definer set search_path='' as $$select
        current_setting('test.permission_override',true)='true'
        or(current_setting('test.right_revoked',true) is distinct from 'true' and p_permission='schedule'
          and exists(select 1 from public.study_groups where id=p_group_id and representative_id=auth.uid()))$$;
    grant execute on function public.xelay_has_study_group_permission(uuid,text) to authenticated;
    grant select on study_groups to authenticated;
    grant select,insert on study_group_schedule to authenticated;
    alter table study_group_schedule enable row level security;
    create policy own_read on study_group_schedule for select to authenticated using(exists(select 1 from study_groups g where g.id=group_id and g.representative_id=auth.uid()));
    create policy own_insert on study_group_schedule for insert to authenticated with check(created_by=auth.uid()
      and exists(select 1 from study_groups g where g.id=group_id and g.representative_id=auth.uid())
      and xelay_has_study_group_permission(group_id,'schedule'));
  `)
  await db.exec(exactFunction(recurrenceSource, 'create or replace function public.xelay_schedule_occurs_on_date('))
  await db.exec(exactFunction(linksSource, 'create function public.xelay_normalize_schedule_extra_links('))
  await db.exec(migration)
  const rows = async (sql, values = []) => (await db.query(sql, values)).rows
  const asRole = async (role, operation, userId = USER) => {
    await db.exec(`set role ${role}`); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId])
    try { return await operation() } finally { await db.exec("reset role;select set_config('request.jwt.claim.sub','',false)") }
  }
  const call = (values, userId = USER) => asRole('authenticated', async () => (await rows('select public.xelay_assistant_create_schedule($1::jsonb) result', [values]))[0].result, userId)
  const reset = () => db.exec("truncate study_group_schedule;select set_config('test.right_revoked','false',false);select set_config('test.permission_override','false',false)")
  const seed = async (number = 301, patch = {}) => {
    const values = shape(number, { starts_at: '11:20', ends_at: '12:40', ...patch })
    const names = Object.keys(values)
    await db.query(`insert into study_group_schedule(${names.join(',')}) values(${names.map((_, index) => '$' + (index + 1)).join(',')})`, Object.values(values))
  }

  await t.test('only authenticated callers can execute and function retains invoker security', async () => {
    const info = (await rows("select prosecdef,proconfig from pg_proc where oid='public.xelay_assistant_create_schedule(jsonb)'::regprocedure"))[0]
    assert.equal(info.prosecdef, false); assert.ok(info.proconfig.includes('search_path=""'))
    assert.ok(migration.includes("pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v.group_id::text,0))"))
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal((await rows("select has_function_privilege($1,'public.xelay_assistant_create_schedule(jsonb)','execute') allowed", [role]))[0].allowed, role === 'authenticated')
    for (const role of ['anon', 'service_role']) await assert.rejects(asRole(role, () => db.query('select public.xelay_assistant_create_schedule($1::jsonb)', [shape()])), code('42501'))
    await assert.rejects(call(shape(), ''), code('42501'))
  })

  await t.test('inserts exact own resources and same generated ID returns one readback', async () => {
    await reset()
    assert.deepEqual(await call(shape()), { id: id(201) })
    assert.deepEqual(await call(shape()), { id: id(201) })
    const row = (await rows('select * from study_group_schedule'))[0]
    assert.equal(row.created_by, USER); assert.equal(row.starts_at, '11:20:00'); assert.equal(row.teacher_name, 'Synthetic teacher')
    assert.equal(row.online_links_extra[0].url, 'https://example.com/third'); assert.equal(row.conference_access_code, 'synthetic-only')
    assert.equal((await rows('select count(*)::int n from study_group_schedule'))[0].n, 1)
    await assert.rejects(call(shape(201, { subject: 'Changed same UUID' })), code('PT409'))
  })

  await t.test('revoked rights, foreign group/author, and underlying RLS cannot be bypassed', async () => {
    await reset()
    await assert.rejects(call(shape(202, { group_id: FOREIGN })), code('42501'))
    await assert.rejects(call(shape(202, { created_by: OTHER })), code('22023'))
    await db.exec("select set_config('test.right_revoked','true',false)")
    await assert.rejects(call(shape(202)), code('42501'))
    // Even an overpermissive helper in this fixture cannot bypass invoker RLS.
    await db.exec("select set_config('test.permission_override','true',false)")
    await assert.rejects(call(shape(202, { group_id: FOREIGN })), code('42501'))
    assert.equal((await rows('select count(*)::int n from study_group_schedule'))[0].n, 0)
  })

  await t.test('rejects another draft overlapping the actual recurring occurrence and permits adjacent time', async () => {
    await reset(); await seed(301, { valid_from: '2026-10-01', valid_until: '2026-12-31' })
    await assert.rejects(call(shape()), code('PT409'))
    await assert.rejects(call(shape(202, { starts_at: '12:00', ends_at: '13:20' })), code('PT409'))
    assert.deepEqual(await call(shape(203, { starts_at: '12:40', ends_at: '14:00' })), { id: id(203) })
    assert.equal((await rows('select count(*)::int n from study_group_schedule'))[0].n, 2)
  })

  await t.test('upper/lower parity, cancelled dates and the other weekday do not create false overlaps', async () => {
    await reset(); await seed(301, { valid_from: '2026-10-01', valid_until: '2026-12-31', week_pattern: 'lower', week_anchor_date: '2026-11-02' })
    assert.deepEqual(await call(shape()), { id: id(201) })
    await reset(); await seed(301, { valid_from: '2026-10-01', valid_until: '2026-12-31', week_pattern: 'upper', week_anchor_date: '2026-11-02' })
    await assert.rejects(call(shape()), code('PT409'))
    await db.query('update study_group_schedule set excluded_dates=array[$1::date]', ['2026-11-03'])
    assert.deepEqual(await call(shape()), { id: id(201) })
    await reset(); await seed(301, { weekday: 3, valid_from: '2026-10-01', valid_until: '2026-12-31' })
    assert.deepEqual(await call(shape()), { id: id(201) })
  })

  await t.test('validates fixed keys, one-date identity, times, text and URL content before mutation', async () => {
    await reset()
    const invalid = [
      { created_at: '2026-11-02T10:00:00Z' }, { excluded_dates: [] }, { arbitrary_table: 'profiles' }, { id: null },
      { valid_until: '2026-11-10' }, { weekday: 3 }, { week_pattern: 'upper' }, { week_anchor_date: '2026-11-02' },
      { starts_at: '11:20:00' }, { starts_at: '13:00' }, { ends_at: null }, { lesson_type: 'unexpected' },
      { subject: '  Untrimmed  ' }, { subject: '' }, { teacher_name: 'unsafe\nname' }, { location: '\u202ehidden' },
      { conference_id: '' }, { conference_access_code: 'a'.repeat(121) }, { online_url: 'javascript:alert(1)' },
      { online_url_secondary: 'https://user:password@example.com/' }, { online_links_extra: [{ url: 'data:text/html,a' }] },
      { online_url_label: 'Unreviewed label' }, { weekday: '2' }, { subject: { text: 'wrong type' } },
    ]
    for (const patch of invalid) await assert.rejects(call(shape(201, patch)), code('22023'))
    const missing = shape(); delete missing.created_by
    await assert.rejects(call(missing), code('22023'))
    assert.equal((await rows('select count(*)::int n from study_group_schedule'))[0].n, 0)
  })

  await t.test('queued independent generated IDs leave a single lesson when both target the same time', async () => {
    await reset()
    let chain = Promise.resolve()
    const queuedCall = values => { const next = chain.then(() => call(values)); chain = next.catch(() => {}); return next }
    const results = await Promise.allSettled([queuedCall(shape(201)), queuedCall(shape(202))])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PT409')
    assert.equal((await rows('select count(*)::int n from study_group_schedule'))[0].n, 1)
  })
})
