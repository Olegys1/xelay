import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function load(path, imports = {}) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} }
  runInNewContext(outputText, { module, exports: module.exports, AbortController, require: name => imports[name] })
  return module.exports
}

const parliament = load('src/lib/facultyParliament.ts')

test('only KNU economics has the legacy SPEF topic and other faculties get their own destinations', () => {
  const economics = { slug: 'economics', name: 'Економічний факультет' }
  assert.equal(parliament.SPEF_CATEGORY, 'IT')
  assert.equal(parliament.facultyParliament('knu', economics).kind, 'spef')
  assert.equal(parliament.facultyParliament('another-university', economics).kind, 'news')
  assert.equal(parliament.facultyParliament('knu', { slug: 'history', name: 'Історичний факультет' }).title, 'СПІФ')
  const council = parliament.facultyParliament('knu', { slug: 'international-relations', name: 'ННІМВ' })
  assert.equal(council.title, 'Рада студентів ННІМВ')
  assert.equal(council.kind, 'news')
  assert.equal(parliament.facultyParliament('knu', { slug: 'continuing-education', name: 'ІПО' }).title, 'Студентське самоврядування · ІПО')
})

test('faculty navigation is scoped to the current signed-in profile and drops superseded lookups', async () => {
  let auth = { isAuthenticated: true, isLoading: false, authUser: { id: 'student-a' }, xelayUser: { userId: 'student-a', universityId: 'university', academicUnitId: 'economics' } }
  let state = null, deps, cleanup
  const requests = []
  const supabase = { from(table) {
    assert.equal(table, 'academic_units')
    const filters = {}
    let signal
    return {
      select() { return this },
      eq(key, value) { filters[key] = value; return this },
      abortSignal(value) { signal = value; return this },
      maybeSingle() { return new Promise(resolve => requests.push({ filters, signal, resolve })) },
    }
  } }
  const { useFacultyParliament } = load('src/hooks/useFacultyParliament.ts', {
    react: {
      useState: () => [state, value => { state = value }],
      useEffect(effect, values) {
        if (values.every((value, index) => value === deps?.[index])) return
        cleanup?.()
        deps = values
        cleanup = effect()
      },
    },
    '../context/AuthContext': { useAuth: () => auth },
    '../lib/facultyParliament': parliament,
    '../lib/supabase': { supabase },
  })
  assert.equal(useFacultyParliament(false), null)
  assert.equal(requests.length, 0)
  assert.equal(useFacultyParliament(), null)
  assert.deepEqual(requests[0].filters, { id: 'economics', university_id: 'university', is_active: true, 'universities.is_active': true })
  requests[0].resolve({ data: { slug: 'economics', universities: { slug: 'knu' } } })
  await setImmediate()
  assert.equal(useFacultyParliament().kind, 'spef')

  auth = { ...auth, authUser: { id: 'student-b' } }
  assert.equal(useFacultyParliament(), null)
  auth.xelayUser = { userId: 'student-b', universityId: 'university', academicUnitId: 'history' }
  assert.equal(useFacultyParliament(), null)
  auth.xelayUser = { ...auth.xelayUser, academicUnitId: 'information-technology' }
  assert.equal(useFacultyParliament(), null)
  assert.ok(requests[1].signal.aborted)
  requests[2].resolve({ data: { slug: 'information-technology', universities: { slug: 'knu' } } })
  await setImmediate()
  requests[1].resolve({ data: { slug: 'history', universities: { slug: 'knu' } } })
  await setImmediate()
  assert.equal(useFacultyParliament().title, 'СП ФІТ')

  auth = { isAuthenticated: false, isLoading: false }
  assert.equal(useFacultyParliament(), null)
})
