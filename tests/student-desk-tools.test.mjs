import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const module = { exports: {} }
const source = readFileSync(new URL('../src/lib/studentDeskTools.ts', import.meta.url), 'utf8')
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, URL, Date, Intl, Set, Map, JSON, Number, Object, Array, String, Math })
const { initialDeskState, initialDeskTimer, startDeskTimer, pauseDeskTimer, reconcileDeskTimer, resetDeskFocus, parseDeskState, deskRemaining, deskDay, shiftDeskDay, safeDeskUrl, filterDeskTasks, filterDeskSaved, weeklyDeskMinutes } = module.exports
const today = '2026-11-16', now = Date.parse('2026-11-16T10:00:00Z')
const plain = value => JSON.parse(JSON.stringify(value))

test('saved links accept only normalized HTTP(S) destinations without embedded credentials or control characters', () => {
  assert.equal(safeDeskUrl(' https://example.org/study?q=notes '), 'https://example.org/study?q=notes')
  assert.equal(safeDeskUrl('http://example.org'), 'http://example.org/')
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///secret', '//example.org', 'https://name:password@example.org', 'https://name@example.org', 'https://exam\nple.org', 'https://', 'https://example.org/a b']) assert.equal(safeDeskUrl(value), null, value)
})

test('personal checklists separate overdue, today, completed and subject views without rewriting due dates', () => {
  const state = initialDeskState(today)
  state.tasks.push({ id: 'old', title: 'Old task', subject: 'Менеджмент', due: '2026-11-15', done: false })
  state.tasks[0].done = true
  assert.equal(filterDeskTasks(state.tasks, 'today', today).length, 2)
  assert.deepEqual(Array.from(filterDeskTasks(state.tasks, 'overdue', today), task => task.id), ['old'])
  assert.equal(filterDeskTasks(state.tasks, 'done', today).length, 1)
  assert.equal(filterDeskTasks(state.tasks, 'all', today, 'Менеджмент').length, 2)
  assert.equal(filterDeskTasks(state.tasks, 'all', today)[0].due, '2026-11-15')
})

test('saved search includes text and subject while pinned records sort first', () => {
  const state = initialDeskState(today)
  assert.equal(filterDeskSaved(state.saved, 'КРИВОЇ').length, 1)
  assert.equal(filterDeskSaved(state.saved, 'менеджмент').length, 1)
  assert.equal(filterDeskSaved(state.saved, '', 'link').length, 0)
  assert.equal(filterDeskSaved(state.saved, '')[0].pinned, true)
})

test('timer uses real deadlines, pause preserves remaining seconds and resume retains the same run identity', () => {
  const timer = startDeskTimer(initialDeskTimer(), now, 'run-1')
  assert.equal(deskRemaining(timer, now + 10_001), 1490)
  assert.equal(startDeskTimer(timer, now + 20_000, 'run-2'), timer)
  const paused = pauseDeskTimer(timer, now + 10_001)
  assert.equal(paused.remainingSec, 1490)
  assert.equal(paused.deadline, null)
  const resumed = startDeskTimer(paused, now + 100_000, 'discarded-run')
  assert.equal(resumed.runId, 'run-1')
  assert.equal(resumed.deadline, now + 100_000 + 1490_000)
  assert.equal(deskRemaining(resumed, now + 100_000), 1490)
  assert.throws(() => startDeskTimer(initialDeskTimer(), NaN, 'run'))
})

test('refresh and clock wake complete a focus session exactly once at its deadline', () => {
  const state = initialDeskState(today)
  state.timer = startDeskTimer(state.timer, now, 'run-1')
  const restored = parseDeskState(JSON.stringify(state), today, now + 1500_000)
  assert.equal(restored.timer.status, 'finished')
  assert.equal(restored.timer.remainingSec, 0)
  assert.deepEqual(plain(restored.sessions), [{ id: 'run-1', day: today, minutes: 25, subject: 'Моя підготовка' }])
  assert.equal(reconcileDeskTimer(restored, now + 2000_000), restored)
  const twice = parseDeskState(JSON.stringify(restored), today, now + 3000_000)
  assert.equal(twice.sessions.length, 1)
})

test('breaks, paused sessions and unfinished resets do not claim focused work; reset at exact expiry keeps completed work', () => {
  const state = initialDeskState(today)
  state.timer = startDeskTimer(initialDeskTimer('break'), now, 'break-1')
  assert.equal(reconcileDeskTimer(state, now + 300_000).sessions.length, 0)
  state.timer = pauseDeskTimer(startDeskTimer(initialDeskTimer(), now, 'focus-1'), now + 30_000)
  assert.equal(reconcileDeskTimer(state, now + 2000_000).sessions.length, 0)
  state.timer = startDeskTimer(initialDeskTimer(), now, 'focus-2')
  const unfinished = resetDeskFocus(state, now + 1000)
  assert.equal(unfinished.timer.status, 'idle')
  assert.equal(unfinished.sessions.length, 0)
  const exact = resetDeskFocus(state, now + 1500_000)
  assert.equal(exact.sessions.length, 1)
  assert.equal(exact.timer.status, 'idle')
})

test('pause or restart at the exact deadline cannot lose the original completed session', () => {
  const state = initialDeskState(today)
  const original = startDeskTimer(state.timer, now, 'original-focus')
  state.timer = pauseDeskTimer(original, now + 1500_000)
  assert.equal(state.timer, original)
  state.timer = startDeskTimer(state.timer, now + 1500_001, 'should-not-start')
  assert.equal(state.timer.runId, 'original-focus')
  const complete = reconcileDeskTimer(state, now + 1500_001)
  assert.equal(complete.sessions.length, 1)
  assert.equal(complete.sessions[0].id, 'original-focus')
  assert.equal(complete.timer.status, 'finished')
})

test('Kyiv calendar days and weekly totals handle midnight and exclude older sessions', () => {
  assert.equal(deskDay(new Date('2026-11-15T22:10:00Z')), today)
  assert.equal(shiftDeskDay('2026-10-25', 1), '2026-10-26')
  const days = weeklyDeskMinutes([{ id: 'old', day: '2026-11-09', minutes: 25, subject: '' }, { id: 'inside', day: '2026-11-10', minutes: 25, subject: '' }, { id: 'today', day: today, minutes: 50, subject: '' }], today)
  assert.equal(days.length, 7)
  assert.equal(days[0].day, '2026-11-10')
  assert.equal(days.reduce((sum, day) => sum + day.minutes, 0), 75)
})

test('corrupt storage, hostile IDs, duplicate sessions, dangerous links and malformed running state are rejected', () => {
  assert.equal(parseDeskState('{', today, now).tasks.length, 3)
  assert.equal(parseDeskState('x'.repeat(600001), today, now).tasks.length, 3)
  const value = initialDeskState(today)
  value.tasks.push({ ...value.tasks[0] }, { ...value.tasks[0], id: '__proto__' })
  value.saved.push({ id: 'unsafe', kind: 'link', title: 'unsafe', subject: '', content: 'javascript:alert(1)', pinned: true })
  value.sessions = [{ id: 'run', day: today, subject: '', minutes: 25 }, { id: 'run', day: today, subject: '', minutes: 25 }]
  value.timer = { ...value.timer, status: 'running', runId: 'run', startedAt: now, deadline: now + 10000000000 }
  const recovered = parseDeskState(JSON.stringify(value), today, now)
  assert.equal(recovered.tasks.length, 3)
  assert.equal(recovered.saved.length, 2)
  assert.equal(recovered.sessions.length, 1)
  assert.equal(recovered.timer.status, 'idle')
})

test('empty user collections and their edits survive reload instead of restoring demonstration rows', () => {
  const state = initialDeskState(today)
  state.tasks = []
  state.saved = []
  const recovered = parseDeskState(JSON.stringify(state), today, now)
  assert.deepEqual(plain(recovered.tasks), [])
  assert.deepEqual(plain(recovered.saved), [])
})
