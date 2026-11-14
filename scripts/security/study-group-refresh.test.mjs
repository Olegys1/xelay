import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const load = source => import('data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64'))
const { createStudyGroupRefresh } = await load(await read('src/lib/studyGroupRefresh.ts'))
const { studyGroupReadFailure } = await load(await read('src/lib/studyGroupLoadErrors.ts'))
const source = await read('src/pages/StudyGroupsPage.tsx')
const tree = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const workspace = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'StudyGroupWorkspace')
const declarations = workspace.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
const arrow = name => {
  const value = declarations.find(node => node.name.getText(tree) === name).initializer
  return (ts.isCallExpression(value) ? value.arguments[0] : value).getText(tree)
}
const setters = ['setGroup', 'setMembers', 'setSchedule', 'setHomework', 'setPermissions', 'setContentGrant', 'setApprovedDeputyIds', 'setSeminarSubjectNames', 'setUnitName', 'setUniversityName', 'setUnitSlug', 'setUniversitySlug', 'setGroupCanEdit', 'setGroupLoadIssue', 'setUnavailableGroupDetails', 'setLoading', 'setError', 'setOfflineCopy']
const keys = [...setters, 'authUser', 'authReadBlocked', 'id', 'active', 'groupLoadSequence', 'homeworkContext', 'supabase', 'loadStudyGroupPermissions', 'loadStudyGroupScheduleHistory', 'getPublicProfiles', 'studyGroupReadFailure', 'STUDY_GROUP_PERMISSIONS', 'STUDY_GROUP_CONTENT_PERMISSIONS', 'canManageStudyGroupContent', 'canRemoveStudyGroupMembers', 'isMissingDatabaseFunction', 'getOfflineOwner', 'removeOfflineGroupSnapshot', 'offlineCaptureController', 'offlineCaptureGeneration', 'groupReadScope', 'currentGroupReadScope', 'closeRepresentativeEditing']
const harness = await load(`export function create(context:any, createStudyGroupRefresh:any) {
 const {${keys.join(',')}} = context;
 const clearPrivateGroup = ${arrow('clearPrivateGroup')};
 const loadGroup = ${arrow('loadGroup')};
 const groupRefresh = createStudyGroupRefresh(loadGroup);
 const requestGroupRefresh = ${arrow('requestGroupRefresh')};
 const invalidateGroupAccess = ${arrow('invalidateGroupAccess')};
 const refreshGroupAfterAction = ${arrow('refreshGroupAfterAction')};
 return {loadGroup,groupRefresh,requestGroupRefresh,invalidateGroupAccess,refreshGroupAfterAction};
}`)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))
async function guarded(pending, signal) {
  if (!signal) return pending
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  let abort
  try { return await Promise.race([pending, new Promise((_, reject) => { abort = () => reject(new DOMException('Aborted', 'AbortError')); signal.addEventListener('abort', abort, { once: true }) })]) }
  finally { signal.removeEventListener('abort', abort) }
}

function fixture(options = {}) {
  const calls = [], state = { group: null, members: [], schedule: [], permissions: [], contentGrant: null, loading: false, offlineCopy: { status: 'idle' } }
  let accessReads = 0
  const context = {
    id: options.groupId || 'group-a', authUser: { id: options.userId || 'user-a' }, authReadBlocked: Boolean(options.blocked),
    active: { current: true }, groupLoadSequence: { current: 0 }, groupReadScope: options.scope || 'user-a:1:group-a',
    currentGroupReadScope: { current: options.scope || 'user-a:1:group-a' },
    homeworkContext: { current: { groupId: options.groupId || 'group-a', userId: options.userId || 'user-a' } },
    studyGroupReadFailure, getOfflineOwner: async () => null, removeOfflineGroupSnapshot: async () => {},
    offlineCaptureController: { current: null }, offlineCaptureGeneration: { current: 0 },
    closeRepresentativeEditing: () => { state.formsClosed = true },
    STUDY_GROUP_PERMISSIONS: [{ key: 'schedule' }], STUDY_GROUP_CONTENT_PERMISSIONS: ['schedule'],
    canManageStudyGroupContent: () => true, canRemoveStudyGroupMembers: () => true,
    isMissingDatabaseFunction: error => error?.code === '42883',
    loadStudyGroupPermissions: async (_, signal) => {
      await transport('permissions', signal)
      if (options.permissionDenied) throw { code: '42501' }
      return ['schedule']
    },
    loadStudyGroupScheduleHistory: async (_, valid, signal) => {
      const snapshot = options.scheduleVersion || 1
      await transport('schedule:first', signal)
      if (!valid()) return { data: null, error: null }
      await transport('schedule:end', signal)
      return { data: [{ id: `lesson-v${snapshot}` }], error: null }
    },
    getPublicProfiles: async (_, signal) => { await transport('profiles', signal); return { data: [{ id: context.authUser.id }], error: null } },
    supabase: {
      from(table) {
        let roster = false, signal
        const query = { select: () => query, eq: () => query, in: () => { roster = true; return query }, order: () => query,
          abortSignal: value => { signal = value; return query }, maybeSingle: () => query,
          then(resolve, reject) { return result().then(resolve, reject) },
        }
        async function result() {
          const kind = table === 'study_group_members' ? roster ? 'roster' : 'membership' : table
          await transport(kind, signal)
          if (table === 'study_groups') return { data: { id: context.id, representative_id: options.revoked ? 'other-leader' : context.authUser.id, created_at: '2026-01-01T00:00:00Z' }, error: null }
          if (table === 'study_group_members') return { data: roster ? [{ user_id: context.authUser.id, status: 'accepted' }] : { status: options.revoked ? 'removed' : 'accepted' }, error: null }
          if (table === 'study_group_seminar_subjects') return { data: [{ name: 'Math' }], error: null }
          return { data: { name: 'Synthetic', slug: 'synthetic' }, error: null }
        }
        return query
      },
      rpc() { let signal; return { abortSignal(value) { signal = value; return this }, then(resolve, reject) { return transport('deputies', signal).then(() => ({ data: [], error: null })).then(resolve, reject) } } },
    },
  }
  async function transport(kind, signal) {
    calls.push({ kind, signal })
    if (kind === 'study_groups' || kind === 'membership') {
      accessReads++
      if (options.accessGate && accessReads <= (options.gatedReads ?? Number.POSITIVE_INFINITY)) await guarded(options.accessGate.promise, signal)
    }
    if (kind === 'schedule:first' && options.scheduleGate) await guarded(options.scheduleGate.promise, signal)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return null
  }
  for (const setter of setters) {
    const key = setter[3].toLowerCase() + setter.slice(4)
    context[setter] = value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  }
  return { calls, state, context, ...harness.create(context, createStudyGroupRefresh) }
}

test('same-turn focus, online and realtime burst reads one authorized group instead of repeated access calls', async () => {
  const baseline = fixture()
  await Promise.all(Array.from({ length: 4 }, () => baseline.loadGroup(true)))
  assert.equal(baseline.calls.length, 17, 'the existing generation guard suppresses stale writes but still sends all eight access reads')
  const current = fixture()
  assert.deepEqual(await Promise.all([
    current.requestGroupRefresh(true, false), current.requestGroupRefresh(true, false),
    current.requestGroupRefresh(true), current.requestGroupRefresh(true),
  ]), [true, true, true, true])
  assert.equal(current.calls.length, 11)
  assert.deepEqual(current.state.schedule, baseline.state.schedule)
  assert.deepEqual(current.state.members, baseline.state.members)
  assert.deepEqual(current.state.permissions, baseline.state.permissions)
})

test('focus and online while access is pending join the existing read and keep page loading semantics', async () => {
  const gate = deferred(), fx = fixture({ accessGate: gate })
  const initial = fx.requestGroupRefresh()
  await turn()
  const focus = fx.requestGroupRefresh(true, false), online = fx.requestGroupRefresh(true, false)
  assert.equal(fx.calls.length, 2)
  gate.resolve()
  assert.deepEqual(await Promise.all([initial, focus, online]), [true, true, true])
  assert.equal(fx.calls.length, 11)
  assert.equal(fx.state.loading, false)
})

test('data change during access aborts the stale read and runs one latest follow-up for every waiter', async () => {
  const gate = deferred(), options = { accessGate: gate, gatedReads: 2, scheduleVersion: 1 }, fx = fixture(options)
  const initial = fx.requestGroupRefresh()
  await turn()
  options.scheduleVersion = 2
  const changes = Array.from({ length: 5 }, () => fx.requestGroupRefresh(true))
  assert.deepEqual(await Promise.all([initial, ...changes]), Array(6).fill(true))
  assert.equal(fx.calls.length, 13)
  assert.ok(fx.calls.slice(0, 2).every(call => call.signal.aborted))
  assert.deepEqual(fx.state.schedule, [{ id: 'lesson-v2' }])
  gate.resolve()
  await turn()
  assert.deepEqual(fx.state.schedule, [{ id: 'lesson-v2' }])
})

test('membership revocation clears visible private state before fresh RLS checks and cancels old optional reads', async () => {
  const gate = deferred(), options = { scheduleGate: gate }, fx = fixture(options)
  const initial = fx.requestGroupRefresh()
  await turn()
  assert.equal(fx.state.group.id, 'group-a')
  fx.state.permissions = ['schedule']; fx.state.contentGrant = { userId: 'user-a', groupId: 'group-a' }
  fx.state.members = [{ user_id: 'old-private-member' }]; fx.state.homework = ['old-private-homework']
  options.revoked = true
  fx.invalidateGroupAccess()
  assert.equal(fx.state.group, null)
  assert.deepEqual(fx.state.members, [])
  assert.deepEqual(fx.state.homework, [])
  assert.deepEqual(fx.state.permissions, [])
  assert.equal(fx.state.contentGrant, null)
  assert.equal(fx.state.formsClosed, true)
  assert.equal(await initial, null)
  await turn(); await turn()
  assert.equal(fx.state.group, null)
  assert.equal(fx.state.groupLoadIssue.kind, 'access')
  assert.ok(fx.calls.find(call => call.kind === 'schedule:first').signal.aborted)
  gate.resolve(); await turn()
  assert.equal(fx.state.group, null)
})

test('authoritative auth block starts no reads and account/session/group changes cannot reuse an old pending response', async () => {
  const blocked = fixture({ blocked: true })
  assert.equal(await blocked.requestGroupRefresh(), null)
  assert.equal(await blocked.loadGroup(), false)
  assert.equal(blocked.calls.length, 0)
  for (const scope of ['user-b:1:group-a', 'user-a:2:group-a', 'user-a:1:group-b']) {
    const gate = deferred(), old = fixture({ accessGate: gate })
    const pending = old.requestGroupRefresh()
    await turn()
    old.context.currentGroupReadScope.current = scope
    old.context.active.current = false
    old.groupRefresh.cancel()
    assert.equal(await pending, null)
    assert.equal(await old.requestGroupRefresh(), null)
    const fresh = fixture({ scope, userId: scope.split(':')[0], groupId: scope.split(':')[2] })
    assert.equal(await fresh.requestGroupRefresh(), true)
    gate.resolve(); await turn()
    assert.equal(old.state.group, null)
    assert.equal(fresh.state.group.id, scope.split(':')[2])
  }
})

test('post-mutation refresh awaits data read after the mutation, preserving invitation/action receipts', async () => {
  const gate = deferred(), options = { accessGate: gate, gatedReads: 2 }, fx = fixture(options)
  const background = fx.requestGroupRefresh(true, false)
  await turn()
  const savedAction = fx.refreshGroupAfterAction(true)
  assert.equal(await savedAction, true)
  assert.equal(await background, true)
  assert.equal(fx.state.group.id, 'group-a')
  gate.resolve()
})

test('serial follow-ups stay bounded when more changes arrive during the queued read and errors remain retryable', async () => {
  const runs = [], gates = [deferred(), deferred(), deferred()]
  let active = 0, maximum = 0
  const coordinator = createStudyGroupRefresh(async (_, signal) => {
    const index = runs.length; runs.push(signal)
    maximum = Math.max(maximum, ++active)
    try { await gates[index].promise; return true } finally { active-- }
  })
  const first = coordinator.request(); await turn()
  const second = coordinator.request(true); coordinator.request(true)
  gates[0].resolve(); await turn()
  const third = coordinator.request(true); coordinator.request(true)
  assert.equal(runs.length, 2)
  gates[1].resolve(); await turn()
  gates[2].resolve()
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true])
  assert.equal(runs.length, 3)
  assert.equal(maximum, 1)
  let fail = true
  const recover = createStudyGroupRefresh(async () => { if (fail) throw Error('temporary'); return true })
  assert.equal(await recover.request(), false)
  fail = false
  assert.equal(await recover.request(), true)
})

test('cancelled initial effects can remount safely and revoked permissions never fall back to an edit grant', async () => {
  let calls = 0
  const coordinator = createStudyGroupRefresh(async () => { calls++; return true })
  const cancelled = coordinator.request()
  coordinator.cancel()
  assert.equal(await cancelled, null)
  assert.equal(await coordinator.request(), true)
  assert.equal(calls, 1)
  const fx = fixture({ permissionDenied: true })
  assert.equal(await fx.requestGroupRefresh(), false)
  assert.deepEqual(fx.state.permissions, [])
  assert.equal(fx.state.contentGrant, null)
})

test('page integration uses all access-table invalidations, retains the visible backstop and remounts on session epoch', () => {
  for (const table of ['study_group_members', 'study_groups', 'study_group_deputy_requests']) assert.match(source, new RegExp(`table: '${table}'[^\\n]+accessChanged`))
  assert.match(source, /table: 'study_group_schedule'[^\n]+dataChanged/)
  assert.match(source, /requestGroupRefresh\(true, false\)/)
  assert.match(source, /visibilityState === 'visible'[\s\S]{0,80}60000/)
  assert.match(source, /if \(authReadBlocked && authUser\) return[\s\S]{0,180}if \(teaching\)/)
  assert.match(source, /StudyGroupWorkspace key=\{`\$\{authUser\?\.id \|\| 'guest'\}:\$\{authReadEpoch\}:\$\{id\}:\$\{Boolean\(xelayUser\?\.isTeacher\)\}`\}/)
})

test('confirmed guests retain the login view while a pending logout hides the old workspace and session changes remount it', () => {
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'StudyGroupDetailPage')
  const compiled = ts.transpileModule(`${declaration.getText(tree)}; exports.render = StudyGroupDetailPage`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const render = (auth, teaching = undefined) => {
    const module = { exports: {} }
    vm.runInNewContext(compiled, { module, exports: module.exports,
      require: name => { assert.equal(name, 'react/jsx-runtime'); return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) } },
      useAuth: () => auth, useParams: () => ({ id: 'group-a' }), useSearch: () => ({ teaching }),
      TeacherGroupPage: 'teacher-workspace', StudyGroupWorkspace: 'student-workspace',
    })
    return module.exports.render()
  }
  assert.equal(render({ authUser: null, authReadBlocked: true, authReadEpoch: 1 }).type, 'student-workspace')
  assert.equal(render({ authUser: null, authReadBlocked: true, authReadEpoch: 1 }, 'course-a').type, 'teacher-workspace')
  const current = { authUser: { id: 'user-a' }, xelayUser: { isTeacher: true }, authReadBlocked: false, authReadEpoch: 1 }
  assert.equal(render({ ...current, authReadBlocked: true }).type, 'main')
  assert.equal(render({ ...current, authReadBlocked: true }, 'course-a').type, 'main')
  assert.notEqual(render(current).key, render({ ...current, authReadEpoch: 2 }).key)
  assert.notEqual(render(current).key, render({ ...current, xelayUser: { isTeacher: false } }).key)
  assert.notEqual(render(current, 'course-a').key, render({ ...current, authReadEpoch: 2 }, 'course-a').key)
})
