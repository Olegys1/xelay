import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import * as visibility from '../../src/lib/studyGroupVisibility.ts'

const source = readFileSync(new URL('../../src/lib/offlineStudy.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const teacher = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const groupId = '20000000-0000-4000-8000-000000000001'
const dateRange = { rangeStart: '2026-11-09', rangeEnd: '2026-11-22' }
const lesson = {
  id: 'lesson-a', groupId, groupName: 'Вигадана група', subject: 'Математика', date: dateRange.rangeStart,
  startsAt: '09:40', endsAt: '11:00', lessonType: 'seminar', location: 'Аудиторія 2',
  homework: [{ title: 'Вправи', dueAt: '2026-11-10T16:00:00Z', audience: 'Для всієї групи' }],
}
const input = { ...dateRange, lessons: [lesson] }
const studentInput = { ...dateRange, groupId, groupName: 'Вигадана група', lessons: [], homework: [], assignments: [] }

// A serialized transactional stand-in for the two existing stores. Separate VM
// modules share durable state to exercise account reloads and stale-tab writes.
function fixture() {
  let stores = { meta: new Map(), groups: new Map() }
  let pending = Promise.resolve(), now = Date.now(), unavailable = false
  const storage = new Map()
  const db = { transaction(names, mode) {
    assert.deepEqual([...names], ['meta', 'groups'])
    if (unavailable) throw new Error('Synthetic IndexedDB unavailable')
    let drafts, release, queued = 0, ended = false
    const start = pending.then(() => { drafts = structuredClone(stores) })
    pending = start.then(() => new Promise(resolve => { release = resolve }))
    const finish = (commit) => {
      if (ended) return
      ended = true
      if (commit && mode === 'readwrite') stores = drafts
      release()
      if (commit) tx.oncomplete()
      else tx.onabort()
    }
    const tx = {
      objectStore(name) {
        function read(callback) {
          const request = {}
          queued++
          void start.then(() => {
            if (ended) return
            request.result = structuredClone(callback(drafts[name]))
            request.onsuccess()
            if (--queued === 0) finish(true)
          })
          return request
        }
        return {
          get: key => read(store => store.get(key)), getAll: () => read(store => [...store.values()]),
          put(value, key = value.key) { assert.equal(mode, 'readwrite'); drafts[name].set(key, structuredClone(value)) },
          delete(key) { assert.equal(mode, 'readwrite'); drafts[name].delete(key) },
          clear() { assert.equal(mode, 'readwrite'); drafts[name].clear() },
        }
      },
      abort() { if (drafts) finish(false); else void start.then(() => finish(false)) },
    }
    void start.then(() => { if (queued === 0) finish(true) })
    return tx
  } }
  const indexedDB = { open(_name, version) {
    assert.equal(version, 1, 'existing IDB schema must stay readable')
    const request = { result: db }
    queueMicrotask(() => request.onsuccess())
    return request
  } }
  function open() {
    const module = { exports: {} }
    vm.runInNewContext(compiled, {
      module, exports: module.exports, indexedDB, crypto, TextEncoder, URL,
      Date: class extends Date { static now() { return now } },
      localStorage: {
        get length() { return storage.size }, key: index => [...storage.keys()][index] ?? null,
        getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
      },
      require(name) { assert.equal(name, './studyGroupVisibility'); return visibility },
    })
    return module.exports
  }
  return { open, advance: ms => { now += ms }, setUnavailable: value => { unavailable = value }, raw: () => stores }
}

async function saveCalendar(storage, userId = teacher, calendar = input) {
  const { sessionId } = await storage.establishOfflineOwner(userId, 'Тестовий викладач')
  const revision = await storage.getOfflineTeacherCalendarRevision(userId, sessionId)
  const snapshot = await storage.saveOfflineTeacherCalendar(userId, calendar, sessionId, revision)
  return { snapshot, sessionId, revision }
}

test('only the allowlisted teacher fields survive a cold read and the legacy student copy remains', async () => {
  const fx = fixture(), storage = fx.open()
  const injected = { ...lesson, conferenceAccessCode: 'private-conference', teacherName: 'Private name',
    onlineUrl: 'https://example.test/private', homework: [{ ...lesson.homework[0], body: 'Private text', files: ['private-file'] }] }
  const { sessionId } = await saveCalendar(storage, teacher, { ...input, accessToken: 'secret-token', lessons: [injected,
    { ...lesson, id: 'hidden', groupId: visibility.TEACHING_QA_GROUP_ID }] })
  await storage.saveOfflineGroupSnapshot(teacher, studentInput, sessionId)
  const fresh = fx.open(), loaded = await fresh.loadOfflineTeacherCalendar(teacher)
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.lessons)), [lesson])
  assert.equal(loaded.sessionId, sessionId)
  assert.equal((await fresh.listOfflineGroups(teacher)).length, 1)
  assert.doesNotMatch(JSON.stringify(fx.raw().meta.get('teacher-calendar')), /private-|Private|secret-token/)
  assert.equal(await fresh.loadOfflineTeacherCalendar(other), null)
})

test('removal rotates the durable revision and rejects a delayed same-account save in another tab', async () => {
  const fx = fixture(), firstTab = fx.open()
  const { sessionId, revision } = await saveCalendar(firstTab)
  const secondTab = fx.open()
  await secondTab.removeOfflineTeacherCalendar(teacher, sessionId)
  assert.equal(await firstTab.loadOfflineTeacherCalendar(teacher), null)
  await assert.rejects(firstTab.saveOfflineTeacherCalendar(teacher, input, sessionId, revision), /OFFLINE_OWNER_CHANGED/)
  const freshRevision = await firstTab.getOfflineTeacherCalendarRevision(teacher, sessionId)
  assert.notEqual(freshRevision, revision)
  await firstTab.saveOfflineTeacherCalendar(teacher, input, sessionId, freshRevision)
  assert.equal((await secondTab.loadOfflineTeacherCalendar(teacher)).lessons.length, 1)
})

test('switching accounts deletes the teacher slot and rejects pending saves even after switching back', async () => {
  const fx = fixture(), firstTab = fx.open()
  const { sessionId, revision } = await saveCalendar(firstTab)
  const secondTab = fx.open()
  await secondTab.establishOfflineOwner(other)
  assert.equal(fx.raw().meta.has('teacher-calendar'), false)
  assert.equal(await firstTab.loadOfflineTeacherCalendar(teacher), null)
  assert.notEqual((await secondTab.establishOfflineOwner(teacher)).sessionId, sessionId)
  await assert.rejects(firstTab.saveOfflineTeacherCalendar(teacher, input, sessionId, revision), /OFFLINE_OWNER_CHANGED/)
  assert.equal(await secondTab.loadOfflineTeacherCalendar(teacher), null)
})

test('logout tombstone denies cold reads after a failed purge and next login removes old data', async () => {
  const fx = fixture(), storage = fx.open()
  await saveCalendar(storage)
  fx.setUnavailable(true)
  await assert.rejects(storage.clearOfflineStudy(), /OFFLINE_PURGE_PENDING/)
  fx.setUnavailable(false)
  const fresh = fx.open()
  assert.equal(fx.raw().meta.has('teacher-calendar'), true)
  assert.equal(await fresh.getOfflineOwner(), null)
  assert.equal(await fresh.loadOfflineTeacherCalendar(teacher), null)
  await fresh.establishOfflineOwner(teacher)
  assert.equal(fx.raw().meta.has('teacher-calendar'), false)
})

test('failed teacher removal blocks cold reads and stale writes while keeping the student copy', async () => {
  const fx = fixture(), storage = fx.open()
  const { sessionId, revision } = await saveCalendar(storage)
  await storage.saveOfflineGroupSnapshot(teacher, studentInput, sessionId)
  fx.setUnavailable(true)
  await assert.rejects(storage.removeOfflineTeacherCalendar(teacher, sessionId), /Synthetic IndexedDB unavailable/)
  fx.setUnavailable(false)
  const fresh = fx.open()
  assert.ok(fx.raw().meta.get('teacher-calendar').snapshot, 'the physical purge deliberately failed')
  assert.equal(await fresh.loadOfflineTeacherCalendar(teacher), null)
  assert.equal((await fresh.listOfflineGroups(teacher)).length, 1)
  await assert.rejects(storage.saveOfflineTeacherCalendar(teacher, input, sessionId, revision), /OFFLINE_OWNER_CHANGED/)
  const newRevision = await fresh.getOfflineTeacherCalendarRevision(teacher, sessionId)
  assert.notEqual(newRevision, revision)
  assert.equal(fx.raw().meta.get('teacher-calendar').snapshot, null)
  assert.equal(await storage.loadOfflineTeacherCalendar(teacher), null)
  await fresh.saveOfflineTeacherCalendar(teacher, input, sessionId, newRevision)
  assert.equal((await storage.loadOfflineTeacherCalendar(teacher)).lessons.length, 1)
})

test('rejects invalid lesson dates and expires the saved calendar after 14 days', async () => {
  const fx = fixture(), storage = fx.open()
  const { sessionId, revision } = await saveCalendar(storage)
  await assert.rejects(storage.saveOfflineTeacherCalendar(teacher, { ...input, lessons: [{ ...lesson, date: '2026-11-23' }] }, sessionId, revision), /OFFLINE_SNAPSHOT_INVALID/)
  fx.advance(storage.OFFLINE_STUDY_TTL_MS)
  assert.equal(await storage.loadOfflineTeacherCalendar(teacher), null)
  assert.equal(fx.raw().meta.get('teacher-calendar').snapshot, null)
})
