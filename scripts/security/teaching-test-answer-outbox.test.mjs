import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function sharedStorage(initial = {}) {
  const values = Object.create(null), storage = Object.create({
    getItem: name => values[name] ?? null,
    setItem(name, value) { values[name] = value; this[name] = value },
    removeItem(name) { delete values[name]; delete this[name] },
  })
  for (const [name, value] of Object.entries(initial)) storage.setItem(name, value)
  return { values, storage }
}
function fixture({ shared = sharedStorage(), session } = {}) {
  const { values, storage } = shared, module = { exports: {} }
  const source = readFileSync(new URL('../../src/lib/teachingTestAnswerOutbox.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: storage, ...(session ? { window: { sessionStorage: session.storage } } : {}), console, require(name) { assert.fail('No runtime dependency: ' + name) } })
  return { api: module.exports, values, storage }
}
const plain = value => JSON.parse(JSON.stringify(value))
const draft = (answer, patch = {}) => ({ attemptId: 'attempt-one', questionId: 'question-one', baseVersion: 3, answer, ...patch })

test('long Cyrillic essay and all structured answer kinds restore losslessly in the same scope only', () => {
  const { api, values } = fixture(), essay = 'Український текст 🧪 '.repeat(400)
  for (const [index, answer] of [essay, ['a', 'c', 'b'], { first: 'Власний текст', second: '2.5' }, ''].entries()) {
    assert.equal(api.writeTeachingTestAnswerDraft('owner-one', 'test-one', draft(answer, { questionId: 'question-' + index })).error, '')
  }
  const copy = api.readTeachingTestAnswerOutbox('owner-one', 'test-one')
  assert.equal(copy.drafts.length, 4); assert.equal(copy.drafts[0].answer, essay)
  assert.equal(api.readTeachingTestAnswerOutbox('owner-two', 'test-one').drafts.length, 0)
  assert.equal(api.readTeachingTestAnswerOutbox('owner-one', 'test-two').drafts.length, 0)
  assert.doesNotMatch(JSON.stringify(values), /expires_at|question_text|correct|options|opened_at|access_code/)
})

test('only an exact server receipt removes an own draft; old attempts and stale acknowledgements cannot erase a newer edit', () => {
  const { api } = fixture()
  api.writeTeachingTestAnswerDraft('owner', 'test', draft('newest'))
  assert.equal(api.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-two', answers: { 'question-one': 'newest' } }).drafts.length, 1)
  assert.equal(api.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'older' } }).drafts.length, 1)
  assert.equal(api.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'newest' } }).drafts.length, 0)
  assert.equal(api.readTeachingTestAnswerOutbox('owner', 'test').raw, '')
})

test('corrupt, oversized and cross-owner bytes remain exportable and cannot be silently replaced by an empty or new draft', () => {
  for (const raw of ['{broken', 'x'.repeat(1_500_001), JSON.stringify({ version: 1, ownerId: 'foreign', testId: 'test', drafts: [draft('foreign')] })]) {
    const { api, storage } = fixture(), key = 'xelay:teaching-answer-outbox:v1:owner:test'
    storage.setItem(key, raw)
    const restored = api.readTeachingTestAnswerOutbox('owner', 'test')
    assert.ok(restored.error); assert.equal(restored.raw, raw)
    assert.equal(api.writeTeachingTestAnswerDraft('owner', 'test', draft('new answer')).raw, raw)
    assert.equal(storage.getItem(key), raw)
  }
})

test('invalid shape, spoofed deadline and oversized edits are rejected without losing an earlier answer', () => {
  const { api } = fixture()
  api.writeTeachingTestAnswerDraft('owner', 'test', draft('safe earlier answer'))
  for (const changed of [{ expires_at: '2099-01-01' }, { baseVersion: -1 }, { answer: { nested: {} } }, { questionId: '../other' }, { answer: 'x'.repeat(200_001) }]) {
    assert.ok(api.writeTeachingTestAnswerDraft('owner', 'test', draft('changed', changed)).error)
    assert.equal(api.readTeachingTestAnswerOutbox('owner', 'test').drafts[0].answer, 'safe earlier answer')
  }
})

test('capacity or quota exhaustion reports failure and preserves the prior bytes; logout cleanup only deletes this feature', () => {
  const { api, storage } = fixture()
  for (let index = 0; index < 100; index++) assert.equal(api.writeTeachingTestAnswerDraft('owner', 'test', draft('answer', { questionId: 'q-' + index })).error, '')
  const before = api.readTeachingTestAnswerOutbox('owner', 'test').raw
  assert.ok(api.writeTeachingTestAnswerDraft('owner', 'test', draft('overflow', { questionId: 'overflow' })).error)
  assert.equal(api.readTeachingTestAnswerOutbox('owner', 'test').raw, before)
  const failing = { getItem: storage.getItem, removeItem: storage.removeItem, setItem() { throw Error('quota') } }
  assert.ok(api.writeTeachingTestAnswerDraft('owner', 'test', draft('replacement', { questionId: 'q-0' }), failing).error)
  assert.equal(api.readTeachingTestAnswerOutbox('owner', 'test').raw, before)
  storage.setItem('unrelated', 'untouched')
  api.clearTeachingTestAnswerOutbox()
  assert.equal(api.readTeachingTestAnswerOutbox('owner', 'test').raw, '')
  assert.equal(storage.getItem('unrelated'), 'untouched')
})

test('two separate tabs keep unsent A after B writes and acknowledges a different same-question answer, including A reload', () => {
  const shared = sharedStorage(), sessionA = sharedStorage(), a = fixture({ shared, session: sessionA }).api
  assert.equal(a.writeTeachingTestAnswerDraft('owner', 'test', draft('UNSENT_TAB_A')).error, '')
  // Browser Duplicate Tab may clone sessionStorage: this must not clone ownership
  // of a mutable outbox entry or make B retire A's unaccepted answer.
  const sessionB = sharedStorage({ ...sessionA.values }), b = fixture({ shared, session: sessionB }).api
  assert.equal(b.writeTeachingTestAnswerDraft('owner', 'test', draft('ACCEPTED_TAB_B')).error, '')
  assert.deepEqual(plain(b.readTeachingTestAnswerOutbox('owner', 'test').drafts.map(row => row.answer)).sort(), ['ACCEPTED_TAB_B', 'UNSENT_TAB_A'])
  assert.equal(fixture({ shared, session: sessionA }).api.readTeachingTestAnswerOutbox('owner', 'test').drafts[0].answer, 'UNSENT_TAB_A', 'reload prefers A’s own old document without dropping B’s copy')
  b.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'ACCEPTED_TAB_B' } })
  const reopened = fixture({ shared, session: sessionA }).api.readTeachingTestAnswerOutbox('owner', 'test')
  assert.equal(reopened.error, '')
  assert.equal(reopened.drafts.length, 1)
  assert.equal(reopened.drafts[0].answer, 'UNSENT_TAB_A')
  assert.equal(reopened.drafts[0].baseVersion, 3, 'preserving bytes must never rebase a stale version for automatic replay')
  assert.match(reopened.raw, /UNSENT_TAB_A/)
})

test('an acknowledgement interleaved with a new edit deletes its immutable old copy only', () => {
  const shared = sharedStorage(), a = fixture({ shared }).api, b = fixture({ shared }).api
  a.writeTeachingTestAnswerDraft('owner', 'test', draft('SAVED_OLD_A'))
  const remove = shared.storage.removeItem
  let interleaved = false
  shared.storage.removeItem = function (name) {
    if (!interleaved && name.startsWith('xelay:teaching-answer-outbox:')) {
      interleaved = true
      assert.equal(a.writeTeachingTestAnswerDraft('owner', 'test', draft('UNSENT_NEW_A')).error, '')
    }
    remove.call(this, name)
  }
  b.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'SAVED_OLD_A' } })
  assert.equal(interleaved, true)
  const restored = fixture({ shared }).api.readTeachingTestAnswerOutbox('owner', 'test')
  assert.equal(restored.drafts.length, 1)
  assert.equal(restored.drafts[0].answer, 'UNSENT_NEW_A')
})

test('legacy v1 shared copies stay readable beside new immutable records and another tab cannot replace them', () => {
  const shared = sharedStorage(), legacy = { version: 1, ownerId: 'owner', testId: 'test', drafts: [draft('LEGACY_UNSENT_A')] }
  shared.storage.setItem('xelay:teaching-answer-outbox:v1:owner:test', JSON.stringify(legacy))
  const b = fixture({ shared }).api
  b.writeTeachingTestAnswerDraft('owner', 'test', draft('NEW_ACCEPTED_B'))
  b.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'NEW_ACCEPTED_B' } })
  const reopened = fixture({ shared }).api
  assert.equal(reopened.readTeachingTestAnswerOutbox('owner', 'test').drafts[0].answer, 'LEGACY_UNSENT_A')
  reopened.acknowledgeTeachingTestAnswerDraft('owner', 'test', { id: 'attempt-one', answers: { 'question-one': 'LEGACY_UNSENT_A' } })
  assert.equal(reopened.readTeachingTestAnswerOutbox('owner', 'test').raw, '')
})

test('explicit copy removal stays within the exact owner/test including separate documents', () => {
  const shared = sharedStorage(), a = fixture({ shared }).api, b = fixture({ shared }).api
  a.writeTeachingTestAnswerDraft('owner', 'test', draft('A'))
  b.writeTeachingTestAnswerDraft('owner', 'test', draft('B'))
  a.writeTeachingTestAnswerDraft('other-owner', 'test', draft('PRIVATE_OTHER_OWNER'))
  a.writeTeachingTestAnswerDraft('owner', 'other-test', draft('PRIVATE_OTHER_TEST'))
  a.discardTeachingTestAnswerOutbox('owner', 'test')
  assert.equal(b.readTeachingTestAnswerOutbox('owner', 'test').raw, '')
  assert.equal(b.readTeachingTestAnswerOutbox('other-owner', 'test').drafts[0].answer, 'PRIVATE_OTHER_OWNER')
  assert.equal(b.readTeachingTestAnswerOutbox('owner', 'other-test').drafts[0].answer, 'PRIVATE_OTHER_TEST')
})

test('two offline documents each keep a full 100-question copy within a bounded shared byte budget', () => {
  const shared = sharedStorage(), a = fixture({ shared }).api, b = fixture({ shared }).api
  for (let index = 0; index < 100; index++) {
    assert.equal(a.writeTeachingTestAnswerDraft('owner', 'test', draft('A-' + index, { questionId: 'q-' + index })).error, '')
    assert.equal(b.writeTeachingTestAnswerDraft('owner', 'test', draft('B-' + index, { questionId: 'q-' + index })).error, '')
  }
  const restored = fixture({ shared }).api.readTeachingTestAnswerOutbox('owner', 'test')
  assert.equal(restored.error, '')
  assert.equal(restored.drafts.length, 200)
  assert.ok(restored.raw.length < 1_500_000)
  assert.ok(a.writeTeachingTestAnswerDraft('owner', 'test', draft('overflow', { questionId: 'q-101' })).error)
  assert.equal(fixture({ shared }).api.readTeachingTestAnswerOutbox('owner', 'test').drafts.length, 200)
})

test('a corrupt or oversized first legacy copy never excludes later sound document copies from recovery export', () => {
  for (const broken of ['{broken-first', 'x'.repeat(1_500_001)]) {
    const shared = sharedStorage(), a = fixture({ shared }).api, b = fixture({ shared }).api
    a.writeTeachingTestAnswerDraft('owner', 'test', draft('RECOVERABLE_A'))
    b.writeTeachingTestAnswerDraft('owner', 'test', draft('RECOVERABLE_B'))
    shared.storage.setItem('xelay:teaching-answer-outbox:v1:owner:test', broken)
    const copy = a.readTeachingTestAnswerOutbox('owner', 'test')
    assert.ok(copy.error)
    const exported = JSON.parse(copy.raw)
    assert.equal(exported.copies.length, 3)
    assert.equal(exported.copies[0], broken)
    assert.match(copy.raw, /RECOVERABLE_A/)
    assert.match(copy.raw, /RECOVERABLE_B/)
    const before = JSON.stringify(shared.values)
    assert.ok(b.writeTeachingTestAnswerDraft('owner', 'test', draft('BLOCKED_NEW_EDIT')).error)
    assert.equal(JSON.stringify(shared.values), before, 'corruption does not authorize overwriting or removing any copy')
  }
})
