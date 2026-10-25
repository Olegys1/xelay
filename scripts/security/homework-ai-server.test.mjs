// Authorization and cost reservation tests use only synthetic clients and provider responses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = filename => readFile(new URL(`../../${filename}`, import.meta.url), 'utf8')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, Buffer, AbortSignal, TextEncoder, ...globals,
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; throw new Error(`Unexpected import: ${name}`) },
  })
  return module.exports
}
const core = load(await read('src/lib/homeworkAiDraft.ts'))
const serverSource = await read('server/homeworkAiDraft.ts')
const routeSource = await read('api/groups/recognize-timetable.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const GROUP = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const SOURCE = 'Вища математика. Тема: Похідні. На завтра розв’язати вправи 1–5. Матеріали: https://example.org/lesson'
const INPUT = { source_text: SOURCE, reference_date: '2026-10-25' }
const DRAFT = { version: 1, complete: true, general_instructions: '', items: [{
  subject: 'Вища математика', lesson_type: null, date_text: 'На завтра', lesson_topic: 'Похідні', source_fragment: SOURCE,
  links: [{ url: 'https://example.org/lesson', title: '' }],
}], warnings: [] }
const request = changes => ({ method: 'POST', headers: { authorization: 'Bearer valid-user-token', 'content-type': 'application/json' }, body: { group_id: GROUP, ...INPUT }, ...changes })

function fixture(options = {}) {
  const state = { permissions: ['homework'], userId: USER, confirmed: true, authError: null, permissionError: null, allowed: true, statusError: null, reserved: true, reserveError: null,
    clients: [], calls: [], provider: [], env: { SUPABASE_URL: 'https://database.example', SUPABASE_SERVICE_ROLE_KEY: 'service-test', SUPABASE_ANON_KEY: 'caller-test', TIMETABLE_RECOGNITION_ENABLED: 'true', OPENAI_API_KEY: 'provider-test', VERCEL_ENV: 'production', ...options.env },
    ...options.state,
  }
  const createClient = (_url, key, clientOptions) => {
    state.clients.push({ key, options: clientOptions })
    const identity = clientOptions.global.headers?.Authorization || key
    return {
      auth: { getUser: async token => ({ data: { user: state.authError ? null : { id: state.userId, email_confirmed_at: state.confirmed ? '2026-10-01T12:00:00Z' : null } }, error: state.authError }) },
      rpc: async (name, args) => {
        state.calls.push({ name, args: plain(args), identity })
        if (name === 'xelay_study_group_permissions') return { data: state.permissions, error: state.permissionError }
        if (name === 'xelay_homework_ai_draft_allowed') return { data: state.allowed, error: state.statusError }
        if (name === 'xelay_reserve_homework_ai_draft') return { data: state.reserved, error: state.reserveError }
        throw new Error(`Unexpected RPC: ${name}`)
      },
    }
  }
  const fetch = async (url, settings) => {
    state.provider.push({ url, settings, body: JSON.parse(settings.body) })
    const response = options.response
    if (response instanceof Error) throw response
    if (response instanceof Response) return response
    const output = options.payload || { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(options.draft || DRAFT) }] }] }
    return new Response(JSON.stringify(output), { status: 200 })
  }
  const api = load(serverSource, { '@supabase/supabase-js': { createClient }, '../src/lib/homeworkAiDraft.js': core }, { fetch, process: { env: state.env } })
  const unused = () => { throw Error('Unexpected unrelated route') }
  const route = load(routeSource, {
    '../../server/homeworkAiDraft.js': api,
    '../../server/seminarAiDraft.js': { createSeminarAiDraft: unused, seminarAiDraftStatus: unused, privateSeminarAiDraftResponse: unused, seminarAiDraftError: unused },
    '../../server/timetableRecognition.js': { privateTimetableRecognitionResponse: (_res) => {}, recognizeTimetable: unused, timetableRecognitionError: unused, timetableRecognitionStatus: unused },
    '../../server/timetableGoogleSheet.js': { downloadTimetableGoogleSheet: unused },
  }, { process: { env: state.env } }).default
  return { api, route, state }
}
const reserves = state => state.calls.filter(call => call.name === 'xelay_reserve_homework_ai_draft')
const response = () => ({ headers: {}, statusCode: null, value: null, writableEnded: false, destroyed: false,
  setHeader(key,value) { this.headers[key] = value }, status(code) { this.statusCode = code; return this }, json(value) { this.value = value; return this },
})
const hasStatus = status => error => error?.status === status

test('homework-only deputy is authorized as caller and reserves cost before one structured provider call', async () => {
  const fx = fixture()
  const result = await fx.api.createHomeworkAiDraft(request())
  assert.equal(result.draft.items[0].source_fragment, SOURCE)
  assert.equal(reserves(fx.state).length, 1)
  assert.equal(fx.state.calls[0].name, 'xelay_study_group_permissions')
  assert.equal(fx.state.calls[0].identity, 'Bearer valid-user-token')
  assert.equal(reserves(fx.state)[0].identity, 'service-test')
  assert.deepEqual(reserves(fx.state)[0].args, { p_user_id: USER, p_group_id: GROUP })
  assert.equal(fx.state.provider.length, 1)
  const call = fx.state.provider[0]
  assert.equal(call.url, 'https://api.openai.com/v1/responses')
  assert.equal(call.body.store, false)
  assert.equal(call.body.max_output_tokens, 6000)
  assert.equal(call.body.text.format.strict, true)
  assert.equal(call.body.text.format.schema.additionalProperties, false)
  assert.equal(Object.hasOwn(call.body, 'tools'), false)
  assert.deepEqual(JSON.parse(call.body.input[0].content[0].text), INPUT)
  assert.doesNotMatch(JSON.stringify(call.body), /service-test|valid-user-token|provider-test/)
  assert.match(call.body.instructions, /UNTRUSTED DATA/)
})

test('anonymous, unconfirmed, seminar-only, teacher/admin-only or permission-error callers cannot spend credits', async () => {
  const cases = [
    [{}, request({ headers: {} }), 401],
    [{ authError: { message: 'private auth detail' } }, request(), 401],
    [{ confirmed: false }, request(), 403],
    [{ permissions: ['seminars'] }, request(), 403],
    [{ permissions: [] }, request(), 403],
    [{ permissionError: { message: 'private database detail' } }, request(), 503],
  ]
  for (const [state, req, status] of cases) {
    const fx = fixture({ state })
    await assert.rejects(fx.api.createHomeworkAiDraft(req), hasStatus(status))
    assert.equal(reserves(fx.state).length, 0)
    assert.equal(fx.state.provider.length, 0)
  }
})

test('availability checks are read-only and missing migration/configuration fail closed without model calls', async () => {
  const ready = fixture()
  assert.deepEqual(plain(await ready.api.homeworkAiDraftStatus({ headers: request().headers, query: { group_id: GROUP } })), { available: true })
  assert.equal(reserves(ready.state).length, 0)
  assert.equal(ready.state.provider.length, 0)
  for (const options of [{ env: { HOMEWORK_AI_DRAFT_ENABLED: 'false' } }, { env: { OPENAI_API_KEY: '' } }, { state: { statusError: { message: 'missing helper' } } }]) {
    const fx = fixture(options)
    assert.equal((await fx.api.homeworkAiDraftStatus({ headers: request().headers, query: { group_id: GROUP } })).available, false)
    assert.equal(reserves(fx.state).length, 0)
    assert.equal(fx.state.provider.length, 0)
  }
  const changed = fixture({ state: { allowed: false } })
  await assert.rejects(changed.api.homeworkAiDraftStatus({ headers: request().headers, query: { group_id: GROUP } }), hasStatus(403))
})

test('unconfigured, disabled, unsupported-model and invalid-key POST requests do not reserve attempts', async () => {
  for (const env of [{ HOMEWORK_AI_DRAFT_ENABLED: 'false' }, { OPENAI_API_KEY: '' }, { HOMEWORK_AI_DRAFT_MODEL: 'unbounded-model' }, { OPENAI_API_KEY: 'key with whitespace' }, { SEMINAR_AI_DRAFT_ENABLED: 'false' }]) {
    const fx = fixture({ env })
    await assert.rejects(fx.api.createHomeworkAiDraft(request()), hasStatus(503))
    assert.equal(reserves(fx.state).length, 0)
    assert.equal(fx.state.provider.length, 0)
  }
  const independent = fixture({ env: { SEMINAR_AI_DRAFT_ENABLED: 'false', HOMEWORK_AI_DRAFT_ENABLED: 'true' } })
  await independent.api.createHomeworkAiDraft(request())
  assert.equal(independent.state.provider.length, 1)
})

test('malformed, oversized and unsupported-content bodies fail before auth, quota and provider', async () => {
  const cases = [
    [request({ body: '{' }), 400], [request({ body: [] }), 400], [request({ body: { ...request().body, group_id: [GROUP] } }), 400],
    [request({ headers: { ...request().headers, 'content-length': '65537' } }), 413],
    [request({ body: ' '.repeat(65537) }), 413], [request({ headers: { ...request().headers, 'content-type': 'text/plain' } }), 415],
    [request({ body: { ...request().body, source_text: 'x'.repeat(12001) } }), 400],
    [request({ body: { ...request().body, reference_date: '2026-02-30' } }), 400],
  ]
  for (const [req,status] of cases) {
    const fx = fixture()
    await assert.rejects(fx.api.createHomeworkAiDraft(req), hasStatus(status))
    assert.equal(fx.state.clients.length, 0)
    assert.equal(reserves(fx.state).length, 0)
    assert.equal(fx.state.provider.length, 0)
  }
})

test('shared actor/group/global quota and changed-permission failures prevent provider calls', async () => {
  for (const [code,status] of [['HOMEWORK_AI_AUTH_REQUIRED',403],['HOMEWORK_AI_PERMISSION_REQUIRED',403],['HOMEWORK_AI_ACTOR_LIMIT',429],['HOMEWORK_AI_GROUP_LIMIT',429],['HOMEWORK_AI_GLOBAL_LIMIT',429],['MISSING_RPC',503]]) {
    const fx = fixture({ state: { reserveError: { message: code } } })
    await assert.rejects(fx.api.createHomeworkAiDraft(request()), hasStatus(status))
    assert.equal(reserves(fx.state).length, 1)
    assert.equal(fx.state.provider.length, 0)
  }
})

test('refusals, incomplete output, malformed or ungrounded extraction never become usable drafts', async () => {
  const outputs = [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{' }] }] },
  ]
  for (const payload of outputs) {
    const fx = fixture({ payload })
    await assert.rejects(fx.api.createHomeworkAiDraft(request()), hasStatus(422))
    assert.equal(fx.state.provider.length, 1)
  }
  const invented = fixture({ draft: { ...DRAFT, items: [{ ...DRAFT.items[0], source_fragment: 'Вигадане завдання, якого немає у повідомленні.' }] } })
  await assert.rejects(invented.api.createHomeworkAiDraft(request()), hasStatus(422))
})

test('provider errors, timeouts and oversized output consume one attempt, with no automatic retries', async () => {
  for (const [options,status] of [
    [{ response: new Response('private provider failure', { status: 503 }) },503],
    [{ response: new Response('{}', { status: 400 }) },422],
    [{ response: new DOMException('private timeout', 'TimeoutError') },504],
    [{ response: new Response('x'.repeat(256*1024+1), { status: 200 }) },422],
  ]) {
    const fx = fixture(options)
    await assert.rejects(fx.api.createHomeworkAiDraft(request()), hasStatus(status))
    assert.equal(reserves(fx.state).length, 1)
    assert.equal(fx.state.provider.length, 1)
  }
  const aborted = fixture()
  await assert.rejects(aborted.api.createHomeworkAiDraft(request({ aborted: true })), hasStatus(504))
  assert.equal(aborted.state.provider.length, 0)
})

test('the existing multiplexer routes only authenticated same-origin homework GET/POST and keeps private response headers', async () => {
  const fx = fixture()
  const res = response()
  await fx.route({ method: 'GET', headers: { ...request().headers, host: 'www.xelay.ink', origin: 'https://www.xelay.ink' }, query: { xelay_ai_route: 'homework', group_id: GROUP } }, res)
  assert.equal(res.statusCode,200)
  assert.deepEqual(plain(res.value),{ available:true })
  assert.equal(res.headers['Cache-Control'],'no-store, private')
  assert.equal(res.headers['X-Content-Type-Options'],'nosniff')
  assert.equal(fx.state.provider.length,0)
  for (const req of [
    { method:'PUT', headers:{}, query:{ xelay_ai_route:'homework' } },
    { method:'GET', headers:{ host:'www.xelay.ink', origin:'https://evil.example' }, query:{ xelay_ai_route:'homework', group_id:GROUP } },
  ]) {
    const separate = fixture(), rejected = response()
    await separate.route(req,rejected)
    assert.ok([403,405].includes(rejected.statusCode))
    assert.equal(separate.state.clients.length,0)
  }
})

test('error responses redact unknown exception details and do not write after disconnection', () => {
  const fx = fixture(), unknown = response()
  fx.api.homeworkAiDraftError(unknown,new Error('PRIVATE_TOKEN_AND_SOURCE'))
  assert.equal(unknown.statusCode,503)
  assert.doesNotMatch(JSON.stringify(unknown.value),/PRIVATE_TOKEN_AND_SOURCE/)
  const closed = response(); closed.writableEnded = true
  fx.api.homeworkAiDraftError(closed,new Error('private'))
  assert.equal(closed.statusCode,null)
})
