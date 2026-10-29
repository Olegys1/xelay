import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import test from 'node:test'

function load(relative, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, console, Date, Map,
    require(name) { if (name === './supabase') return { supabase: { rpc() { throw new Error('NO_LIVE_BACKEND') } } }; if (name.endsWith('.json')) return JSON.parse(readFileSync(new URL(name, new URL(relative, import.meta.url)), 'utf8')); if (mocks[name]) return mocks[name]; throw new Error(`Unexpected module ${name}`) },
  })
  return module.exports
}
const catalog = load('../src/lib/academicDepartments.ts')
const academic = load('../src/lib/teacherAcademicProfile.ts')

test('the current faculty catalogue has twelve distinct sourced departments and stays within its university/faculty', () => {
  const options = catalog.academicDepartmentsForScope('knu', 'economics')
  assert.equal(options.length, 12)
  assert.equal(new Set(options.map(item => item.slug)).size, 12)
  assert.equal(new Set(options.map(item => item.name)).size, 12)
  assert.ok(options.every(item => item.source_url === 'https://econom.knu.ua/departments/'))
  assert.equal(catalog.academicDepartmentsForScope('other-university', 'economics').length, 0)
  assert.equal(catalog.academicDepartmentsForScope('knu', 'history').length, 10)
})
test('new teacher applications require a department from the available faculty catalogue', () => {
  assert.equal(catalog.academicDepartmentMatches(catalog.KNU_ECONOMICS_DEPARTMENTS[0].name, catalog.KNU_ECONOMICS_DEPARTMENTS), true)
  assert.equal(catalog.academicDepartmentMatches('Вигадана кафедра', catalog.KNU_ECONOMICS_DEPARTMENTS), false)
  assert.equal(catalog.academicDepartmentMatches('', catalog.KNU_ECONOMICS_DEPARTMENTS), false)
  assert.equal(catalog.academicDepartmentMatches('Повна назва кафедри іншого факультету', []), true)
})
test('department updates retain private contacts, visibility choices and the actor contract', async () => {
  const repository = academic.createLocalTeacherAcademicRepository('teacher-local', { department: catalog.KNU_ECONOMICS_DEPARTMENTS[0].name,
    department_options: catalog.KNU_ECONOMICS_DEPARTMENTS, contact_email: 'teacher@example.com', email_visible_public: false, email_visible_to_groups: true })
  const original = await repository.load()
  const saved = await repository.save({ ...original, department: catalog.KNU_ECONOMICS_DEPARTMENTS[1].name })
  assert.equal(saved.department, catalog.KNU_ECONOMICS_DEPARTMENTS[1].name)
  assert.equal(saved.contact_email, 'teacher@example.com')
  assert.equal(saved.email_visible_public, false)
  assert.equal(saved.email_visible_to_groups, true)
  const payload = academic.teacherAcademicProfilePayload(saved)
  assert.equal(payload.expected_user_id, 'teacher-local')
  assert.equal('department_options' in payload, false)
  assert.equal('country' in payload, false)
  await assert.rejects(repository.save({ ...saved, user_id: 'other-user' }), /FORBIDDEN/)
  await assert.rejects(repository.save({ ...saved, department: 'Вигадана кафедра' }), /TEACHER_DEPARTMENT_INVALID/)
})
