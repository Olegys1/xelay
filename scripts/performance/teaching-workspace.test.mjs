// Deterministic checks of the production in-flight repository decorator.
// No provider, database, browser, timers or network are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTeachingReadRepository } from '../../src/lib/teachingReadRepository.ts'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() { for (let count = 0; count < 8; count++) await Promise.resolve() }
function fixture() {
  const calls = [], pending = new Map(), reads = new Map()
  const source = { mode: 'local', marker: 'preserved source property' }
  const readNames = ['workspace', 'course', 'group', 'groupMaterials', 'groupAssignments', 'assignmentLessons', 'scheduledItems', 'teacherCalendar', 'gradeRequests', 'myMaterials', 'materialLibrary', 'groupContext', 'classroom', 'classroomSeminars']
  for (const name of readNames) source[name] = function (...args) {
    assert.equal(this, source, 'The original repository remains the method receiver')
    calls.push({ name, args }); reads.set(name, (reads.get(name) || 0) + 1)
    const next = pending.get(name)?.shift()
    return next ? next.promise : Promise.resolve({ name, args, version: reads.get(name) })
  }
  const writeNames = ['mutate', 'classroomMutate', 'setCalendarLesson', 'requestGrade', 'resolveGradeRequest', 'withdrawMaterial', 'upload', 'uploadSubmission']
  for (const name of writeNames) source[name] = function (...args) {
    assert.equal(this, source)
    calls.push({ name, args })
    const next = pending.get(name)?.shift()
    return next ? next.promise : Promise.resolve({ id: 'saved' })
  }
  source.fileUrl = function (file) { assert.equal(this, source); return Promise.resolve(`blob:${file.name}`) }
  source.submissionFileUrl = source.fileUrl
  source.findColleague = function (...args) { calls.push({ name: 'findColleague', args }); return Promise.resolve({ id: args[1] }) }
  source.materialFileInfo = function (...args) { calls.push({ name: 'materialFileInfo', args }); return Promise.resolve({ size: 0 }) }
  source.materialFileChunk = function (...args) { calls.push({ name: 'materialFileChunk', args }); return Promise.resolve(new ArrayBuffer(0)) }
  return {
    source, calls, repository: createTeachingReadRepository(source, 'synthetic-user-a'),
    hold(name) { const next = deferred(); pending.set(name, [...(pending.get(name) || []), next]); return next },
    count(name) { return calls.filter(call => call.name === name).length },
  }
}

test('concurrent equivalent reads share one physical request; completed reads stay fresh', async () => {
  const fx = fixture(), wait = fx.hold('course')
  const first = fx.repository.course('math'), second = fx.repository.course('math')
  await flush()
  assert.equal(fx.count('course'), 1)
  wait.resolve({ id: 'math', version: 1 })
  assert.deepEqual(await first, await second)
  const third = await fx.repository.course('math')
  assert.equal(fx.count('course'), 2)
  assert.equal(third.version, 2)
})

test('different method arguments and different read methods are never conflated', async () => {
  const fx = fixture(), wait = fx.hold('groupAssignments')
  const calls = [fx.repository.groupAssignments('a', '2026-10-27'), fx.repository.groupAssignments('a', '2026-10-28'), fx.repository.groupAssignments('b', '2026-10-27'), fx.repository.groupMaterials('a')]
  await flush()
  assert.equal(fx.count('groupAssignments'), 3); assert.equal(fx.count('groupMaterials'), 1)
  wait.resolve({ assignments: [] }); await Promise.all(calls)
})

test('failed reads are removed and a retry performs a new request', async () => {
  const fx = fixture(), wait = fx.hold('materialLibrary')
  const first = fx.repository.materialLibrary(), second = fx.repository.materialLibrary()
  const rejected = Promise.allSettled([first, second])
  await flush(); assert.equal(fx.count('materialLibrary'), 1)
  wait.reject(new Error('Synthetic transport failure'))
  assert.deepEqual((await rejected).map(result => result.status), ['rejected', 'rejected'])
  await fx.repository.materialLibrary()
  assert.equal(fx.count('materialLibrary'), 2)
})

test('user-scoped repository instances never share an in-flight read', async () => {
  const fx = fixture(), wait = fx.hold('workspace')
  const otherUser = createTeachingReadRepository(fx.source, 'synthetic-user-b')
  const oldAccount = fx.repository.workspace(), newAccount = otherUser.workspace()
  await flush(); assert.equal(fx.count('workspace'), 2)
  const newResult = await newAccount
  wait.resolve({ account: 'a' })
  assert.deepEqual(await oldAccount, { account: 'a' })
  assert.equal(newResult.version, 2)
})

test('separate instances for the same user are also isolated', async () => {
  const fx = fixture(), wait = fx.hold('workspace')
  const otherScope = createTeachingReadRepository(fx.source, 'synthetic-user-a')
  const first = fx.repository.workspace(), second = otherScope.workspace()
  await flush(); assert.equal(fx.count('workspace'), 2)
  wait.resolve({ account: 'a' }); await Promise.all([first, second])
})

for (const method of ['mutate', 'classroomMutate', 'setCalendarLesson', 'requestGrade', 'resolveGradeRequest', 'withdrawMaterial']) {
  test(`${method} invalidates sharing at both write start and completion`, async () => {
    const fx = fixture(), before = fx.hold('course'), writing = fx.hold(method), during = fx.hold('course')
    const stale = fx.repository.course('math')
    await flush()
    const mutation = fx.repository[method]('synthetic', {})
    await flush()
    const duringWrite = fx.repository.course('math')
    await flush(); assert.equal(fx.count('course'), 2, 'Read after write start cannot share the earlier snapshot')
    writing.resolve({ id: 'saved' }); await mutation
    const afterWrite = await fx.repository.course('math')
    assert.equal(fx.count('course'), 3, 'Read after completion cannot share the during-write snapshot')
    assert.equal(afterWrite.version, 3)
    before.resolve({ version: 1 }); during.resolve({ version: 2 })
    await Promise.all([stale, duringWrite])
  })
}

test('failed writes invalidate sharing at completion and preserve the original error', async () => {
  const fx = fixture(), writing = fx.hold('mutate'), wait = fx.hold('workspace')
  const result = fx.repository.mutate('save', {}).catch(error => error)
  await flush()
  const during = fx.repository.workspace()
  await flush()
  writing.reject(new Error('Synthetic conflict'))
  assert.equal((await result).message, 'Synthetic conflict')
  await fx.repository.workspace(); assert.equal(fx.count('workspace'), 2)
  wait.resolve({ version: 1 }); await during
})

test('completion of an old read cannot erase a newer in-flight read after mutation', async () => {
  const fx = fixture(), old = fx.hold('course'), fresh = fx.hold('course')
  const first = fx.repository.course('math'); await flush()
  await fx.repository.mutate('save', {})
  const second = fx.repository.course('math'); await flush()
  old.resolve({ version: 1 }); await first
  const third = fx.repository.course('math'); await flush()
  assert.equal(fx.count('course'), 2)
  fresh.resolve({ version: 2 }); assert.deepEqual(await second, await third)
})

test('mode, passthrough methods and method receiver remain intact', async () => {
  const fx = fixture()
  assert.equal(fx.repository.mode, 'local'); assert.equal(fx.repository.marker, fx.source.marker)
  assert.equal(await fx.repository.fileUrl({ name: 'lecture.pdf' }), 'blob:lecture.pdf')
  const signal = new AbortController().signal
  await fx.repository.findColleague('math', 'colleague', signal)
  assert.equal(fx.calls.at(-1).args[2], signal)
})

for (const method of ['upload', 'uploadSubmission']) {
  test(`${method} preserves file, progress callback and cancellation without treating uncommitted storage bytes as publication`, async () => {
    const fx = fixture(), wait = fx.hold('course')
    const before = fx.repository.course('math'); await flush()
    const file = new File(['Synthetic lecture'], 'lecture.txt', { type: 'text/plain' })
    const progress = () => {}, signal = new AbortController().signal
    await fx.repository[method]('synthetic-course', 'synthetic-user', file, progress, signal)
    const last = fx.calls.at(-1)
    assert.equal(last.name, method); assert.equal(last.args[2], file)
    assert.equal(last.args[3], progress); assert.equal(last.args[4], signal)
    const samePending = fx.repository.course('math'); await flush()
    assert.equal(fx.count('course'), 1, 'Publication metadata changes only in the subsequent mutate call')
    wait.resolve({ version: 1 }); await Promise.all([before, samePending])
  })
}
