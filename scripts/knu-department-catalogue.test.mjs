import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const catalogue = JSON.parse(readFileSync(new URL('../src/data/knuAcademicDepartments.json', import.meta.url), 'utf8'))
const migration = readFileSync(new URL('../supabase/migrations/202610290006_knu_department_catalogue.sql', import.meta.url), 'utf8')
const code = ts.transpileModule(readFileSync(new URL('../src/lib/academicDepartments.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports, require: name => { assert.equal(name, '../data/knuAcademicDepartments.json'); return catalogue } })
const { academicDepartmentsForScope, academicDepartmentMatches } = module.exports
const selectCode = ts.transpileModule(readFileSync(new URL('../src/components/AcademicDepartmentSelect.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const selectModule = { exports: {} }, jsx = (type, props, key) => ({ type, props, key })
vm.runInNewContext(selectCode, { module: selectModule, exports: selectModule.exports, require(name) {
  assert.equal(name, 'react/jsx-runtime'); return { jsx, jsxs: jsx, Fragment: 'fragment' }
} })
const DepartmentSelect = selectModule.exports.AcademicDepartmentSelect
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]

test('every existing KNU faculty has a sourced dropdown; the university boundary is retained', () => {
  const facultySlugs = ['geography', 'economics', 'history', 'mechanics-mathematics', 'information-technology', 'computer-science-cybernetics', 'psychology', 'radio-physics-electronics', 'sociology', 'physics', 'philosophy', 'chemistry']
  for (const slug of facultySlugs) {
    const scope = catalogue.units.find(unit => unit.unit_slug === slug)
    const options = academicDepartmentsForScope('knu', slug)
    assert.ok(options.length > 0, slug)
    assert.equal(options.length, academicDepartmentsForScope('knu', scope.unit_name).length)
    assert.ok(options.every(option => option.source_url === scope.source_url))
    assert.equal(academicDepartmentsForScope('different-university', slug).length, 0)
  }
  assert.equal(academicDepartmentsForScope('knu', "Факультет комп'ютерних наук та кібернетики").length, 9)
  assert.equal(academicDepartmentsForScope('knu', 'неіснуючий факультет').length, 0)
})

test('catalogue contains only scoped official department names and preserves economics stable slugs', () => {
  assert.equal(catalogue.units.length, 22)
  assert.equal(catalogue.units.reduce((sum, unit) => sum + unit.departments.length, 0), 213)
  for (const unit of catalogue.units) {
    assert.equal(new URL(unit.source_url).hostname.endsWith('knu.ua'), true)
    assert.equal(new Set(unit.departments.map(department => department.slug)).size, unit.departments.length)
    assert.equal(new Set(unit.departments.map(department => department.name)).size, unit.departments.length)
    assert.ok(unit.departments.every(department => /^[a-z0-9-]+$/.test(department.slug) && department.name.length >= 2 && department.name.length <= 180))
  }
  const economics = academicDepartmentsForScope('knu', 'economics')
  assert.equal(economics.find(item => item.name === 'Кафедра фінансів').slug, 'finance')
  assert.equal(academicDepartmentMatches('Кафедра аналітичної хімії', economics), false)
  assert.equal(academicDepartmentMatches('Кафедра аналітичної хімії', academicDepartmentsForScope('knu', 'chemistry')), true)
  assert.equal(academicDepartmentsForScope('knu', 'continuing-education').length, 0)
  assert.equal(catalogue.unlisted_units[0].unit_slug, 'continuing-education')
})

test('the server seed is exactly the same catalogue as the signup dropdown, without rewriting teacher records or grants', () => {
  const seeded = JSON.parse(migration.match(/\$departments\$([\s\S]*?)\$departments\$/)[1])
  const expected = catalogue.units.flatMap(unit => unit.departments.map(department => [unit.unit_slug, department.slug, department.name, unit.source_url]))
  assert.deepEqual(seeded, expected)
  assert.ok(migration.includes(catalogue.verified_on))
  assert.doesNotMatch(migration, /(?:update|delete\s+from)\s+public\.(?:profiles|teacher_academic_profiles|teacher_verification_requests)/i)
  assert.doesNotMatch(migration, /\bgrant\b/i)
})

test('every scoped department is directly available in one native dropdown with no search field', () => {
  for (const unit of catalogue.units) {
    const options = academicDepartmentsForScope('knu', unit.unit_slug)
    let selected = null
    const tree = DepartmentSelect({ id: 'department', name: 'teacher-department', value: '', options, required: true, onChange: value => { selected = value } })
    const rendered = nodes(tree), select = rendered.find(node => node.type === 'select')
    assert.ok(select, unit.unit_slug)
    assert.equal(rendered.filter(node => node.type === 'input').length, 0, 'No search or extra text input for a sourced catalogue')
    assert.equal(select.props.id, 'department'); assert.equal(select.props.name, 'teacher-department'); assert.equal(select.props.required, true)
    assert.deepEqual(nodes(select).filter(node => node.type === 'option').map(node => node.props.value), ['', ...options.map(option => option.name)])
    for (const option of options) { select.props.onChange({ target: { value: option.name } }); assert.equal(selected, option.name) }
    assert.equal(rendered.find(node => node.type === 'a').props.href, unit.source_url)
  }
})

test('saved legacy departments remain selectable without hiding or duplicating official options', () => {
  const options = academicDepartmentsForScope('knu', 'economics'), value = 'Попередня збережена кафедра'
  const legacy = nodes(DepartmentSelect({ id: 'department', value, options, disabled: true, invalid: true, onChange() {} }))
  const select = legacy.find(node => node.type === 'select'), choices = nodes(select).filter(node => node.type === 'option')
  assert.equal(select.props.value, value); assert.equal(select.props.disabled, true); assert.equal(select.props['aria-invalid'], true)
  assert.equal(choices.length, options.length + 2)
  assert.equal(choices.find(node => node.props.value === value).props.children.join(''), 'Збережена кафедра: ' + value)
  assert.deepEqual(choices.slice(2).map(node => node.props.value), options.map(option => option.name))
  const known = nodes(DepartmentSelect({ id: 'department', value: options[0].name, options, onChange() {} })).filter(node => node.type === 'option')
  assert.equal(known.length, options.length + 1)
  assert.equal(known.filter(node => node.props.value === options[0].name).length, 1)
})

test('an institute without a published catalogue keeps bounded manual entry and a clear explanation', () => {
  let selected = ''
  const tree = DepartmentSelect({ id: 'ipo-department', name: 'department', value: 'Збережена назва', options: academicDepartmentsForScope('knu', 'continuing-education'), required: true, onChange: value => { selected = value } })
  const rendered = nodes(tree), input = rendered.find(node => node.type === 'input')
  assert.ok(input); assert.equal(input.props.type, undefined); assert.equal(input.props.maxLength, 180); assert.equal(input.props.required, true)
  assert.equal(input.props.value, 'Збережена назва'); assert.equal(rendered.some(node => node.type === 'select'), false)
  input.props.onChange({ target: { value: 'Повна офіційна назва кафедри' } }); assert.equal(selected, 'Повна офіційна назва кафедри')
  assert.ok(rendered.some(node => node.type === 'p' && /немає підтвердженого довідника/.test(node.props.children)))
})
