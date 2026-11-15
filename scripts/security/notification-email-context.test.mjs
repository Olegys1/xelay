// Executes the real delivery context with synthetic rows and no network/mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../server/notificationEmailContext.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { notificationEmailContext } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
const ids = {
  recipient: '11111111-1111-4111-8111-111111111111', actor: '22222222-2222-4222-8222-222222222222',
  notification: '33333333-3333-4333-8333-333333333333', space: '44444444-4444-4444-8444-444444444444',
  group: '55555555-5555-4555-8555-555555555555', member: '66666666-6666-4666-8666-666666666666',
  university: '77777777-7777-4777-8777-777777777777', unit: '88888888-8888-4888-8888-888888888888',
  task: '99999999-9999-4999-8999-999999999999', job: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  lock: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const notice = (type, fields = {}) => ({ id: ids.notification, recipient_id: ids.recipient, type, ...fields })
function fixture(rows = {}, { failingTable, rpcData = { eligible: true }, rpcError = null } = {}) {
  const queries = [], calls = []
  const service = {
    from(table) {
      const entry = { table, fields: '', filters: [] }; queries.push(entry)
      const query = {
        select(fields) { entry.fields = fields; return query },
        eq(field, value) { entry.filters.push([field, value]); return query },
        async maybeSingle() {
          if (table === failingTable) return { data: null, error: { message: 'Private internal failure' } }
          const matched = (rows[table] || []).filter(row => entry.filters.every(([field, value]) => row[field] === value))
          assert.ok(matched.length <= 1, 'Context queries identify one row')
          const row = matched[0]
          return { data: row ? Object.fromEntries(entry.fields.split(',').map(field => [field, row[field]])) : null, error: null }
        },
      }
      return query
    },
    async rpc(name, values) { calls.push({ name, values }); return { data: rpcData, error: rpcError } },
  }
  return { service, queries, calls, run: (notification, job) => notificationEmailContext(service, notification, job) }
}
const groupRows = (status = 'accepted', representative = ids.actor) => ({
  study_groups: [{ id: ids.group, representative_id: representative }],
  study_group_members: [{ id: ids.member, group_id: ids.group, user_id: ids.recipient, status }],
})
const chatNotice = (type = 'chat_message') => notice(type, { chat_space_id: ids.space, actor_id: ids.actor, is_read: true })
const lease = { id: ids.job, lock_token: ids.lock }

test('non-scoped kinds need no context query and do not gate read notifications', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(notice('answer', { is_read: true })), { eligible: true, error: null })
  assert.equal(f.queries.length, 0)
})

test('item publication emails recheck the leased recipient gate and contain only scoped links', async () => {
  const n = notice('teaching_update', { teaching_course_id: ids.university, teaching_event_key: 'teaching-item:'+ids.task+':2' })
  const data = { eligible:true,source_id:ids.task,course_id:ids.university,group_id:ids.group,kind:'material' }
  const f = fixture({}, {rpcData:data})
  assert.deepEqual(await f.run(n,lease), {eligible:true,error:null,path:'/groups/'+ids.group+'?tab=materials'})
  assert.deepEqual(f.calls,[{name:'xelay_teaching_item_email_context',values:{p_job_id:ids.job,p_lock_token:ids.lock}}])
  assert.equal(f.queries.length,0)
  const assignment = fixture({}, {rpcData:{...data,kind:'assignment'}})
  assert.equal((await assignment.run(n,lease)).path,'/groups/'+ids.group+'?tab=schedule')
  const staff = fixture({}, {rpcData:{...data,group_id:null}})
  assert.equal((await staff.run(n,lease)).path,'/teaching?course='+ids.university)
  const locked = fixture({}, {rpcData:{eligible:false,reason:'teaching_item_unavailable'}})
  assert.deepEqual(await locked.run(n,lease),{eligible:false,error:'teaching_item_unavailable'})
  assert.equal((await f.run(n)).error,'context_lease_required')
  const failed = fixture({}, {rpcError:{message:'private internal details'}})
  assert.equal((await failed.run(n,lease)).error,'context_lookup_failed')
})

test('item publication context rejects mismatched or malformed identity without touching grade notices', async () => {
  const n = notice('teaching_update',{teaching_course_id:ids.university,teaching_event_key:'teaching-item:'+ids.task+':2'})
  const data = {eligible:true,source_id:ids.task,course_id:ids.university,group_id:ids.group,kind:'assignment'}
  for (const patch of [{source_id:ids.job},{course_id:ids.actor},{group_id:'https://outside.test'},{kind:'test'}, {group_id:undefined}]) {
    assert.equal((await fixture({}, {rpcData:{...data,...patch}}).run(n,lease)).error,'context_payload_invalid')
  }
  assert.equal((await fixture({}, {rpcData:data}).run({...n,study_group_id:ids.job},lease)).error,'context_payload_invalid')
  for (const key of ['teaching-item:'+ids.task+':x','teaching-item:wrong:2','teaching-item:'+ids.task+':2:extra']) {
    const f=fixture({}, {rpcData:data})
    assert.equal((await f.run({...n,teaching_event_key:key},lease)).error,'context_payload_invalid')
    assert.equal(f.calls.length,0)
  }
  for (const key of ['teaching-grade:'+ids.task+':2','teaching-announcement:'+ids.task+':2','teacher-request:'+ids.actor]) {
    const f=fixture({}, {rpcData:{eligible:false,reason:'teaching_item_unavailable'}})
    assert.deepEqual(await f.run({...n,teaching_event_key:key},lease),{eligible:true,error:null})
    assert.equal(f.calls.length,0)
  }
})
test('teacher actions and followups validate the live lease and keep links inside the teaching cabinet', async () => {
  const fields = { teaching_course_id: ids.task, study_group_id: ids.group }
  for (const [key,home] of [['grade-request:'+ids.task,'requests'],['classroom-submit:'+ids.task+':1','assignments']]) {
    const n = notice('teaching_update',{...fields,teaching_event_key:key})
    const f = fixture()
    assert.equal((await f.run(n,lease)).path,`/teaching?course=${ids.task}&group=${ids.group}&home=${home}`)
    assert.deepEqual(f.calls,[{name:'xelay_teaching_action_email_context',values:{p_job_id:ids.job,p_lock_token:ids.lock}}])
    assert.equal((await f.run({...n,study_group_id:'https://outside.test'},lease)).error,'context_payload_invalid')
  }
  const digest = fixture()
  assert.equal((await digest.run(notice('teaching_followup'),lease)).path,'/teaching')
  assert.equal(digest.calls[0].name,'xelay_teaching_followup_email_context')
  assert.equal((await digest.run(notice('teaching_followup'))).error,'context_lease_required')
  const resolved = fixture({}, {rpcData:{eligible:false,reason:'teaching_followup_unavailable'}})
  assert.equal((await resolved.run(notice('teaching_followup'),lease)).error,'teaching_followup_unavailable')
})
test('common deadline updates use the exact leased assignment and support deadline removal', async () => {
  const n = notice('teaching_update', {
    study_group_id: ids.group, teaching_event_key: 'teaching-deadline:'+ids.task+':2',
  })
  const context = { eligible:true, group_id:ids.group, source_id:ids.task, lesson_date:'2026-11-04' }
  const due = '2026-11-05T18:30:00+02:00'
  const f = fixture({}, {rpcData:{...context,due_at:due}})
  assert.deepEqual(await f.run(n,lease),{
    eligible:true,error:null,path:'/groups/'+ids.group+'?tab=schedule&date=2026-11-04',
    teachingDeadlineChange:{dueAt:Date.parse(due)},
  })
  assert.deepEqual(f.calls,[{name:'xelay_teaching_deadline_change_email_context',values:{p_job_id:ids.job,p_lock_token:ids.lock}}])
  const free = fixture({}, {rpcData:{...context,due_at:null,lesson_date:null}})
  assert.deepEqual(await free.run(n,lease),{
    eligible:true,error:null,path:'/groups/'+ids.group+'?tab=schedule',teachingDeadlineChange:{dueAt:null},
  })
  assert.equal((await fixture({}, {rpcData:{...context,due_at:due,source_id:ids.job}}).run(n,lease)).error,'context_payload_invalid')
  assert.equal((await fixture({}, {rpcData:{...context,due_at:'invalid'}}).run(n,lease)).error,'context_payload_invalid')
  const changed = fixture({}, {rpcData:{eligible:false,reason:'teaching_deadline_change_unavailable'}})
  assert.equal((await changed.run(n,lease)).error,'teaching_deadline_change_unavailable')
})
test('group representatives receive updates without a member row', async () => {
  const f = fixture({ study_groups: [{ id: ids.group, representative_id: ids.recipient }] })
  assert.deepEqual(await f.run(notice('group_homework', { study_group_id: ids.group, is_read: true })), {
    eligible: true, error: null, path: '/groups/' + ids.group,
  })
})
test('accepted members receive safe academic tabs; unsafe tabs never enter email links', async () => {
  for (const tab of ['schedule', 'seminars', 'timetable', 'materials', 'https://outside.test', '../admin', null]) {
    const f = fixture(groupRows())
    const result = await f.run(notice('study_group_update', { study_group_id: ids.group, academic_tab: tab, is_read: true }))
    assert.equal(result.eligible, true)
    assert.equal(result.path, '/groups/' + ids.group + (['schedule', 'seminars', 'timetable', 'materials'].includes(tab) ? '?tab=' + tab : ''))
  }
})
for (const status of ['pending', 'removed', 'rejected']) {
  test('ordinary group events exclude membership status ' + status, async () => {
    assert.equal((await fixture(groupRows(status)).run(notice('group_homework', { study_group_id: ids.group }))).error, 'group_access_removed')
  })
}
test('group invitation accepts own pending or accepted row, even after the event was read', async () => {
  const n = notice('group_invite', { study_group_id: ids.group, study_group_member_id: ids.member })
  assert.equal((await fixture(groupRows('pending')).run(n)).path, '/groups')
  assert.equal((await fixture(groupRows('accepted')).run({ ...n, is_read: true })).path, '/groups')
  assert.equal((await fixture(groupRows('removed')).run(n)).error, 'group_invitation_unavailable')
  const wrong = groupRows('pending'); wrong.study_group_members[0].user_id = ids.actor
  assert.equal((await fixture(wrong).run(n)).eligible, false)
})
test('context hydrates newly added references without requesting private content', async () => {
  const secret = 'PRIVATE_WORK_AND_ATTACHMENT'
  const record = notice('study_group_update', { study_group_id: ids.group, academic_tab: 'seminars', body: secret, attachments: [secret] })
  const f = fixture({ ...groupRows(), notifications: [record] })
  const result = await f.run(notice('study_group_update', { study_group_id: ids.group }))
  assert.equal(result.path, '/groups/' + ids.group + '?tab=seminars')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  assert.doesNotMatch(f.queries.map(query => query.fields).join(','), /body|message|attachments|score|notes|name/)
})
test('removed or mismatched notification hydration fails closed', async () => {
  assert.equal((await fixture().run(notice('study_group_update'))).error, 'notification_removed')
  const wrong = notice('study_group_update', { recipient_id: ids.actor, study_group_id: ids.group, academic_tab: 'schedule' })
  assert.equal((await fixture({ notifications: [wrong] }).run(notice('study_group_update'))).error, 'notification_removed')
})
test('invalid group references never become paths or database filters', async () => {
  const f = fixture()
  assert.equal((await f.run(notice('group_homework', { study_group_id: '../../admin' }))).error, 'group_reference_invalid')
  assert.equal(f.queries.length, 0)
})
test('all community kinds use leased RPC without direct private-table reads or read gates', async () => {
  for (const type of ['chat_message', 'chat_comment', 'chat_invite', 'chat_join_request', 'chat_join_approved']) {
    const f = fixture({}, { rpcData: { eligible: true, path: '/messages?space=' + ids.space } })
    assert.deepEqual(await f.run(chatNotice(type), lease), { eligible: true, error: null, path: '/messages?space=' + ids.space })
    assert.equal(f.queries.length, 0)
    assert.deepEqual(f.calls, [{ name: 'xelay_chat_notification_email_context', values: { p_job_id: ids.job, p_lock_token: ids.lock } }])
  }
})
test('community RPC mute, current scope, permission and closed-request decisions are honored', async () => {
  for (const reason of ['chat_muted', 'chat_access_removed', 'chat_scope_changed', 'chat_moderator_required', 'chat_invitation_unavailable']) {
    const f = fixture({}, { rpcData: { eligible: false, reason } })
    assert.equal((await f.run(chatNotice(), lease)).error, reason)
    assert.equal(f.queries.length, 0)
  }
})
test('community RPC requires a valid lease and a fixed matching space path', async () => {
  assert.equal((await fixture().run(chatNotice())).error, 'context_lease_required')
  for (const path of ['https://outside.test', '/messages?space=../admin', '/messages?space=' + ids.space + '&redirect=outside',
    '/messages?space=' + ids.actor, '/messages?space=' + ids.space + '#private']) {
    assert.equal((await fixture({}, { rpcData: { eligible: true, path } }).run(chatNotice(), lease)).error, 'context_payload_invalid')
  }
})
test('organizer email checks task ownership and ignores completion/read status', async () => {
  const n = notice('organizer_reminder', { organizer_task_id: ids.task, is_read: true })
  const f = fixture({ organizer_tasks: [{ id: ids.task, user_id: ids.recipient, completed: true, notes: 'PRIVATE_NOTES' }] })
  assert.deepEqual(await f.run(n), { eligible: true, error: null, path: '/organizer' })
  assert.equal(f.queries[0].fields, 'id,user_id')
  assert.equal((await fixture({ organizer_tasks: [{ id: ids.task, user_id: ids.actor }] }).run(n)).error, 'organizer_task_unavailable')
})
test('academic deadline mail obtains only live leased metadata and builds a valid student destination', async () => {
  const n = notice('academic_deadline', { study_group_id: ids.group, is_read: true })
  const due_at = '2026-11-04T22:15:00.123456+00:00'
  for (const [kind, lesson_date, search] of [
    ['teaching', '2026-11-04', '&date=2026-11-04'],
    ['teaching', null, '&date=2026-11-05'],
    ['homework', '2026-11-06', '&date=2026-11-06&assignment=' + ids.task + '&kind=homework'],
    ['long_term', null, ''],
  ]) {
    const f = fixture({}, { rpcData: {
      eligible: true, kind, group_id: ids.group, source_id: ids.task, due_at, lesson_date,
      title: 'PRIVATE_TASK_TITLE', path: 'https://outside.test',
    } })
    assert.deepEqual(await f.run(n, lease), {
      eligible: true, error: null, path: '/groups/' + ids.group + '?tab=schedule' + search,
      academicDeadline: { kind, dueAt: Date.parse(due_at) },
    })
    assert.equal(f.queries.length, 0)
    assert.deepEqual(f.calls, [{ name: 'xelay_academic_deadline_email_context', values: {
      p_job_id: ids.job, p_lock_token: ids.lock,
    } }])
  }
})
test('academic deadline mail fails closed on stale eligibility, invalid metadata or a missing lease', async () => {
  const n = notice('academic_deadline', { study_group_id: ids.group })
  const valid = { eligible: true, kind: 'homework', group_id: ids.group, source_id: ids.task,
    due_at: '2026-11-05T10:00:00Z', lesson_date: '2026-11-05' }
  assert.equal((await fixture().run(n)).error, 'context_lease_required')
  for (const override of [{ group_id: ids.actor }, { source_id: '../admin' }, { due_at: 'infinity' },
    { due_at: '2026-02-30T10:00:00Z' }, { due_at: '2026-11-05T10:00:00' }, { lesson_date: null },
    { lesson_date: '2026-02-30' }, { kind: 'unknown' }]) {
    assert.equal((await fixture({}, { rpcData: { ...valid, ...override } }).run(n, lease)).error, 'context_payload_invalid')
  }
  for (const reason of ['deadline_elapsed', 'assignment_submitted', 'deadline_changed', 'group_access_removed']) {
    assert.equal((await fixture({}, { rpcData: { eligible: false, reason } }).run(n, lease)).error, reason)
  }
  assert.equal((await fixture({}, { rpcError: { message: 'PRIVATE_DB_FAILURE' } }).run(n, lease)).error, 'context_lookup_failed')
})
test('shared organizer uses only lease-scoped RPC and validated workspace deep link', async () => {
  const path = '/organizer?view=shared&workspace=' + ids.group
  const f = fixture({}, { rpcData: { eligible: true, path, name: 'PRIVATE_WORKSPACE' } })
  assert.deepEqual(await f.run(notice('shared_organizer_update', { shared_organizer_workspace_id: ids.group }), lease), { eligible: true, error: null, path })
  assert.equal(f.queries.length, 0)
  assert.deepEqual(f.calls, [{ name: 'xelay_shared_organizer_notification_email_context', values: {
    p_job_id: ids.job, p_lock_token: ids.lock,
  } }])
})
test('shared organizer rejects external, malformed and mismatched workspace links', async () => {
  for (const path of ['https://outside.test', '/organizer', '/organizer?view=shared&workspace=../admin',
    '/organizer?view=shared&workspace=' + ids.actor, '/organizer?view=shared&workspace=' + ids.group + '&redirect=outside']) {
    const f = fixture({}, { rpcData: { eligible: true, path } })
    assert.equal((await f.run(notice('shared_organizer_update', { shared_organizer_workspace_id: ids.group }), lease)).error, 'context_payload_invalid')
  }
})
test('shared organizer missing lease, closed invitation and removed access fail closed', async () => {
  assert.equal((await fixture().run(notice('shared_organizer_invite'))).error, 'context_lease_required')
  for (const reason of ['invitation_unavailable', 'workspace_archived', 'membership_removed']) {
    const f = fixture({}, { rpcData: { eligible: false, reason } })
    assert.equal((await f.run(notice('shared_organizer_invite'), lease)).error, reason)
  }
})
test('shared RPC malformed responses and database errors are retryable sanitized codes', async () => {
  for (const rpcData of [null, {}, [], { eligible: 'true' }]) {
    assert.equal((await fixture({}, { rpcData }).run(notice('shared_organizer_update'), lease)).error, 'context_payload_invalid')
  }
  assert.equal((await fixture({}, { rpcError: { message: 'PRIVATE_DB_FAILURE' } }).run(notice('shared_organizer_update'), lease)).error, 'context_lookup_failed')
  assert.equal((await fixture({}, { rpcError: { message: 'PRIVATE_DB_FAILURE' } }).run(chatNotice(), lease)).error, 'context_lookup_failed')
  assert.equal((await fixture(groupRows(), { failingTable: 'study_group_members' }).run(notice('group_homework', { study_group_id: ids.group }))).error, 'context_lookup_failed')
})
