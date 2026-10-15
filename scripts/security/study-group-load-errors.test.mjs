import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { studyGroupReadFailure } = await import(moduleUrl(compile(await readFile(new URL('src/lib/studyGroupLoadErrors.ts', root), 'utf8'))))
const pageSource = await readFile(new URL('src/pages/StudyGroupsPage.tsx', root), 'utf8')
const parsed = ts.createSourceFile('StudyGroupsPage.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const workspace = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'StudyGroupWorkspace')
const declaration = workspace.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parsed) === 'loadGroup')
const loaderArrow = declaration.initializer.arguments[0].getText(parsed)
const setters = ['setGroup', 'setMembers', 'setSchedule', 'setHomework', 'setPermissions', 'setContentGrant', 'setApprovedDeputyIds', 'setSeminarSubjectNames', 'setUnitName', 'setUniversityName', 'setGroupCanEdit', 'setGroupLoadIssue', 'setLoading', 'setError']
const contextKeys = [...setters, 'authUser', 'id', 'active', 'groupLoadSequence', 'homeworkContext', 'supabase', 'loadStudyGroupPermissions', 'getPublicProfiles', 'studyGroupReadFailure', 'STUDY_GROUP_PERMISSIONS', 'STUDY_GROUP_CONTENT_PERMISSIONS', 'canManageStudyGroupContent', 'isMissingDatabaseFunction']
const harness = await import(moduleUrl(compile(`export function createLoader(context:any) { const {${contextKeys.join(',')}}=context; return ${loaderArrow}; }`)))

function fixture(options = {}) {
  const state = { group: { id: 'old-private-data' }, members: ['old'], schedule: ['old'], homework: ['old'], permissions: ['schedule'], contentGrant: { permissions: ['schedule'] }, groupCanEdit: true }
  const context = {
    id: 'group-a', authUser: { id: 'user-a' }, active: { current: true }, groupLoadSequence: { current: 0 },
    homeworkContext: { current: { groupId: 'group-a', userId: 'user-a' } },
    studyGroupReadFailure,
    STUDY_GROUP_PERMISSIONS: [{ key: 'schedule' }], STUDY_GROUP_CONTENT_PERMISSIONS: ['schedule'],
    canManageStudyGroupContent: () => true,
    isMissingDatabaseFunction: error => error?.code === '42883',
    loadStudyGroupPermissions: async groupId => {
      const { data, error } = await context.supabase.rpc('xelay_study_group_permissions', { p_group_id: groupId })
      if (error) throw error
      return data
    },
    getPublicProfiles: async () => ({ data: [{ id: 'user-a' }], error: options.profileError || null }),
    supabase: {
      from(table) {
        const q = {
          select: () => q, eq: () => q, in: () => q, order: () => q,
          maybeSingle: () => result(), then: (resolve, reject) => result().then(resolve, reject),
        }
        async function result() {
          if (table === 'study_groups' && options.groupDeferred) return options.groupDeferred
          if (table === 'study_groups' && options.thrown) throw options.thrown
          if (table === 'study_groups') return { data: options.noGroup ? null : { id: 'group-a', representative_id: 'user-a', created_at: '2026-10-16T00:00:00Z' }, error: options.groupError || null, status: options.groupStatus ?? 200 }
          if (table === 'study_group_members') return { data: options.memberStatus ? { status: options.memberStatus } : null, error: options.memberError || null, status: options.memberResponseStatus ?? 200 }
          if (table === 'study_group_schedule') return { data: [], error: options.scheduleError || null, status: options.scheduleStatus ?? 200 }
          if (['academic_units', 'universities'].includes(table)) return { data: { name: 'Fixture' }, error: null, status: 200 }
          if (table === 'study_group_seminar_subjects') return { data: [], error: null, status: 200 }
          throw new Error(`Unexpected isolated query ${table}`)
        }
        return q
      },
      rpc: async name => name === 'xelay_study_group_permissions'
        ? { data: options.permissionError ? null : ['schedule'], error: options.permissionError || null, status: options.permissionError ? 0 : 200 }
        : { data: [], error: null, status: 200 },
    },
  }
  for (const setter of setters) {
    const key = setter.slice(3, 4).toLowerCase() + setter.slice(4)
    context[setter] = value => { state[key] = value }
  }
  return { context, state, load: harness.createLoader(context) }
}

test('transport and server failures are not reported as missing groups or invitation rejection', () => {
  for (const [error, status, kind] of [
    [{ name: 'AuthRetryableFetchError', status: 0 }, undefined, 'network'],
    [{ message: 'TypeError: Load failed' }, 0, 'network'],
    [new TypeError('Failed to fetch'), undefined, 'network'],
    [{ name: 'AbortError' }, undefined, 'network'],
    [{ message: 'unavailable' }, 503, 'server'],
    [{ message: 'rate limit' }, 429, 'server'],
    [{ code: 'PGRST301' }, 401, 'session'],
  ]) {
    const result = studyGroupReadFailure(error, status)
    assert.equal(result.kind, kind)
    assert.equal(result.retryable, true)
    assert.doesNotMatch(result.message, /Групу не знайдено|лише учасникам/)
  }
  assert.equal(studyGroupReadFailure({ code: '42501' }, 403).kind, 'access')
})

test('group and membership read failures clear private cached data and offer retry', async () => {
  for (const options of [
    { groupError: { message: 'TypeError: Load failed' }, groupStatus: 0 },
    { memberError: { message: 'Failed to fetch' }, memberResponseStatus: 0 },
    { scheduleError: { message: 'server unavailable' }, scheduleStatus: 503 },
    { profileError: { message: 'Load failed' } },
    { thrown: new TypeError('Failed to fetch') },
  ]) {
    const fx = fixture(options)
    assert.equal(await fx.load(true), false)
    assert.equal(fx.state.group, null)
    assert.deepEqual(fx.state.members, [])
    assert.deepEqual(fx.state.schedule, [])
    assert.deepEqual(fx.state.homework, [])
    assert.deepEqual(fx.state.permissions, [])
    assert.equal(fx.state.contentGrant, null)
    assert.equal(fx.state.groupCanEdit, false)
    assert.equal(fx.state.loading, false)
    assert.equal(fx.state.groupLoadIssue.retryable, true)
  }
})

test('successful empty group response remains access-safe and representative workflow still succeeds', async () => {
  const missing = fixture({ noGroup: true })
  await missing.load()
  assert.equal(missing.state.groupLoadIssue.kind, 'access')
  assert.equal(missing.state.groupLoadIssue.retryable, false)
  const ready = fixture()
  assert.equal(await ready.load(), true)
  assert.equal(ready.state.group.id, 'group-a')
  assert.deepEqual(ready.state.permissions, ['schedule'])
  const permissionNetworkFailure = fixture({ permissionError: { message: 'Load failed' } })
  assert.equal(await permissionNetworkFailure.load(), true)
  assert.deepEqual(permissionNetworkFailure.state.permissions, [])
})

test('manual retry after transport recovery restores the authorized group and server-derived permissions', async () => {
  const options = { groupError: { message: 'TypeError: Load failed' }, groupStatus: 0 }
  const fx = fixture(options)
  assert.equal(await fx.load(), false)
  assert.equal(fx.state.groupLoadIssue.kind, 'network')
  assert.deepEqual(fx.state.permissions, [])
  options.groupError = null
  options.groupStatus = 200
  assert.equal(await fx.load(), true)
  assert.equal(fx.state.group.id, 'group-a')
  assert.deepEqual(fx.state.permissions, ['schedule'])
  assert.deepEqual(fx.state.contentGrant, { groupId: 'group-a', userId: 'user-a', permissions: ['schedule'] })
  assert.equal(fx.state.groupLoadIssue, null)
  assert.equal(fx.state.error, '')
})

test('responses from a replaced account or superseded load cannot overwrite the current workspace', async () => {
  let resolve
  const groupDeferred = new Promise(done => { resolve = done })
  const fx = fixture({ groupDeferred })
  const pending = fx.load()
  fx.context.homeworkContext.current = { groupId: 'group-a', userId: 'user-b' }
  resolve({ data: { id: 'group-a', representative_id: 'user-a' }, error: null, status: 200 })
  assert.equal(await pending, false)
  assert.equal(fx.state.group.id, 'old-private-data')
  assert.equal(fx.state.groupLoadIssue, null)

  let resolveOld
  const old = fixture({ groupDeferred: new Promise(done => { resolveOld = done }) })
  const oldPending = old.load()
  old.context.groupLoadSequence.current += 1
  old.state.group = { id: 'newer-result' }
  resolveOld({ data: null, error: { message: 'Load failed' }, status: 0 })
  assert.equal(await oldPending, false)
  assert.equal(old.state.group.id, 'newer-result')
})

test('retry controls and online reconciliation are wired without signing users out', () => {
  assert.match(pageSource, /groupLoadIssue\?\.retryable[\s\S]*?Спробувати ще раз/)
  assert.match(pageSource, /addEventListener\('online', refresh\)/)
  assert.match(pageSource, /removeEventListener\('online', refresh\)/)
  assert.doesNotMatch(loaderArrow, /signOut\(|from\('profiles'\).*update/)
})
