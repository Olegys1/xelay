import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const module = { exports: {} }
runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/subscriptionOrderPresentation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports })
const { subscriptionOrderPresentation } = module.exports
const order = { id: '00000000-0000-4000-8000-000000000901', product: 'participant', mode: 'live', status: 'approved', approved_at: '2026-11-17T12:00:00Z', amount: 499, student_plan_id: null }
test('all canonical teacher billing plan IDs are labelled separately and never select the legacy or student purchase celebration', () => {
  for (const [teacher_plan_id, name] of [['teacher_start','Старт'],['teacher_plus','Плюс'],['teacher_max','Макс']]) {
    const result = subscriptionOrderPresentation({ ...order, teacher_plan_id })
    assert.equal(result.title, `Для викладача · ${name} · один місяць`)
    assert.equal(result.welcome, null)
  }
  assert.equal(subscriptionOrderPresentation({ ...order, teacher_plan_id: 'future_teacher_tier' }).welcome, null)
  assert.equal(subscriptionOrderPresentation({ ...order, teacher_plan_id: 'teacher_plus', student_plan_id: 'max' }).welcome, null)
})
test('existing legacy, student and group order presentation is retained', () => {
  assert.equal(subscriptionOrderPresentation(order).title, 'Учасник · один місяць')
  assert.equal(subscriptionOrderPresentation(order).welcome, 'legacy')
  assert.equal(subscriptionOrderPresentation({ ...order, student_plan_id: 'plus' }).title, 'Плюс · один місяць')
  assert.equal(subscriptionOrderPresentation({ ...order, student_plan_id: 'plus' }).welcome, 'student')
  assert.equal(subscriptionOrderPresentation({ ...order, product: 'group' }).welcome, null)
})
