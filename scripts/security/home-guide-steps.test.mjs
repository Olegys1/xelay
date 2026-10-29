import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/homeGuideSteps.ts', import.meta.url), 'utf8')
const module = { exports: {} }
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
vm.runInNewContext(compiled, { module, exports: module.exports, require(name) { throw Error('Unexpected import: ' + name) } })
const { homeGuideSteps, placeHomeGuide } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const student = { teaching: false, management: false, multipleGroups: false, usable: true, joinAvailable: false, role: 'student' }

test('student hints include the current day, schedule, homework and updates without privileged or absent controls', () => {
  const steps = homeGuideSteps(student)
  assert.deepEqual(Array.from(steps, step => step.target), ['period', 'schedule', 'tasks', 'updates'])
  assert.ok(steps.find(step => step.target === 'tasks').text.includes('ДЗ'))
  assert.ok(!steps.some(step => step.target === 'management' || step.target === 'join' || step.target === 'group'))
})

test('optional hints follow the actual group, joining and management controls independently', () => {
  for (const multipleGroups of [false, true]) for (const joinAvailable of [false, true]) for (const management of [false, true]) {
    const steps = homeGuideSteps({ ...student, multipleGroups, joinAvailable, management, role: management ? 'headman' : 'student' })
    assert.equal(steps.some(step => step.target === 'group'), multipleGroups)
    assert.equal(steps.some(step => step.target === 'join'), joinAvailable)
    assert.equal(steps.some(step => step.target === 'management'), management)
    assert.equal(new Set(steps.map(step => step.id)).size, steps.length)
    assert.ok(steps.every(step => step.id && step.title && step.text))
    assert.ok(steps.length <= 8)
  }
})

test('teacher hints describe their teaching tools and never expose the internal student distribution', () => {
  const steps = homeGuideSteps({ ...student, teaching: true, management: true, multipleGroups: true, joinAvailable: true, role: 'teacher' })
  const content = steps.map(step => step.title + ' ' + step.text + ' ' + (step.hint || '')).join(' ')
  assert.ok(steps.find(step => step.target === 'tasks').text.includes('перевірки'))
  assert.ok(steps.find(step => step.target === 'management').text.includes('журнал'))
  assert.doesNotMatch(content, /семінар|розподіл|доповнювач|бронюван|команд|реєстрац/i)
})

test('accounts without a connected group receive only the role-appropriate empty-state hint', () => {
  const variants = [
    { role: 'student', teaching: false, expected: /Прийміть запрошення/ },
    { role: 'headman', teaching: false, expected: /Створіть свою групу/ },
    { role: 'teacher', teaching: true, expected: /Відкрийте викладання/ },
  ]
  for (const variant of variants) {
    const steps = homeGuideSteps({ ...student, ...variant, usable: false, management: true, multipleGroups: true, joinAvailable: true })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].target, 'empty')
    assert.match(steps[0].text, variant.expected)
    assert.doesNotMatch(steps[0].text, /реєстрац|парол|команд|розподіл/i)
  }
})

test('failed loading and pending approval explain the current state instead of asking to create another group', () => {
  for (const role of ['student', 'headman', 'teacher']) for (const state of ['error', 'pending']) {
    const steps = homeGuideSteps({ ...student, role, teaching: role === 'teacher', usable: false, state })
    assert.equal(steps.length, 1)
    assert.equal(steps[0].target, 'empty')
    assert.equal(steps[0].id, state === 'error' ? 'retry' : 'pending')
    assert.doesNotMatch(steps[0].text, /створіть|зареєстру|парол/i)
    assert.match(steps[0].text, state === 'error' ? /інтернет|з’єднан|оновити/ : /підтвердження/)
  }
})

test('coach is centered below a target when it fits and above a low target when necessary', () => {
  const viewport = { width: 1024, height: 768 }
  const below = plain(placeHomeGuide({ left: 200, top: 100, width: 200, height: 40 }, { width: 336, height: 285 }, viewport))
  assert.deepEqual({ left: below.left, top: below.top, width: below.width, side: below.side, arrow: below.arrow }, {
    left: 132, top: 153, width: 336, side: 'below', arrow: 168,
  })
  assert.ok(below.maxHeight >= 285)
  assert.ok(below.top + below.maxHeight <= viewport.height - 14)
  const above = placeHomeGuide({ left: 200, top: 650, width: 200, height: 40 }, { width: 336, height: 285 }, viewport)
  assert.equal(above.side, 'above')
  assert.equal(above.top, 352)
  assert.ok(above.top + 285 + 13 <= 650)
})

test('a fallback-sized card remains clipped to the screen before growth is remeasured and then repositions for its actual height', () => {
  const viewport = { width: 390, height: 660 }
  const anchor = { left: 20, top: 290, width: 320, height: 35 }
  const initial = placeHomeGuide(anchor, { width: 336, height: 285 }, viewport)
  assert.equal(initial.side, 'below')
  assert.ok(initial.top + initial.maxHeight <= viewport.height - 14)
  // Even a panel growing taller than the initial estimate cannot exceed this cap.
  assert.ok(initial.top + Math.min(480, initial.maxHeight) <= viewport.height - 14)
  const measured = placeHomeGuide(anchor, { width: 336, height: 480 }, viewport)
  assert.ok(measured.top + Math.min(480, measured.maxHeight) <= viewport.height - 14)
  assert.ok(measured.maxHeight >= Math.min(480, initial.maxHeight))
})

test('mobile panel width and oversized height stay within viewport gutters with an inner scroll region', () => {
  const panel = { width: 336, height: 700 }, viewport = { width: 320, height: 568 }
  const placed = placeHomeGuide({ left: 280, top: 330, width: 30, height: 30 }, panel, viewport)
  assert.equal(placed.left, 14)
  assert.equal(placed.width, 292)
  assert.equal(placed.top, 14)
  assert.equal(placed.maxHeight, 540)
  assert.equal(placed.top + placed.maxHeight, viewport.height - 14)
  assert.ok(placed.arrow >= 22 && placed.arrow <= placed.width - 22)
})

test('visual-viewport offsets and offscreen anchors do not put the card beyond the visible screen', () => {
  const viewport = { width: 390, height: 320, left: 120, top: 80 }
  for (const anchor of [
    { left: -400, top: -800, width: 50, height: 20 },
    { left: 1500, top: 1600, width: 50, height: 20 },
    { left: 120, top: 80, width: 900, height: 800 },
  ]) {
    const panel = { width: 336, height: 285 }
    const placed = placeHomeGuide(anchor, panel, viewport)
    assert.ok(placed.left >= viewport.left + 14)
    assert.ok(placed.left + placed.width <= viewport.left + viewport.width - 14)
    assert.ok(placed.top >= viewport.top + 14)
    assert.ok(placed.top + Math.min(panel.height, placed.maxHeight) <= viewport.top + viewport.height - 14)
  }
})

test('geometry preserves visible bounds across desktop, mobile, zoomed and short viewports', () => {
  let seed = 69293
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  for (let at = 0; at < 500; at++) {
    const viewport = { width: 240 + random() * 1680, height: 160 + random() * 920, left: random() * 200, top: random() * 200 }
    const anchor = { left: random() * 2400 - 300, top: random() * 1500 - 300, width: 24 + random() * 1200, height: 24 + random() * 600 }
    const panel = { width: 220 + random() * 200, height: 180 + random() * 700 }
    const placed = placeHomeGuide(anchor, panel, viewport)
    assert.ok(Object.values(placed).every(value => typeof value !== 'number' || Number.isFinite(value)))
    assert.ok(placed.left >= viewport.left + 14 - 0.000001)
    assert.ok(placed.left + placed.width <= viewport.left + viewport.width - 14 + 0.000001)
    assert.ok(placed.top >= viewport.top + 14 - 0.000001)
    assert.ok(placed.top + Math.min(panel.height, placed.maxHeight) <= viewport.top + viewport.height - 14 + 0.000001)
    assert.ok(placed.arrow >= 22 && placed.arrow <= placed.width - 22)
  }
})
