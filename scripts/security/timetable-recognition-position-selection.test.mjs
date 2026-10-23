import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as crypto from 'node:crypto'
import ts from 'typescript'

// All authentication, quota and provider responses are isolated fixtures.
// This suite cannot read credentials, contact a provider or save group data.
const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, Buffer, AbortSignal, TextEncoder, ...globals,
    require: name => { if (!(name in imports)) throw Error(`Unexpected import ${name}`); return imports[name] } })
  return module.exports
}
const sourceContract = load(await read('src/lib/timetableRecognitionSources.ts'))
const shared = load(await read('src/lib/timetableRecognition.ts'), { './timetableRecognitionSources.js': sourceContract })
const serverSource = await read('server/timetableRecognition.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const groupId = '11111111-1111-4111-8111-111111111111'
const otherGroupId = '22222222-2222-4222-8222-222222222222'
const image = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')}`
const region = (index, source_index = 1, count = 2) => ({ source_index, group_column_index: index, group_column_count: count })
const candidate = (id, index, regions = [region(index)]) => ({ id, group_name: '', study_year: null, study_level: null, program: '',
  section_label: index === 1 ? 'Ліва група всередині кожного дня' : 'Права група всередині кожного дня', source_regions: regions })
const analysis = candidates => ({ version: 2, kind: 'source_analysis', layout: candidates.length === 1 ? 'single' : 'multiple', candidates, warnings: [], clarifications: [] })
const identity = ({ source_regions: _regions, ...value }) => value
const target = { group_name: '', study_year: null, study_level: null, program: '' }
const source = (index, name = 'Два стовпці груп') => ({ kind: 'image', name, image_data_url: image, week_hint: 'auto',
  layout_hint: { group_columns: 'split', group_column_count: 2, group_column_index: index, week_rows: 'upper_lower', notes: '' } })
const request = (sources, extra = {}) => ({ headers: { authorization: 'Bearer fixture-user-token' }, body: {
  action: 'analyze', group_id: groupId, sources, target, ...extra,
} })

function fixture(providerResults) {
  const state = { userId: 'fixture-user', now: 1800000000000, providers: [], reservations: [] }
  class Clock extends Date { static now() { return state.now } }
  const createClient = () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) },
    rpc: async (name, args) => {
      if (name === 'xelay_study_group_permissions') return { data: ['schedule'], error: null }
      if (name === 'xelay_reserve_timetable_recognition') { state.reservations.push(plain(args)); return { data: true, error: null } }
      throw Error(`Unexpected fixture RPC ${name}`)
    },
  })
  const fetch = async (_url, options) => {
    state.providers.push(JSON.parse(options.body))
    const result = providerResults.shift()
    assert.ok(result, 'Unexpected provider request')
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }), { status: 200 })
  }
  const api = load(serverSource, {
    '@supabase/supabase-js': { createClient }, 'node:crypto': crypto,
    '../src/lib/timetableRecognition.js': shared, '../src/lib/timetableRecognitionSources.js': sourceContract,
  }, { Date: Clock, fetch, process: { env: {
    SUPABASE_URL: 'https://fixture.example', SUPABASE_SERVICE_ROLE_KEY: 'fixture-signing-key', SUPABASE_ANON_KEY: 'fixture-caller-key',
    TIMETABLE_RECOGNITION_ENABLED: 'true', OPENAI_API_KEY: 'fixture-provider-key',
  } } })
  return { state, api }
}
const signedRegions = response => JSON.parse(Buffer.from(response.analysis_token.split('.')[0], 'base64url').toString()).c

test('both legitimate model candidates preserve only the chosen left or right group and its original id', async () => {
  const left = candidate('c1', 1), right = candidate('c2', 2)
  for (const chosen of [1, 2]) {
    const fx = fixture([analysis([left, right])])
    const result = await fx.api.recognizeTimetable(request([source(chosen)]))
    const expected = chosen === 1 ? left : right
    assert.equal(result.layout, 'single')
    assert.deepEqual(plain(result.candidates), [identity(expected)])
    assert.equal(signedRegions(result).length, 1)
    assert.equal(signedRegions(result)[0][0], expected.id)
    assert.deepEqual(signedRegions(result)[0][2], [[1, chosen, 2]])
    assert.match(result.warnings.join(' '), /сусідніх стовпців/)
  }
})

test('a valid but differently counted neighbouring region is excluded rather than rewritten', async () => {
  const chosen = candidate('c1', 1)
  const differentCount = candidate('c2', 2, [region(2, 1, 3)])
  const fx = fixture([analysis([chosen, differentCount])])
  const result = await fx.api.recognizeTimetable(request([source(1)]))
  assert.deepEqual(plain(result.candidates), [identity(chosen)])
  assert.deepEqual(signedRegions(result)[0][2], [[1, 1, 2]])
})

test('no eligible position or count returns an actionable clarification without a selectable candidate', async () => {
  for (const rejected of [candidate('c2', 2), candidate('c1', 1, [region(1, 1, 3)])]) {
    const fx = fixture([analysis([rejected])])
    const result = await fx.api.recognizeTimetable(request([source(1)]))
    assert.equal(result.layout, 'unreadable')
    assert.deepEqual(plain(result.candidates), [])
    assert.equal(result.clarifications[0].kind, 'group_columns')
    assert.equal(result.clarifications[0].source_index, 1)
    assert.match(result.clarifications[0].question, /не підтверджено вибраний стовпець/)
    assert.deepEqual(signedRegions(result), [])
  }
})

test('per-source chosen positions may differ while one candidate keeps both original regions', async () => {
  const chosen = candidate('c4', 1, [region(1, 1), region(2, 2)])
  const neighbour = candidate('c7', 2, [region(2, 1), region(1, 2)])
  const fx = fixture([analysis([neighbour, chosen])])
  const result = await fx.api.recognizeTimetable(request([source(1, 'Фото 1'), source(2, 'Фото 2')]))
  assert.deepEqual(plain(result.candidates), [identity(chosen)])
  assert.equal(signedRegions(result)[0][0], 'c4')
  assert.deepEqual(signedRegions(result)[0][2], [[1, 1, 2], [2, 2, 2]])
})

test('malformed neighbouring metadata still rejects even when a valid chosen candidate was seen first', async () => {
  for (const malformed of [
    [{ source_index: 99, group_column_index: 2, group_column_count: 2 }],
    [{ source_index: 1, group_column_index: 2, group_column_count: 0 }],
    [{ source_index: 1, group_column_index: null, group_column_count: 2 }],
    [region(2), region(2)],
    [],
  ]) {
    const fx = fixture([analysis([candidate('c1', 1), candidate('c2', 2, malformed)])])
    await assert.rejects(fx.api.recognizeTimetable(request([source(1)])), error => error.status === 422)
  }
})

test('neighbour, changed position, package, user, group and expired token replays fail before another reservation or provider call', async () => {
  const left = candidate('c1', 1), right = candidate('c2', 2)
  for (const change of [
    (req) => { req.body.source_selection = identity(right) },
    (req) => { req.body.sources[0].layout_hint.group_column_index = 2 },
    (req) => { req.body.sources[0].name = 'Змінене джерело' },
    (_req, state) => { state.userId = 'other-fixture-user' },
    (req) => { req.body.group_id = otherGroupId },
    (_req, state) => { state.now += 16 * 60 * 1000 },
  ]) {
    const fx = fixture([analysis([left, right])])
    const result = await fx.api.recognizeTimetable(request([source(1)]))
    const req = request([source(1)], { action: 'extract', source_selection: identity(left), analysis_token: result.analysis_token })
    change(req, fx.state)
    await assert.rejects(fx.api.recognizeTimetable(req), error => error.status === 409)
    assert.equal(fx.state.providers.length, 1)
    assert.equal(fx.state.reservations.length, 1)
  }
})

test('extraction still rejects neighbouring lesson evidence after a valid selected analysis', async () => {
  const left = candidate('c1', 1), right = candidate('c2', 2)
  const extracted = {
    version: 1, source_match: { status: 'matched', ...identity(left), id: undefined }, week_mode: 'every', days: [1],
    slots: [{ number: 1, starts_at: '08:00', ends_at: '09:20' }],
    lessons: [{ weekday: 1, lesson_number: 1, week_pattern: 'every', subject: 'Вища математика', lesson_type: 'lecture',
      location: '', online_url: '', online_url_secondary: '', date_note: '', needs_review: false, review_note: '',
      source_evidence: [{ source_index: 1, group_column_index: 2, week_pattern: 'every', week_basis: 'undivided', week_row: 'whole' }],
    }], warnings: [], clarifications: [],
  }
  const fx = fixture([analysis([left, right]), extracted])
  const result = await fx.api.recognizeTimetable(request([source(1)]))
  await assert.rejects(fx.api.recognizeTimetable(request([source(1)], { action: 'extract', source_selection: identity(left), analysis_token: result.analysis_token })),
    error => error.status === 422 && error.clarifications.some(question => question.kind === 'group_columns' && /за межі обраного/.test(question.question)))
})
