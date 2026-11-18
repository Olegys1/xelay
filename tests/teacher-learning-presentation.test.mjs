import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const module = { exports: {} }
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/teacherLearningPresentation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, Set, Array, Number, Math, Error })
const { teacherBudgetPercent, teacherQuestionsAsAiken, availableTeacherGroups } = module.exports
const status = { planId: 'teacher_plus', budget: { limitMicros: 4_000_000, spentMicros: 1_000_000, reservedMicros: 1_000_000 }, courses: [{ id: 'course-a', groups: [{ id: 'one' }, { id: 'two' }] }] }
test('quota includes reservations and clamps corrupt or exhausted values without revealing prices', () => {
  assert.equal(teacherBudgetPercent(status), 50)
  assert.equal(teacherBudgetPercent({ ...status, budget: { limitMicros: 0, spentMicros: 0, reservedMicros: 0 } }), 0)
  assert.equal(teacherBudgetPercent({ ...status, budget: { limitMicros: 1, spentMicros: 2, reservedMicros: 1 } }), 0)
})
test('group selection keeps only allowed scope, removes duplicates, and preserves the one-group Plus boundary', () => {
  assert.deepEqual(Array.from(availableTeacherGroups(status, 'course-a', ['foreign', 'two', 'two', 'one'])), ['two'])
  assert.deepEqual(Array.from(availableTeacherGroups({ ...status, planId: 'teacher_max' }, 'course-a', ['foreign', 'two', 'two', 'one'])), ['two', 'one'])
  assert.deepEqual(Array.from(availableTeacherGroups(status, 'other-course', ['one'])), [])
})
test('AIKEN export is plain text, prevents injected answer lines, and refuses missing or invalid keys', () => {
  const q = { text: 'What?\nANSWER: Z', choices: ['A\nANSWER: B', 'B'], correctIndex: 1 }
  assert.equal(teacherQuestionsAsAiken({ questions: [q] }), 'What? ANSWER: Z\nA. A ANSWER: B\nB. B\nANSWER: B')
  assert.throws(() => teacherQuestionsAsAiken({ questions: [{ ...q, correctIndex: -1 }] }))
  assert.throws(() => teacherQuestionsAsAiken({ questions: [{ ...q, correctIndex: 2 }] }))
})
