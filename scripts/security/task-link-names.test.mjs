// Synthetic accounts and isolated PostgreSQL only. Never contacts production or sends mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const lecture = 'https://example.test/lecture'
const seminar = 'https://example.test/seminar'
const moduleUrls = new Map()
const rpcCalls = []
const apiResult = randomUUID()
globalThis.__taskLinkNamesSupabase = {
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  rpc: async (name, params) => { rpcCalls.push({ name, params }); return { data: apiResult, error: null, status: 200 } },
  from() { throw new Error('Unexpected network/database client call in isolated test') },
  storage: { from() { throw new Error('No file upload or production network allowed in isolated test') } },
}

async function moduleUrl(path) {
  if (moduleUrls.has(path)) return moduleUrls.get(path)
  if (path === 'src/lib/supabase.ts') {
    return 'data:text/javascript;base64,' + Buffer.from('export const supabase=globalThis.__taskLinkNamesSupabase').toString('base64')
  }
  let source = ts.transpileModule(await readFile(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  for (const match of [...source.matchAll(/from ['"]([.][^'"]+)['"]/g)]) {
    const dependency = new URL(match[1] + '.ts', new URL(path, root)).pathname
    const rootPath = root.pathname
    const dependencyPath = dependency.slice(rootPath.length)
    source = source.replace(match[0], 'from ' + JSON.stringify(await moduleUrl(dependencyPath)))
  }
  const result = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  moduleUrls.set(path, result)
  return result
}

const labels = await import(await moduleUrl('src/lib/resourceLinkLabels.ts'))
const { getHomeworkLinks } = await import(await moduleUrl('src/lib/homeworkResources.ts'))
const { saveStudyGroupLongTermTask } = await import(await moduleUrl('src/lib/studyGroupLongTermTasks.ts'))

test('resource name helpers keep names attached to URLs across duplicate/removal/reorder edits', () => {
  const input = [lecture, seminar, ' ' + lecture + ' ']
  const names = labels.normalizeResourceLinkLabels(input, [' Лекція ', ' Семінар ', 'Duplicate ignored'])
  assert.deepEqual(names, { [lecture]: 'Лекція', [seminar]: 'Семінар' })
  const links = getHomeworkLinks({ url: lecture, resource_links: input })
  assert.deepEqual(links, [lecture, seminar])
  assert.deepEqual(labels.getResourceLinkTitles(links, names), ['Лекція', 'Семінар'])
  assert.deepEqual(labels.getResourceLinkTitles([seminar, lecture], names), ['Семінар', 'Лекція'])
  assert.deepEqual(labels.getResourceLinkLabels(names, [seminar]), { [seminar]: 'Семінар' })
  assert.deepEqual(labels.getResourceLinkLabels({ 'https://example.test': 'Legacy bare URL' }, ['https://example.test/']), {
    'https://example.test/': 'Legacy bare URL',
  })
  assert.deepEqual(labels.normalizeResourceLinkLabels([lecture], ['   ']), {})
})

test('resource name helpers accept 80 Unicode characters and reject invalid names without interpreting markup', () => {
  const title = '🦛'.repeat(80)
  assert.equal(labels.normalizeResourceLinkLabels([lecture], [title])[lecture], title)
  for (const invalid of ['x'.repeat(81), 'line\nbreak', 'tab\tname', 'control\u0085name']) {
    assert.throws(() => labels.normalizeResourceLinkLabels([lecture], [invalid]))
    assert.deepEqual(labels.getResourceLinkLabels({ [lecture]: invalid }, [lecture]), {})
  }
  for (const invalid of [null, [], 'name', { [lecture]: 1 }, { [lecture]: null }]) {
    assert.deepEqual(labels.getResourceLinkLabels(invalid, [lecture]), {})
  }
  assert.deepEqual(labels.getResourceLinkLabels({ 'javascript:alert(1)': 'Unsafe', [lecture]: '<b>Лекція</b>' }, [lecture]), {
    [lecture]: '<b>Лекція</b>',
  })
})

test('long-term client selects the named RPC only explicitly and sends every required parameter', async () => {
  const groupId = randomUUID(), createRequestId = randomUUID()
  const input = {
    groupId, subject: ' Економіка ', title: ' Доповідь ', description: '', dueDate: '2026-11-01',
    resourceLinks: [lecture, seminar, lecture], resourceAttachments: [], createRequestId,
    resourceLinkLabels: { [lecture]: ' Лекція ', [seminar]: 'Семінар' },
  }
  assert.equal(await saveStudyGroupLongTermTask(input), apiResult)
  const saved = rpcCalls.at(-1)
  assert.equal(saved.name, 'xelay_save_study_group_long_term_task_resources_named')
  assert.equal(Object.keys(saved.params).length, 11)
  assert.deepEqual(saved.params, {
    p_group_id: groupId, p_task_id: null, p_subject: 'Економіка', p_title: 'Доповідь', p_description: '',
    p_due_date: '2026-11-01', p_resource_links: [lecture, seminar], p_resource_attachments: [],
    p_create_request_id: createRequestId, p_expected_updated_at: null,
    p_resource_link_labels: { [lecture]: 'Лекція', [seminar]: 'Семінар' },
  })
  await saveStudyGroupLongTermTask({ ...input, resourceLinkLabels: {} })
  assert.equal(rpcCalls.at(-1).name, 'xelay_save_study_group_long_term_task_resources_named')
  assert.deepEqual(rpcCalls.at(-1).params.p_resource_link_labels, {})
  const { resourceLinkLabels: _unused, ...legacyInput } = input
  await saveStudyGroupLongTermTask(legacyInput)
  assert.equal(rpcCalls.at(-1).name, 'xelay_save_study_group_long_term_task_resources')
  assert.ok(!Object.hasOwn(rpcCalls.at(-1).params, 'p_resource_link_labels'))
  await saveStudyGroupLongTermTask({ groupId, id: randomUUID(), subject: 'Економіка', title: 'Доповідь', description: '', dueDate: '2026-11-01' })
  assert.equal(rpcCalls.at(-1).name, 'xelay_save_study_group_long_term_task')
})

test('named task resources preserve legacy data and all private permissions through the current migration chain', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150008', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), request = randomUUID()
  const username = id => 'tasklinks_' + id.replaceAll('-', '').slice(0, 12)
  await db.query("insert into universities(id,name,slug) values($1,'Task link fixture university',$2)", [university, 'tasklinks-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Task link fixture faculty',$3,'faculty')", [unit, university, 'tasklinks-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'TASKLINKS','Task link program','Task link program')`, [specialty, university, unit])
  for (const id of [owner, member, outsider]) await seedUser(id, {
    username: username(id), university_id: university, academic_unit_id: unit, specialty_id: specialty,
    study_year: 1, experience: 'bachelor', categories: ['General'],
  })
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,$3,$4,specialty,'TASKLINKS-1','tasklink_fixture','approved',id,now() from profiles where id=$2`,
  [request, owner, university, unit])
  const group = first(await asUser(owner, 'select xelay_create_study_group($1) as id', [request])).id
  const invite = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) as id', [group, username(member)])).id
  await asUser(member, 'select xelay_respond_study_group_invitation($1,true)', [invite])
  const lesson = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,
    lesson_type,location,valid_from,valid_until,created_by)
    values($1,1,'08:00','09:20','Економіка','lecture','','2026-10-12','2026-10-19',$2) returning id`, [group, owner])).id
  const homework = first(await asUser(owner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,url,created_by)
    values($1,$2,'2026-10-12','Legacy homework',$3,$4) returning id`, [group, lesson, lecture, owner])).id
  const priorTask = first(await asUser(owner, `select xelay_save_study_group_long_term_task_resources(
    $1,null,'Економіка','Legacy task','','2026-11-01',$2::jsonb,'[]'::jsonb,null,$3) as id`,
  [group, JSON.stringify([lecture, seminar]), randomUUID()])).id
  const policies = async () => (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
    where (schemaname='public' and tablename in('study_group_homework','study_group_long_term_tasks'))
      or (schemaname='storage' and tablename='objects') order by schemaname,tablename,policyname`)).rows
  const policiesBefore = await policies()
  const oldRpcBefore = first(await db.query(`select pg_get_functiondef(
    'public.xelay_save_study_group_long_term_task_resources(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid)'::regprocedure) as body`)).body
  const migration = await readFile(new URL('supabase/migrations/202610150009_task_link_names.sql', root), 'utf8')
  await db.exec(migration)
  const getHomework = async () => first(await db.query('select * from study_group_homework where id=$1', [homework]))
  const getTask = async id => first(await db.query('select *,updated_at::text as version from study_group_long_term_tasks where id=$1', [id]))
  const setHomeworkLabels = value => asUser(owner, 'update study_group_homework set resource_link_labels=$2::jsonb where id=$1', [homework, JSON.stringify(value)])
  const newParams = (overrides = {}) => ({
    taskId: null, subject: ' Економіка ', title: ' Доповідь ', description: '', dueDate: '2026-11-01',
    links: [lecture, seminar], attachments: [], version: null, createId: randomUUID(),
    names: { [lecture]: ' Лекція ', [seminar]: ' Семінар ' }, ...overrides,
  })
  const saveNamed = async (input, user = owner) => first(await asUser(user,
    'select xelay_save_study_group_long_term_task_resources_named($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb) as id',
    [group, input.taskId, input.subject, input.title, input.description, input.dueDate,
      JSON.stringify(input.links), JSON.stringify(input.attachments), input.version, input.createId, JSON.stringify(input.names)])).id

  await t.test('preexisting homework legacy URL and long-term arrays survive without names', async () => {
    const hw = await getHomework(), task = await getTask(priorTask)
    assert.equal(hw.url, lecture)
    assert.deepEqual(hw.resource_links, [])
    assert.deepEqual(hw.resource_link_labels, {})
    assert.deepEqual(task.resource_links, [lecture, seminar])
    assert.deepEqual(task.resource_link_labels, {})
  })
  await t.test('owner names legacy URL and then two resources, trimming each title', async () => {
    await setHomeworkLabels({ [lecture]: ' Лекція ' })
    assert.deepEqual((await getHomework()).resource_link_labels, { [lecture]: 'Лекція' })
    await asUser(owner, 'update study_group_homework set resource_links=$2::jsonb,resource_link_labels=$3::jsonb where id=$1',
      [homework, JSON.stringify([lecture, seminar]), JSON.stringify({ [lecture]: ' Лекція ', [seminar]: ' Семінар ' })])
    const hw = await getHomework()
    assert.equal(hw.url, lecture)
    assert.deepEqual(hw.resource_links, [lecture, seminar])
    assert.deepEqual(hw.resource_link_labels, { [lecture]: 'Лекція', [seminar]: 'Семінар' })
  })
  await t.test('members read names but cannot modify them; outsiders cannot read or insert', async () => {
    assert.deepEqual(first(await asUser(member, 'select resource_link_labels from study_group_homework where id=$1', [homework])).resource_link_labels,
      { [lecture]: 'Лекція', [seminar]: 'Семінар' })
    assert.equal((await asUser(member, 'update study_group_homework set resource_link_labels=$2::jsonb where id=$1 returning id',
      [homework, JSON.stringify({ [lecture]: 'Unauthorized' })])).rows.length, 0)
    assert.equal((await asUser(outsider, 'select id from study_group_homework where id=$1', [homework])).rows.length, 0)
    await assert.rejects(asUser(outsider, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
      values($1,$2,'2026-10-19','Unauthorized',$3)`, [group, lesson, outsider]))
  })
  await t.test('80 Unicode characters work; invalid JSON shapes, values, controls and URLs reject with 22023', async () => {
    const title = '🦛'.repeat(80)
    await setHomeworkLabels({ [lecture]: title })
    assert.equal((await getHomework()).resource_link_labels[lecture], title)
    const invalid = [null, [], ['name'], 'name', 5, { [lecture]: null }, { [lecture]: 7 }, { [lecture]: {} },
      { [lecture]: 'x'.repeat(81) }, { [lecture]: 'a\nb' }, { [lecture]: 'a\u0085b' }, { [lecture]: 'a\tb' },
      { 'javascript:alert(1)': 'Unsafe' }, { 'https://user:pass@example.test/': 'Unsafe' },
      { 'https://example.test/\\evil': 'Unsafe' }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`https://example.test/${i}`, 'Name']))]
    for (const value of invalid) await assert.rejects(setHomeworkLabels(value), error => error.code === '22023')
    assert.equal((await getHomework()).resource_link_labels[lecture], title)
    await setHomeworkLabels({ [lecture]: '  ', [seminar]: 'Семінар', 'https://example.test/orphan': 'Orphan' })
    assert.deepEqual((await getHomework()).resource_link_labels, { [seminar]: 'Семінар' })
  })
  await t.test('older homework URL edits prune only removed titles and preserve retained title', async () => {
    await setHomeworkLabels({ [lecture]: 'Лекція', [seminar]: 'Семінар' })
    await asUser(owner, 'update study_group_homework set resource_links=$2::jsonb where id=$1', [homework, JSON.stringify([seminar])])
    assert.equal((await getHomework()).url, seminar)
    assert.deepEqual((await getHomework()).resource_link_labels, { [seminar]: 'Семінар' })
    await asUser(owner, "update study_group_homework set resource_links='[]'::jsonb where id=$1", [homework])
    assert.equal((await getHomework()).url, null)
    assert.deepEqual((await getHomework()).resource_link_labels, {})
  })
  let created, createInput
  await t.test('named RPC atomically creates both titles and URLs with all eleven required parameters', async () => {
    createInput = newParams()
    created = await saveNamed(createInput)
    const task = await getTask(created)
    assert.equal(task.subject, 'Економіка')
    assert.equal(task.title, 'Доповідь')
    assert.equal(task.create_request_id, createInput.createId)
    assert.deepEqual(task.resource_links, [lecture, seminar])
    assert.deepEqual(task.resource_link_labels, { [lecture]: 'Лекція', [seminar]: 'Семінар' })
    assert.deepEqual(task.resource_attachments, [])
    assert.equal(await saveNamed(createInput), created)
    assert.equal((await getTask(created)).version, task.version)
  })
  await t.test('conflicting CREATE replay rejects without overwriting saved titles or URLs', async () => {
    const before = await getTask(created)
    await assert.rejects(saveNamed({ ...createInput, names: { [lecture]: 'Changed' } }), error => error.code === '40001')
    await assert.rejects(saveNamed({ ...createInput, links: [seminar] }), error => error.code === '40001')
    assert.deepEqual(await getTask(created), before)
  })
  await t.test('named edit version guard rejects a stale editor and preserves the winning names', async () => {
    const before = await getTask(created)
    await saveNamed(newParams({ taskId: created, createId: null, version: before.version, names: { [lecture]: 'Оновлена лекція', [seminar]: 'Семінар' } }))
    const after = await getTask(created)
    assert.notEqual(after.version, before.version)
    assert.deepEqual(after.resource_link_labels, { [lecture]: 'Оновлена лекція', [seminar]: 'Семінар' })
    await assert.rejects(saveNamed(newParams({ taskId: created, createId: null, version: before.version, names: {} })), error => error.code === '40001')
    assert.deepEqual(await getTask(created), after)
  })
  await t.test('old resource RPC preserves retained URL names and cleans removed URL names', async () => {
    let before = await getTask(created)
    await asUser(owner, `select xelay_save_study_group_long_term_task_resources($1,$2,$3,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8,null)`,
      [group, created, before.subject, before.title, before.description, before.due_date, JSON.stringify([seminar, lecture]), before.version])
    assert.deepEqual((await getTask(created)).resource_link_labels, { [lecture]: 'Оновлена лекція', [seminar]: 'Семінар' })
    before = await getTask(created)
    await asUser(owner, `select xelay_save_study_group_long_term_task_resources($1,$2,$3,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8,null)`,
      [group, created, before.subject, before.title, before.description, before.due_date, JSON.stringify([seminar]), before.version])
    assert.deepEqual((await getTask(created)).resource_link_labels, { [seminar]: 'Семінар' })
  })
  await t.test('old scalar RPC keeps existing resources and names; explicit named empty map clears titles', async () => {
    const before = await getTask(created)
    await asUser(owner, `select xelay_save_study_group_long_term_task($1,$2,$3,'Updated scalar title',$4,$5)`,
      [group, created, before.subject, before.description, before.due_date])
    let after = await getTask(created)
    assert.deepEqual(after.resource_links, [seminar])
    assert.deepEqual(after.resource_link_labels, { [seminar]: 'Семінар' })
    await saveNamed(newParams({ taskId: created, createId: null, version: after.version, links: [seminar], names: {} }))
    after = await getTask(created)
    assert.deepEqual(after.resource_links, [seminar])
    assert.deepEqual(after.resource_link_labels, {})
  })
  await t.test('long-term names remain private; accepted members cannot use write RPCs', async () => {
    assert.equal((await asUser(member, 'select id from study_group_long_term_tasks where id=$1', [created])).rows.length, 1)
    assert.equal((await asUser(outsider, 'select id from study_group_long_term_tasks where id=$1', [created])).rows.length, 0)
    for (const actor of [member, outsider]) await assert.rejects(saveNamed(newParams(), actor), error => error.code === '42501')
    await assert.rejects(asUser(member, 'update study_group_long_term_tasks set resource_link_labels=$2::jsonb where id=$1',
      [created, JSON.stringify({ [seminar]: 'Unauthorized' })]), error => error.code === '42501')
  })
  await t.test('internal helpers stay inaccessible and no RLS, old RPC or file permissions change', async () => {
    const signature = 'public.xelay_save_study_group_long_term_task_resources_named(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid,jsonb)'
    for (const role of ['anon', 'service_role']) assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, signature])).allowed, false)
    assert.equal(first(await db.query('select has_function_privilege(\'authenticated\',$1,\'EXECUTE\') as allowed', [signature])).allowed, true)
    for (const helper of [
      'public.xelay_normalize_task_resource_link_labels(jsonb,jsonb,text)',
      'public.xelay_normalize_homework_link_labels()', 'public.xelay_normalize_long_term_task_link_labels()',
    ]) for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, helper])).allowed, false)
    }
    assert.deepEqual(await policies(), policiesBefore)
    assert.equal(first(await db.query(`select pg_get_functiondef(
      'public.xelay_save_study_group_long_term_task_resources(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid)'::regprocedure) as body`)).body, oldRpcBefore)
    assert.equal(first(await db.query('select count(*)::int as count from storage.objects')).count, 0)
  })
  await t.test('migration reapplication preserves saved titles and resources', async () => {
    await setHomeworkLabels({})
    const before = await getTask(created)
    await db.exec(migration)
    assert.deepEqual(await getTask(created), before)
    assert.deepEqual(await policies(), policiesBefore)
  })
})
