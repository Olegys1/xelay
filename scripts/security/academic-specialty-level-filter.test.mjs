import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/lib/academicSpecialties.ts', root), 'utf8')
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const compatibility = {}
vm.runInNewContext(compile(await readFile(new URL('src/lib/databaseCompatibility.ts', root), 'utf8')), { exports: compatibility })
const row = (id, name, study_levels, extra = {}) => ({ id, name, study_levels, university_id: 'knu', academic_unit_id: 'economics', code: 'D3', specialty_name: 'Менеджмент', is_active: true, source_url: null, ...extra })
const catalog = [row('consulting', 'Бізнес-консалтинг', ['master']), row('innovation', 'Менеджмент інноваційної діяльності', ['master']), row('organization', 'Менеджмент організацій', ['bachelor', 'master']), row('enterprise', 'Менеджмент підприємницької діяльності', ['bachelor', 'master'])]
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function fixture({ manual = false, responses = [] } = {}) {
  const slots = [], effects = [], calls = [], pending = []
  let cursor = 0, dirty = false, props = ['knu', 'economics', {}, 'bachelor'], current
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; dirty = true }] },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial } },
    useCallback(callback) { return callback },
    useEffect(callback, deps) { const index = cursor++; const old = slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) { slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback() }) } },
  }
  const supabase = { from(table) {
    assert.equal(table, 'academic_specialties')
    const call = { columns: '', filters: {}, signal: null }
    const query = {
      select(columns) { call.columns = columns; return query },
      eq(key, value) { call.filters[key] = value; return query },
      order() { return query }, abortSignal(signal) { call.signal = signal; return query }, returns() { return query },
      then(resolve, reject) {
        calls.push(call)
        if (manual) return new Promise(finish => pending.push(finish)).then(resolve, reject)
        return Promise.resolve(responses.shift() || { data: catalog, error: null }).then(resolve, reject)
      },
    }
    return query
  } }
  const api = {}
  vm.runInNewContext(compile(source), { exports: api, AbortController, window: { setTimeout, clearTimeout }, require(name) {
    if (name === 'react') return react
    if (name === './supabase') return { supabase }
    if (name === './databaseCompatibility') return compatibility
    throw Error(`Unexpected import ${name}`)
  } })
  const render = (next = props) => {
    props = next
    let attempts = 0
    do {
      dirty = false; cursor = 0; current = api.useAcademicSpecialties(...props)
      effects.splice(0).forEach(effect => effect())
      assert.ok(++attempts < 12, 'hook must settle')
    } while (dirty)
    return current
  }
  return { api, calls, pending, render, async settle() { await tick(); return render() }, close() { for (const slot of slots) slot?.cleanup?.() } }
}

test('verified economics bachelor management offers exactly organization and enterprise; masters retain all four', () => {
  const fx = fixture()
  assert.deepEqual(Array.from(fx.api.academicSpecialtiesForStatus(catalog, 'bachelor'), item => item.id), ['organization', 'enterprise'])
  assert.equal(fx.api.academicSpecialtiesForStatus(catalog, 'master').length, 4)
  assert.equal(fx.api.academicSpecialtyLevelLabel(catalog[1]), 'Магістратура')
  assert.equal(fx.api.academicSpecialtyLevelLabel(catalog[2]), 'Бакалаврат / Магістратура')
})

test('unclassified programs and graduate, postgraduate or legacy statuses are never guessed away', () => {
  const fx = fixture(), unknown = [row('empty', 'Unknown', []), row('legacy', 'Legacy')]
  assert.equal(fx.api.academicSpecialtiesForStatus([...catalog, ...unknown], 'bachelor').length, 4)
  for (const status of ['', 'graduate', 'postgraduate', 'Student / Fresh Graduate']) assert.equal(fx.api.academicSpecialtiesForStatus(catalog, status).length, 4)
})

test('loader keeps active university/faculty scope even if a response contains unrelated or inactive rows', async () => {
  const fx = fixture({ responses: [{ data: [...catalog, row('other', 'Other', [], { academic_unit_id: 'other' }), row('inactive', 'Inactive', [], { is_active: false })], error: null }] })
  const loaded = await fx.api.loadAcademicSpecialties('knu', 'economics')
  assert.equal(loaded.length, 4)
  assert.match(fx.calls[0].columns, /study_levels/)
  assert.deepEqual(fx.calls[0].filters, { university_id: 'knu', academic_unit_id: 'economics', is_active: true })
})

test('rolling-schema fallback only occurs for a missing column, never permission/network failures', async () => {
  const old = fixture({ responses: [{ data: null, error: { code: '42703' } }, { data: catalog.map(({ study_levels, ...item }) => item), error: null }] })
  assert.equal((await old.api.loadAcademicSpecialties('knu', 'economics')).length, 4)
  assert.equal(old.calls.length, 2)
  assert.doesNotMatch(old.calls[1].columns, /study_levels/)
  for (const error of [{ code: '42501', message: 'denied' }, { message: 'network failed' }]) {
    const fx = fixture({ responses: [{ data: null, error }] })
    await assert.rejects(fx.api.loadAcademicSpecialties('knu', 'economics'), actual => actual === error)
    assert.equal(fx.calls.length, 1)
  }
})

test('a compatible existing ID resolves; an incompatible legacy program is never silently replaced', async () => {
  for (const [id, expected] of [['organization', 'organization'], ['innovation', '']]) {
    const fx = fixture()
    fx.render(['knu', 'economics', { id, name: catalog.find(row => row.id === id).name }, 'bachelor'])
    const result = await fx.settle()
    assert.equal(result.value, expected)
    assert.equal(result.options.length, 2)
    fx.close()
  }
})

test('status changes immediately hide the former selection and cannot restore it after a round trip', async () => {
  const fx = fixture()
  fx.render(['knu', 'economics', { id: 'innovation' }, 'master'])
  assert.equal((await fx.settle()).value, 'innovation')
  const pending = fx.render(['knu', 'economics', { id: 'innovation' }, 'bachelor'])
  assert.equal(pending.value, '')
  assert.equal(pending.options.length, 0)
  assert.equal(pending.loading, true)
  assert.equal((await fx.settle()).options.length, 2)
  fx.render(['knu', 'economics', { id: 'innovation' }, 'master'])
  assert.equal((await fx.settle()).value, '')
  fx.close()
})

test('late level/faculty responses cannot replace the current catalog; invalid IDs cannot be selected', async () => {
  const fx = fixture({ manual: true })
  fx.render(['knu', 'economics', {}, 'master']); await tick()
  fx.render(['knu', 'other', {}, 'bachelor']); await tick()
  const newer = [row('new', 'Other faculty', ['bachelor'], { academic_unit_id: 'other' })]
  fx.pending[1]({ data: newer, error: null })
  assert.equal((await fx.settle()).options[0].id, 'new')
  fx.pending[0]({ data: catalog, error: null })
  assert.equal((await fx.settle()).options[0].id, 'new')
  let result = fx.render(); result.choose('innovation')
  assert.equal(fx.render().value, '')
  result = fx.render(); result.choose('new')
  assert.equal(fx.render().value, 'new')
  fx.close()
})

test('clearing scope cancels pending work and cannot expose a previous program', async () => {
  const fx = fixture({ manual: true })
  fx.render(); await tick()
  let result = fx.render(['knu', '', {}, 'bachelor'])
  assert.equal(result.hasScope, false)
  assert.equal(result.value, '')
  fx.pending[0]({ data: catalog, error: null })
  result = await fx.settle()
  assert.equal(result.options.length, 0)
  assert.equal(fx.calls[0].signal.aborted, true)
  fx.close()
})
