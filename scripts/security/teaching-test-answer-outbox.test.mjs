import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function fixture() {
  const values = Object.create(null), storage = Object.create({
    getItem: name => values[name] ?? null,
    setItem(name, value) { values[name] = value; this[name] = value },
    removeItem(name) { delete values[name]; delete this[name] },
  }), module = { exports: {} }
  const source = readFileSync(new URL('../../src/lib/teachingTestAnswerOutbox.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, localStorage: storage, console, require(name) { assert.fail('No runtime dependency: ' + name) } })
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
