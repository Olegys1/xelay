import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as crypto from 'node:crypto'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const sharedSource = await read('src/lib/timetableRecognition.ts')
const serverSource = await read('server/timetableRecognition.ts')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, Buffer, AbortSignal, ...globals,
    require: name => { if (!(name in imports)) throw Error(`Unexpected import ${name}`); return imports[name] } })
  return module.exports
}
const shared = load(sharedSource)
const plain = value => JSON.parse(JSON.stringify(value))
const clone = plain
const groupId = '11111111-1111-4111-8111-111111111111'
const otherGroupId = '22222222-2222-4222-8222-222222222222'
const image = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')}`
const otherImage = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 5]).toString('base64')}`
const selection = { id: 'c1', group_name: 'ЕУБ-4', study_year: 1, study_level: 'bachelor', program: 'Економіка', section_label: '' }
const secondSelection = { id: 'c2', group_name: 'ЕУБ-4', study_year: 2, study_level: 'bachelor', program: 'Економіка', section_label: '' }
const analysis = { version: 2, kind: 'source_analysis', layout: 'multiple', candidates: [selection, secondSelection], warnings: [] }
const result = {
  version: 1, source_match: { status: 'matched', ...selection, id: undefined }, week_mode: 'every', days: [1, 2],
  slots: [{ number: 1, starts_at: '08:00', ends_at: '09:20' }, { number: 2, starts_at: '09:40', ends_at: '11:00' }],
  lessons: [{ weekday: 1, lesson_number: 1, week_pattern: 'every', subject: 'Економічна теорія', lesson_type: 'lecture', location: '101', online_url: '', online_url_secondary: '', date_note: '', needs_review: false, review_note: '' }], warnings: [],
}
const request = (action, extra = {}) => ({ headers: { authorization: 'Bearer valid-user-token' }, body: { action, group_id: groupId, image_data_url: image, ...extra } })

function fixture(providerResults = [], model) {
  const state = { userId: 'user-a', now: 1800000000000, permissions: ['schedule'], reserveError: null, calls: [], provider: [] }
  class Clock extends Date { static now() { return state.now } }
  const createClient = (_url, key, options) => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) },
    rpc: async (name, args) => {
      state.calls.push({ name, args: plain(args), identity: options.global.headers?.Authorization || key })
      if (name === 'xelay_study_group_permissions') return { data: state.permissions, error: null }
      if (name === 'xelay_reserve_timetable_recognition') return { data: state.reserveError ? null : true, error: state.reserveError }
      throw Error('Unexpected RPC')
    },
  })
  const fetch = async (url, options) => {
    state.provider.push({ url, options, body: JSON.parse(options.body) })
    const next = providerResults.shift()
    if (next instanceof Error) throw next
    if (next instanceof Response) return next
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(next) }] }] }), { status: 200 })
  }
  const api = load(serverSource, { '@supabase/supabase-js': { createClient }, 'node:crypto': crypto, '../src/lib/timetableRecognition.js': shared }, {
    Date: Clock, fetch, process: { env: { SUPABASE_URL: 'https://database.example', SUPABASE_SERVICE_ROLE_KEY: 'server-only-signing-key-for-test', SUPABASE_ANON_KEY: 'caller-key', TIMETABLE_RECOGNITION_ENABLED: 'true', OPENAI_API_KEY: 'provider-key', ...(model ? { TIMETABLE_RECOGNITION_MODEL: model } : {}) } },
  })
  return { api, state }
}
const reservations = state => state.calls.filter(call => call.name === 'xelay_reserve_timetable_recognition')
async function analyzed(fx, source = analysis) {
  const response = await fx.api.recognizeTimetable(request('analyze'))
  return { response, extract: request('extract', { source_selection: source.candidates[0], analysis_token: response.analysis_token }) }
}

test('analysis keeps same-named groups in distinct courses and requires signed public output', () => {
  assert.throws(() => shared.normalizeTimetableSourceAnalysis(analysis), /INVALID_RESULT/)
  const value = shared.normalizeTimetableSourceAnalysis(analysis, false)
  assert.deepEqual(plain(value.candidates), [selection, secondSelection])
  assert.equal(value.analysis_token, '')
})

test('analysis rejects duplicate ids, indistinguishable candidates, phantom selections and unlabelled multi-group grids', () => {
  for (const mutation of [
    source => source.candidates[1].id = 'c1',
    source => source.candidates[1] = { ...source.candidates[0], id: 'c2' },
    source => source.candidates[0].id = 'c65',
    source => source.candidates[0].study_year = 0,
    source => source.candidates[0].study_year = '1',
    source => source.candidates[0] = { id: 'single', group_name: '', study_year: null, study_level: null, program: '', section_label: '' },
    source => source.candidates[0] = { id: 'c1', group_name: '', study_year: null, study_level: null, program: '', section_label: '' },
    source => source.layout = 'single',
  ]) {
    const source = clone(analysis); mutation(source)
    assert.throws(() => shared.normalizeTimetableSourceAnalysis(source, false), /INVALID_RESULT/)
  }
})

test('analysis allows one explicit unlabelled timetable and unreadable result with a clear notice', () => {
  const unlabelled = { version: 2, kind: 'source_analysis', layout: 'single', candidates: [{ id: 'single', group_name: '', study_year: null, study_level: null, program: '', section_label: '' }], warnings: ['Перевірте групу.'] }
  assert.equal(shared.normalizeTimetableSourceAnalysis(unlabelled, false).candidates[0].id, 'single')
  const unreadable = { ...unlabelled, layout: 'unreadable', candidates: [] }
  assert.equal(shared.normalizeTimetableSourceAnalysis(unreadable, false).layout, 'unreadable')
  assert.throws(() => shared.normalizeTimetableSourceAnalysis({ ...unreadable, warnings: [] }, false), /INVALID_RESULT/)
})

test('analysis bounds 64 candidates and all identity fields', () => {
  const max = { ...analysis, candidates: Array.from({ length: 64 }, (_, i) => ({ ...selection, id: `c${i + 1}`, group_name: `ЕУБ-${i + 1}` })) }
  assert.equal(shared.normalizeTimetableSourceAnalysis(max, false).candidates.length, 64)
  assert.throws(() => shared.normalizeTimetableSourceAnalysis({ ...max, candidates: [...max.candidates, selection] }, false), /INVALID_RESULT/)
  for (const [field, value] of [['group_name', 'x'.repeat(101)], ['program', 'x'.repeat(161)], ['section_label', 'x'.repeat(201)], ['study_year', 7]]) {
    assert.throws(() => shared.normalizeTimetableSourceSelection({ ...selection, [field]: value }), /INVALID_RESULT/)
  }
})

test('extraction preserves a selected group and conservatively checks course/program/section identity', () => {
  const parsed = shared.normalizeTimetableRecognition(result)
  assert.equal(shared.timetableSourceMatchesSelection(selection, parsed.source_match), true)
  assert.equal(shared.timetableSourceMatchesSelection(selection, { ...parsed.source_match, group_name: ' еуб–4 ' }), true)
  for (const change of [{ study_year: 2 }, { study_level: 'master' }, { group_name: 'ЕУБ-3' }, { program: 'Менеджмент' }, { section_label: 'Інший розділ' }, { status: 'single_unlabelled' }]) {
    assert.equal(shared.timetableSourceMatchesSelection(selection, { ...parsed.source_match, ...change }), false)
  }
})

test('uncertain types, missing times, empty subjects and review notes always require review', () => {
  const source = clone(result)
  source.slots[0].starts_at = ''
  source.lessons[0].subject = ''
  source.lessons[0].lesson_type = 'other'
  const lesson = shared.normalizeTimetableRecognition(source).lessons[0]
  assert.equal(lesson.needs_review, true)
  assert.match(lesson.review_note, /час/)
  const noted = clone(result); noted.lessons[0].review_note = 'Перевірте аудиторію.'
  assert.equal(shared.normalizeTimetableRecognition(noted).lessons[0].needs_review, true)
  const dated = clone(result); dated.lessons[0].date_note = 'початок з 01.10.2026 (9 пар)'
  const datedLesson = shared.normalizeTimetableRecognition(dated).lessons[0]
  assert.equal(datedLesson.date_note, 'початок з 01.10.2026 (9 пар)')
  assert.equal(datedLesson.needs_review, true)
  assert.match(datedLesson.review_note, /дати дії/)
})

test('review notes remain identical after repeated server and client normalization', () => {
  for (const change of [
    source => source.slots[0].ends_at = '',
    source => source.lessons[0].date_note = 'початок з 01.10.2026 (9 пар)',
    source => source.lessons[0].lesson_type = 'other',
    source => { source.slots[0].ends_at = ''; source.lessons[0].date_note = 'до 01.11.2026'; source.lessons[0].lesson_type = 'other'; source.lessons[0].subject = '' },
    source => { source.lessons[0].date_note = 'до 01.11.2026'; source.lessons[0].review_note = 'Наявна примітка. '.repeat(14) },
  ]) {
    const sample = clone(result); change(sample)
    const once = shared.normalizeTimetableRecognition(sample)
    const twice = shared.normalizeTimetableRecognition(once)
    const thrice = shared.normalizeTimetableRecognition(twice)
    assert.equal(twice.lessons[0].review_note, once.lessons[0].review_note)
    assert.equal(thrice.lessons[0].review_note, once.lessons[0].review_note)
    assert.deepEqual(plain(twice), plain(once))
  }
})

test('conflicting subgroup cells, overlapping pair clocks and invalid weeks are rejected without collapse', () => {
  for (const mutation of [
    source => source.lessons.push({ ...source.lessons[0], subject: 'Інша підгрупа' }),
    source => source.slots[1].starts_at = '09:00',
    source => source.slots[1].starts_at = '07:00',
    source => { source.slots[1].starts_at = ''; source.slots[1].ends_at = '09:00' },
    source => source.lessons[0].week_pattern = 'upper',
    source => source.lessons[0].online_url = 'javascript:alert(1)',
    source => delete source.source_match,
    source => source.source_match.status = 'ambiguous',
  ]) {
    const source = clone(result); mutation(source)
    assert.throws(() => shared.normalizeTimetableRecognition(source), /INVALID_RESULT/)
  }
})

test('validator returns predefined non-sensitive codes and normalizes unambiguous single-digit hours', () => {
  const sample = clone(result); sample.slots[0].starts_at = '8:00'; sample.slots[0].ends_at = '9:20'
  assert.equal(shared.normalizeTimetableRecognition(sample).slots[0].starts_at, '08:00')
  const cases = [
    ['TIME_FORMAT', source => source.slots[0].starts_at = 'bad'],
    ['SLOT_TIME_ORDER', source => source.slots[1].starts_at = '08:30'],
    ['DUPLICATE_SLOT', source => source.slots.push({ ...source.slots[0] })],
    ['CELL_CONFLICT', source => source.lessons.push({ ...source.lessons[0] })],
    ['LESSON_GRID', source => source.lessons[0].lesson_number = 9],
    ['REVIEW_NOTE', source => source.lessons[0].review_note = 'PRIVATE-'.repeat(100)],
    ['SOURCE_LEVEL', source => delete source.source_match.study_level],
  ]
  for (const [expected, mutate] of cases) {
    const bad = clone(result); mutate(bad)
    try { shared.normalizeTimetableRecognition(bad); assert.fail('must reject') }
    catch (error) { assert.equal(shared.timetableRecognitionValidationCode(error), expected); assert.ok(!error.message.includes('PRIVATE-')) }
  }
  assert.equal(shared.timetableRecognitionValidationCode(new Error('PRIVATE-source-data')), 'INVALID')
  assert.equal(shared.timetableRecognitionValidationCode({ validationCode: 'PRIVATE-source-data' }), 'INVALID')
})

test('analyze then extract sends identical image, caller auth and two bounded paid requests with no storage', async () => {
  const fx = fixture([analysis, result])
  const { response, extract } = await analyzed(fx)
  assert.match(response.analysis_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  assert.equal(shared.normalizeTimetableSourceAnalysis(response).candidates.length, 2)
  const imported = await fx.api.recognizeTimetable(extract)
  assert.equal(imported.source_match.study_year, 1)
  assert.equal(reservations(fx.state).length, 2)
  assert.deepEqual(fx.state.calls.filter(call => call.name === 'xelay_study_group_permissions').map(call => call.identity), ['Bearer valid-user-token', 'Bearer valid-user-token'])
  assert.equal(fx.state.provider.length, 2)
  for (const [index, { body }] of fx.state.provider.entries()) {
    assert.equal(body.store, false); assert.equal(body.model, index === 0 ? 'gpt-5.4-mini' : 'gpt-5.4')
    assert.deepEqual(body.reasoning, { effort: 'low' })
    assert.equal(body.text.format.strict, true)
    assert.equal(body.input[0].content[1].image_url, image)
    assert.equal(body.input[0].content[1].detail, 'original')
    assert.match(body.instructions, /untrusted|UNTRUSTED/)
  }
  assert.match(fx.state.provider[0].body.instructions, /64/)
  assert.match(fx.state.provider[0].body.instructions, /column letters\/ranges/)
  assert.match(fx.state.provider[1].body.instructions, /follow the SAME column boundaries/)
  assert.match(fx.state.provider[1].body.instructions, /next pair's start is visible, it is NOT the previous pair's end/)
  assert.match(fx.state.provider[1].body.instructions, /день самостійної роботи/)
  assert.match(fx.state.provider[1].body.instructions, /never create separate lessons named/)
  assert.match(fx.state.provider[1].body.instructions, /Never guess standard university times/)
})

test('handler and provider deadlines allow bounded reasoning without increasing request quotas', async () => {
  const handler = await read('api/groups/recognize-timetable.ts')
  assert.match(handler, /maxDuration:\s*120/)
  assert.match(serverSource, /Math\.min\(105000, 112000 - \(Date\.now\(\) - startedAt\)\)/)
  assert.match(serverSource, /xelay_reserve_timetable_recognition/)
})

test('explicit legacy models retain supported high detail and receive no reasoning setting', async () => {
  for (const model of ['gpt-4.1-mini', 'gpt-4.1']) {
    const fx = fixture([analysis], model)
    await analyzed(fx)
    const body = fx.state.provider[0].body
    assert.equal(body.model, model)
    assert.equal(body.input[0].content[1].detail, 'high')
    assert.equal(body.reasoning, undefined)
  }
})

test('one explicit model override still applies to both analysis and extraction', async () => {
  for (const model of ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4.1-mini']) {
    const fx = fixture([analysis, result], model)
    const { extract } = await analyzed(fx)
    await fx.api.recognizeTimetable(extract)
    for (const { body } of fx.state.provider) {
      assert.equal(body.model, model)
      assert.equal(body.input[0].content[1].detail, model === 'gpt-4.1-mini' ? 'high' : 'original')
      assert.deepEqual(body.reasoning, model === 'gpt-4.1-mini' ? undefined : { effort: 'low' })
    }
  }
})

test('a missing printed pair end remains empty rather than copying the next pair start', () => {
  const source = clone(result)
  source.slots[1].ends_at = ''
  source.slots.push({ number: 3, starts_at: '11:20', ends_at: '12:40' })
  source.lessons[0].lesson_number = 2
  const parsed = shared.normalizeTimetableRecognition(source)
  assert.equal(parsed.slots[1].ends_at, '')
  assert.equal(parsed.lessons[0].needs_review, true)
  assert.match(parsed.lessons[0].review_note, /час/)
})

test('legacy requests, missing source selection and invalid images never reach paid inference', async () => {
  const fx = fixture([])
  for (const req of [request(undefined), request('extract'), request('analyze', { image_data_url: 'data:image/png;base64,YWJjZA==' }), request('analyze', { source_selection: selection })]) {
    await assert.rejects(fx.api.recognizeTimetable(req), error => error.status === 400)
  }
  assert.equal(fx.state.provider.length, 0)
  assert.equal(reservations(fx.state).length, 0)
})

test('authorization and quota are enforced before every paid inference', async () => {
  const fx = fixture([analysis]); fx.state.permissions = []
  await assert.rejects(fx.api.recognizeTimetable(request('analyze')), error => error.status === 403)
  assert.equal(reservations(fx.state).length, 0)
  fx.state.permissions = ['schedule']; fx.state.reserveError = { message: 'TIMETABLE_RECOGNITION_ACTOR_LIMIT' }
  await assert.rejects(fx.api.recognizeTimetable(request('analyze')), error => error.status === 429)
  assert.equal(fx.state.provider.length, 0)
})

test('signed analysis cannot be replayed with a different image, destination, candidate descriptor or user', async () => {
  const fx = fixture([analysis])
  const { extract } = await analyzed(fx)
  for (const change of [
    { image_data_url: otherImage }, { group_id: otherGroupId },
    { source_selection: { ...selection, study_year: 2 } },
    { source_selection: { ...selection, study_level: 'master' } },
    { source_selection: { ...selection, program: 'Менеджмент' } },
    { source_selection: { ...selection, id: 'c3' } },
    { analysis_token: `${extract.body.analysis_token.slice(0, -1)}!` },
  ]) {
    await assert.rejects(fx.api.recognizeTimetable({ ...extract, body: { ...extract.body, ...change } }), error => error.status === 400 || error.status === 409)
  }
  fx.state.userId = 'user-b'
  await assert.rejects(fx.api.recognizeTimetable(extract), error => error.status === 409)
  assert.equal(fx.state.provider.length, 1)
  assert.equal(reservations(fx.state).length, 1)
})

test('expired and signature-tampered analysis fail before consuming extraction quota', async () => {
  const fx = fixture([analysis])
  const { extract } = await analyzed(fx)
  const split = extract.body.analysis_token.indexOf('.')
  const tampered = `${extract.body.analysis_token.slice(0, split + 1)}${'a'.repeat(43)}`
  await assert.rejects(fx.api.recognizeTimetable({ ...extract, body: { ...extract.body, analysis_token: tampered } }), error => error.status === 409)
  fx.state.now += 15 * 60 * 1000
  await assert.rejects(fx.api.recognizeTimetable(extract), error => error.status === 409)
  assert.equal(fx.state.provider.length, 1)
  assert.equal(reservations(fx.state).length, 1)
})

test('provider returning another course/program/group or ambiguity cannot return importable lessons', async () => {
  for (const change of [{ study_year: 2 }, { study_level: 'master' }, { program: 'Менеджмент' }, { group_name: 'ЕУБ-5' }, { status: 'not_found' }, { status: 'ambiguous' }]) {
    const incorrect = clone(result); Object.assign(incorrect.source_match, change)
    const fx = fixture([analysis, incorrect]); const { extract } = await analyzed(fx)
    await assert.rejects(fx.api.recognizeTimetable(extract), error => error.status === 422)
  }
})

test('unlabelled single schedule still requires explicit selection and always carries a manual identity warning', async () => {
  const single = { id: 'single', group_name: '', study_year: null, study_level: null, program: '', section_label: '' }
  const source = { ...analysis, layout: 'single', candidates: [single] }
  const unlabelled = clone(result); unlabelled.source_match = { ...single, status: 'single_unlabelled', id: undefined }
  const fx = fixture([source, unlabelled]); const { extract } = await analyzed(fx, source)
  const imported = await fx.api.recognizeTimetable(extract)
  assert.ok(imported.warnings.some(warning => warning.includes('група й курс')))
})

test('unreadable analysis cannot issue an extraction token for an invented candidate', async () => {
  const source = { ...analysis, layout: 'unreadable', candidates: [], warnings: ['Завантажте чіткіше фото.'] }
  const fx = fixture([source]); const { response } = await analyzed(fx)
  await assert.rejects(fx.api.recognizeTimetable(request('extract', { source_selection: selection, analysis_token: response.analysis_token })), error => error.status === 409)
  assert.equal(fx.state.provider.length, 1)
})

test('incomplete provider output, oversized provider body and overlapping inferred times fail closed', async () => {
  const cases = [
    new Response(JSON.stringify({ status: 'incomplete', output: [] }), { status: 200 }),
    new Response('x'.repeat(512 * 1024 + 1), { status: 200 }),
  ]
  for (const response of cases) {
    const fx = fixture([response])
    await assert.rejects(fx.api.recognizeTimetable(request('analyze')), error => error.status === 422)
  }
  const overlap = clone(result); overlap.slots[1].starts_at = '09:00'
  const fx = fixture([analysis, overlap]); const { extract } = await analyzed(fx)
  await assert.rejects(fx.api.recognizeTimetable(extract), error => error.status === 422 && error.message.endsWith('Код: SLOT_TIME_ORDER.'))
})

test('incomplete provider reasons expose only fixed allowlisted UI codes', async () => {
  for (const [reason, code] of [
    ['max_output_tokens', 'INCOMPLETE_MAX_OUTPUT_TOKENS'],
    ['content_filter', 'INCOMPLETE_CONTENT_FILTER'],
    ['PRIVATE-provider-text', 'INCOMPLETE_OTHER'],
    [undefined, 'INCOMPLETE_OTHER'],
  ]) {
    const response = new Response(JSON.stringify({ status: 'incomplete', incomplete_details: { reason }, output: [] }), { status: 200 })
    const fx = fixture([response])
    await assert.rejects(fx.api.recognizeTimetable(request('analyze')), error => {
      assert.equal(error.status, 422)
      assert.ok(error.message.endsWith(`Код: ${code}.`))
      assert.ok(!error.message.includes('PRIVATE-provider-text'))
      return true
    })
  }
})
