import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const module = { exports: {} }, imageSizes = [], canvasSizes = []
const source = readFileSync(new URL('../../src/lib/assistant-v2/workspaceTools.ts', import.meta.url), 'utf8')
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, URL, URLSearchParams, Uint8Array, Blob, btoa: value => Buffer.from(value, 'binary').toString('base64'),
  createImageBitmap: async file => ({ width: file.width || 2560, height: file.height || 1600, close() { imageSizes.push('closed') } }),
  document: { createElement() { return { width: 0, height: 0, getContext() { return { drawImage() {} } }, toBlob(callback, type) { canvasSizes.push([this.width, this.height, type]); callback(new Blob(['synthetic-reencoded-image'], { type })) } } } },
  require() { throw new Error('Runtime imports forbidden') }, fetch() { throw new Error('Network forbidden') },
})
const { assistantRouteContext, createAssistantOfflineCache, clearAssistantOffline, assistantGradeSummary, assistantSourcePath, assistantKyivInstant, assistantKyivInput, assistantImportBatchReady, prepareAssistantImportChunk, prepareAssistantFiles, updateAssistantRecurringDraft, assistantRecurringDraftIssues, ASSISTANT_OFFLINE_TTL, ASSISTANT_OFFLINE_PREFIX } = module.exports
const USER = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002', GROUP = '20000000-0000-4000-8000-000000000001', SECOND = '20000000-0000-4000-8000-000000000002', COURSE = '30000000-0000-4000-8000-000000000001', SUBJECT = '40000000-0000-4000-8000-000000000001'
const catalog = () => ({ userId: USER, groups: [{ id: GROUP, name: 'Тест', program: 'ЕУБ', studyYear: 1, learning: true, permissions: ['schedule'] }], subjects: [{ id: SUBJECT, groupId: GROUP, name: 'Математика', kind: 'study' }], courses: [{ id: COURSE, name: 'Математика', groupIds: [GROUP], subjects: [{ groupId: GROUP, subjectId: SUBJECT }], permissions: ['grades'], archived: false, teaching: true, teachingGroupIds: [GROUP] }] })
const scope = () => ({ groupId: GROUP, from: '2026-11-02', to: '2026-11-02', period: 'current' })
const read = () => ({ userId: USER, audience: 'student', readAt: '2026-11-02T08:00:00Z', truncated: false, records: [{ id: 'lesson', kind: 'lesson', groupId: GROUP, subjectId: SUBJECT, title: 'Математика', date: '2026-11-02', startsAt: '09:40', endsAt: '11:00' }, { id: 'homework', kind: 'homework', groupId: GROUP, subjectId: SUBJECT, title: 'Приклад', body: 'Якщо виконали, перевірте відповідь.', date: '2026-11-02' }] })
function storage() { const entries = new Map(); return { get length() { return entries.size }, key(index) { return [...entries.keys()][index] ?? null }, getItem(key) { return entries.get(key) ?? null }, setItem(key, value) { entries.set(key, value) }, removeItem(key) { entries.delete(key) } } }
const plain = value => JSON.parse(JSON.stringify(value))

const recurring = () => ({ date: '2026-11-02', weekday: 1, recurring: true, validFrom: '2026-11-02', validUntil: '2026-12-31', weekPattern: 'upper', weekAnchorDate: '2026-11-02', subject: 'Математика', startsAt: '08:00', endsAt: '09:20', links: [{ label: 'Zoom', url: 'https://zoom.us/j/123' }], conferenceId: '123', accessCode: 'test-only' })
test('recurring review changes first date and weekday without dropping links, codes or end of period', () => {
  const original = recurring(), next = updateAssistantRecurringDraft(original, 'date', '2026-11-04')
  assert.equal(next.weekday, 3); assert.equal(next.validFrom, '2026-11-04'); assert.equal(next.validUntil, original.validUntil)
  assert.deepEqual(plain(next.links), original.links); assert.equal(next.conferenceId, '123'); assert.equal(next.accessCode, 'test-only')
  assert.equal(original.weekday, 1); assert.deepEqual(plain(assistantRecurringDraftIssues(next)), [])
})
test('alternation and period edits show the first actual class, including negative anchor offsets', () => {
  let next = updateAssistantRecurringDraft(recurring(), 'weekPattern', 'lower')
  assert.equal(next.date, '2026-11-09'); assert.equal(next.validFrom, '2026-11-02')
  next = updateAssistantRecurringDraft(next, 'validFrom', '2026-11-10'); assert.equal(next.date, '2026-11-23')
  next = updateAssistantRecurringDraft(next, 'weekPattern', 'every'); assert.equal(next.date, '2026-11-16'); assert.equal(next.weekAnchorDate, undefined)
  const beforeAnchor = updateAssistantRecurringDraft({ ...recurring(), validFrom: '2026-10-19', date: '2026-10-19' }, 'weekAnchorDate', '2026-11-09')
  assert.equal(beforeAnchor.date, '2026-10-26'); assert.deepEqual(plain(assistantRecurringDraftIssues(beforeAnchor)), [])
})
test('turning recurrence off normalizes legacy and new rules to a single class', () => {
  const next = updateAssistantRecurringDraft({ ...recurring(), week: 'upper' }, 'recurring', false)
  assert.equal(next.recurring, false); assert.equal(next.week, 'both'); assert.equal(next.weekPattern, 'every'); assert.equal(next.weekAnchorDate, undefined)
  assert.equal(next.validFrom, next.date); assert.equal(next.validUntil, next.date); assert.deepEqual(plain(assistantRecurringDraftIssues(next)), [])
})
test('invalid period, weekday, anchor and explicit mismatching week cannot pass recurring review', () => {
  for (const bad of [{ validUntil: '2026-11-01' }, { validUntil: '2028-01-01' }, { date: '2026-02-30' }, { weekday: 2 }, { weekAnchorDate: '2026-11-03' }, { weekPattern: 'lower' }]) assert.ok(assistantRecurringDraftIssues({ ...recurring(), ...bad }).length, JSON.stringify(bad))
  assert.deepEqual(plain(assistantRecurringDraftIssues({ date: '2026-11-02', recurring: false })), [])
})

test('route context accepts only group, subject and teaching course from the caller catalog', () => {
  const context = assistantRouteContext(`/groups/${GROUP}`, `?teaching=${COURSE}&subject=${SUBJECT}&date=2026-11-02`, catalog())
  assert.deepEqual(plain(context), { mode: 'teaching', groupId: GROUP, courseId: COURSE, subjectId: SUBJECT, date: '2026-11-02' })
  const denied = assistantRouteContext(`/groups/${SECOND}`, `?course=${OTHER}&subject=${OTHER}&date=2026-02-30`, catalog())
  assert.deepEqual(plain(denied), { mode: 'learning' })
})
test('student routes cannot select a teacher-only group as learning context', () => {
  const value = catalog(); value.groups[0].learning = false
  assert.equal(assistantRouteContext(`/groups/${GROUP}`, '', value).groupId, undefined)
  assert.equal(assistantRouteContext('/teaching', `?group=${GROUP}&course=${COURSE}`, value).groupId, GROUP)
})
test('offline saves are owner bound and contain only schedule/homework projections', () => {
  const store = storage(), cache = createAssistantOfflineCache(store, USER, () => 1000), value = read()
  value.records[0].accessToken = 'must-never-cache'; value.records[0].roster = ['private']; cache.saveRead('study', scope(), value)
  assert.equal(cache.read('study', scope()).result.records.length, 2)
  assert.equal(store.getItem(ASSISTANT_OFFLINE_PREFIX + USER).includes('must-never-cache'), false)
  assert.equal(createAssistantOfflineCache(store, OTHER, () => 1000).read('study', scope()), undefined)
  assert.equal(cache.read('study', { ...scope(), groupId: SECOND }), undefined)
})
test('private grades, materials, file references and drafts are never put into offline reads', () => {
  const store = storage(), cache = createAssistantOfflineCache(store, USER, () => 1000)
  for (const topic of ['results', 'materials', 'gradebook', 'community']) cache.saveRead(topic, scope(), read())
  cache.saveRead('study', scope(), { ...read(), records: [{ id: 'g', kind: 'grade', points: 99 }] })
  assert.equal(store.length, 0)
})
test('offline catalog drops write permissions and unexpected secret properties', () => {
  const store = storage(), cache = createAssistantOfflineCache(store, USER, () => 1000), value = catalog()
  value.accessToken = 'must-never-cache'; value.groups[0].roster = ['private']; cache.saveCatalog(value)
  assert.deepEqual(plain(cache.catalog().groups[0].permissions), [])
  assert.deepEqual(plain(cache.catalog().courses[0].permissions), [])
  assert.equal(store.getItem(ASSISTANT_OFFLINE_PREFIX + USER).includes('must-never-cache'), false)
  assert.equal(store.getItem(ASSISTANT_OFFLINE_PREFIX + USER).includes('roster'), false)
})
test('offline TTL expires both catalog and reads after 14 days without extending on read', () => {
  const store = storage(); let now = 1000; const cache = createAssistantOfflineCache(store, USER, () => now)
  cache.saveCatalog(catalog()); cache.saveRead('study', scope(), read()); now += ASSISTANT_OFFLINE_TTL
  assert.equal(cache.read('study', scope()).capturedAt, 1000)
  now++; assert.equal(cache.read('study', scope()), undefined); assert.equal(cache.catalog(), undefined)
})
test('future, malformed, wrong-owner and oversized offline envelopes fail closed', () => {
  const store = storage(), key = ASSISTANT_OFFLINE_PREFIX + USER, cache = createAssistantOfflineCache(store, USER, () => 1000)
  for (const value of ['{', JSON.stringify({ version: 1, ownerId: OTHER, reads: [] }), 'x'.repeat(900001), JSON.stringify({ version: 1, ownerId: USER, reads: [{ key: JSON.stringify(['study', GROUP, '', '', '2026-11-02', '2026-11-02', 'current']), capturedAt: 2000, value: read() }] })]) { store.setItem(key, value); assert.equal(cache.read('study', scope()), undefined) }
})
test('logout clears all assistant caches; account switch keeps only the next owner', () => {
  const store = storage(); store.setItem(ASSISTANT_OFFLINE_PREFIX + USER, '{}'); store.setItem(ASSISTANT_OFFLINE_PREFIX + OTHER, '{}'); store.setItem('unrelated', 'keep')
  clearAssistantOffline(store, OTHER); assert.equal(store.getItem(ASSISTANT_OFFLINE_PREFIX + USER), null); assert.equal(store.getItem(ASSISTANT_OFFLINE_PREFIX + OTHER), '{}')
  clearAssistantOffline(store); assert.equal(store.length, 1); assert.equal(store.getItem('unrelated'), 'keep')
})
test('full or unavailable browser storage cannot break a normal online read', () => {
  const cache = createAssistantOfflineCache({ length: 0, key() { return null }, getItem() { throw Error('blocked') }, setItem() { throw Error('full') }, removeItem() { throw Error('blocked') } }, USER)
  assert.doesNotThrow(() => cache.saveRead('study', scope(), read())); assert.equal(cache.catalog(), undefined); assert.doesNotThrow(() => cache.clear())
})
test('shown-work grade totals remain separated by subject and group', () => {
  const values = [{ id: 'a', kind: 'grade', groupId: GROUP, subjectId: SUBJECT, points: 3, maxPoints: 5, coefficient: 2 }, { id: 'b', kind: 'grade', groupId: GROUP, subjectId: SUBJECT, points: 2.5, maxPoints: 5, coefficient: 1 }, { id: 'c', kind: 'grade', groupId: SECOND, subjectId: SUBJECT, points: 1, maxPoints: 5 }, { id: 'd', kind: 'homework', points: 99 }]
  const result = assistantGradeSummary(values, catalog()); assert.equal(result.length, 2); assert.equal(result[0].points, 5.5); assert.equal(result[0].weighted, 8.5); assert.equal(result[1].points, 1)
})
test('deadline inputs are converted using Kyiv time independently from the browser timezone', () => {
  assert.equal(assistantKyivInstant('2026-11-02T18:30'), '2026-11-02T16:30:00.000Z')
  assert.equal(assistantKyivInstant('2026-07-02T18:30'), '2026-07-02T15:30:00.000Z')
  assert.equal(assistantKyivInput('2026-11-02T16:30:00Z'), '2026-11-02T18:30')
  assert.equal(assistantKyivInstant(''), null)
  assert.throws(() => assistantKyivInstant('2026-02-30T12:00'))
  assert.throws(() => assistantKyivInstant('2026-03-29T03:30'))
})
test('source links reject scripts, external redirects, protocol relative paths and backslashes', () => {
  for (const path of ['javascript:alert(1)', '//evil.example', 'https://evil.example', '/groups\\evil', '/admin', '/groups/ bad', '/privacy-policy', '/groups/%2e%2e/admin', '/groups/%5cevil']) assert.equal(assistantSourcePath(path), null)
  assert.equal(assistantSourcePath(`/groups/${GROUP}?tab=schedule&date=2026-11-02`), `/groups/${GROUP}?tab=schedule&date=2026-11-02`)
  assert.equal(assistantSourcePath('/guides/#teacher/start'), '/guides/#teacher/start')
})
const file = (name, text = 'a,b\n1,2') => ({ name, size: Buffer.byteLength(text), arrayBuffer: async () => Uint8Array.from(Buffer.from(text)).buffer })
test('tables are encoded only after explicit selection without importing or contacting providers', async () => {
  const output = await prepareAssistantFiles([file('schedule.csv')]); assert.equal(output[0].mimeType, 'text/csv'); assert.equal(Buffer.from(output[0].data, 'base64').toString(), 'a,b\n1,2')
})
test('image preparation reencodes to WebP and limits longest edge to 1280', async () => {
  const output = await prepareAssistantFiles([file('schedule.png')]); assert.equal(output[0].name, 'schedule.webp'); assert.equal(output[0].mimeType, 'image/webp'); assert.deepEqual(canvasSizes.at(-1), [1280, 800, 'image/webp']); assert.equal(imageSizes.at(-1), 'closed')
})
test('unsupported files, too many files, large tables and extreme image dimensions are rejected', async () => {
  await assert.rejects(prepareAssistantFiles([file('script.html')]), /PNG/)
  await assert.rejects(prepareAssistantFiles(Array.from({ length: 11 }, () => file('a.csv'))), /10/)
  await assert.rejects(prepareAssistantFiles([{ ...file('a.xlsx'), size: 2 * 1024 * 1024 + 1 }]), /2 МБ/)
  await assert.rejects(prepareAssistantFiles([{ ...file('a.png'), width: 10000, height: 10000 }]), /Зображення/)
})

const queue = count => Array.from({ length: count }, (_, index) => ({ action: 'schedule.create', scope: { groupId: GROUP, date: '2026-11-02' }, payload: { date: '2026-11-02', subject: 'Пара ' + index, startsAt: '08:00', endsAt: '09:20', lessonType: 'lecture' } }))
test('an explicit next-chunk action prepares at most ten drafts and never calls a model or confirms a write', async () => {
  const input = queue(25), before = JSON.stringify(input), calls = []; let modelCalls = 0, confirmations = 0
  const dependencies = { current: () => true, prepare: async row => { calls.push(row.payload.subject); return { draft: { id: 'draft-' + calls.length, status: 'pending' } } }, model() { modelCalls++ }, confirm() { confirmations++ } }
  const first = await prepareAssistantImportChunk(input, dependencies)
  assert.equal(first.drafts.length, 10); assert.equal(first.remaining.length, 15); assert.equal(calls.length, 10)
  await Promise.resolve(); assert.equal(calls.length, 10); assert.equal(modelCalls, 0); assert.equal(confirmations, 0); assert.equal(JSON.stringify(input), before)
  assert.equal(assistantImportBatchReady(first.drafts), false)
  const closed = first.drafts.map((draft, index) => ({ ...draft, status: index === 0 ? 'cancelled' : 'confirmed' }))
  assert.equal(assistantImportBatchReady(closed), true)
  const second = await prepareAssistantImportChunk(first.remaining, dependencies)
  assert.equal(second.drafts.length, 10); assert.equal(second.remaining.length, 5); assert.equal(calls.length, 20)
})
test('pending, committing, unknown and stale drafts block the next import batch', () => {
  for (const status of ['pending', 'committing', 'unknown', 'stale']) assert.equal(assistantImportBatchReady([{ status: 'confirmed' }, { status }]), false)
  assert.equal(assistantImportBatchReady([{ status: 'cancelled' }, { status: 'confirmed' }]), true)
})
test('partial preparation keeps created drafts and the exact unprepared remainder without retrying the failing row', async () => {
  const input = queue(20); let calls = 0
  const result = await prepareAssistantImportChunk(input, { current: () => true, prepare: async () => { calls++; if (calls === 3) throw Error('synthetic failure'); return { draft: { id: 'draft-' + calls, status: 'pending' } } } })
  assert.equal(calls, 3); assert.equal(result.drafts.length, 2); assert.equal(result.remaining.length, 18); assert.equal(result.remaining[0].payload.subject, 'Пара 2'); assert.ok(result.error)
})
test('an account change stops further queued requests even when a prior response has arrived', async () => {
  let current = true, calls = 0
  const result = await prepareAssistantImportChunk(queue(20), { current: () => current, prepare: async () => { calls++; current = false; return { draft: { id: 'old-owner-draft', status: 'pending' } } } })
  assert.equal(calls, 1); assert.equal(result.interrupted, true); assert.equal(result.drafts.length, 0)
})
