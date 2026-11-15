// Local-only HTTP boundary and runtime-wiring tests. Requests are in-memory
// streams; external SDKs/ports are replaced before runtime evaluation. No real
// keys, environment discovery, provider, listener, network or database is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import crypto from 'node:crypto'
import ts from 'typescript'
import { createAssistantCloudHandler } from '../../server/assistant-v2/cloudHandler.ts'
import { createAuthenticatedAssistantChat } from '../../server/assistant-v2/cloudChat.ts'
import { createAssistantCloudTools } from '../../server/assistant-v2/cloudTools.ts'

const ROOT = new URL('../../', import.meta.url)
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const USER = uid(1), OTHER = uid(2), TOKEN = 'synthetic-session-credential-no-network'
const NOW = Date.parse('2026-11-02T10:00:00Z')
const SESSION = { userId: USER, expiresAt: '2026-11-02T11:00:00Z', accountActive: true, emailConfirmed: true, sessionId: 'synthetic-session' }
const ENV = { ASSISTANT_ENABLED: 'true', ASSISTANT_CLOUD_DRAFTS_READY: 'true',
  SUPABASE_URL: 'https://baohfpadxvhqhhjjqtil.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public_fixture_123456789',
  SUPABASE_SERVICE_ROLE_KEY: ['sb', 'secret', 'synthetic_private_fixture_987654321'].join('_') }
const MODEL_KEY = ['sk','synthetic_fixture_model_only_1234567890'].join('-')
const MODEL_ENV = { ...ENV, ASSISTANT_MODEL_ENABLED:'true', ASSISTANT_MODEL_BUDGET_READY:'true', ASSISTANT_MODEL_SPEND_APPROVED:'true', OPENAI_API_KEY:MODEL_KEY }
const GROUP=uid(101),SUBJECT=uid(201),LESSON=uid(301),DRAFT=uid(401),REQUEST_ID=uid(501)
const CHAT_BODY={message:'Додай ДЗ по вышмату на 2026-11-03',teacherMessage:'Якщо заняття відбудеться, розв’яжіть вправи 1–4. Якщо перенесуть, нічого не здавайте.',requestId:REQUEST_ID}
const jwt = (role, patch = {}, headerPatch = {}) => [
  { alg: 'HS256', typ: 'JWT', ...headerPatch },
  { iss: 'supabase', ref: 'baohfpadxvhqhhjjqtil', role, iat: 1700000000, exp: 2200000000, ...patch },
].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).concat('syntheticSignature').join('.')

function response() {
  const res = new EventEmitter()
  Object.assign(res, { destroyed: false, writableEnded: false, status: undefined, headers: {}, raw: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(value = '') { this.raw += value; this.writableEnded = true },
  })
  return res
}
async function dispatch(handler, options = {}) {
  const method = options.method || (options.route?.startsWith('drafts/') || ['read','chat','import/prepare','homework/prepare-batch','materials/explain','tests/import-preview'].includes(options.route) ? 'POST' : 'GET')
  const bytes = options.bytes ?? (options.body === undefined ? '' : JSON.stringify(options.body))
  const req = Readable.from(options.chunks || (bytes ? [bytes] : []))
  Object.assign(req, { method, url: options.url || `/api/assistant?route=${encodeURIComponent(options.route || 'catalog')}`,
    headers: { authorization: `Bearer ${TOKEN}`, ...(method === 'POST' ? { origin: 'https://www.xelay.ink', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}), ...options.headers } })
  if (options.parsed !== undefined) req.body = options.parsed
  const res = options.res || response()
  await handler(req, res)
  return { status: res.status, headers: res.headers, raw: res.raw, body: res.raw ? JSON.parse(res.raw) : undefined }
}
function harness(options = {}) {
  const state = { calls: [], time: NOW, session: { ...SESSION }, latestSession: undefined, verifyCount: 0 }
  const ports = {
    verifySession: async (credential, signal) => { state.calls.push(['verify', credential, signal]); state.verifyCount++; return state.verifyCount > 1 && state.latestSession !== undefined ? state.latestSession : state.session },
    catalog: async (session, credential, signal) => { state.calls.push(['catalog', session.userId, credential, signal]); return { userId: session.userId, groups: [] } },
    read: async (credential, value, signal) => { state.calls.push(['read', credential, value, signal]); return { userId: USER, records: [], modelContext: { private: 'PRIVATE_MODEL_CONTEXT' }, modelConnected: false } },
    writes: Object.fromEntries(['list', 'prepare', 'edit', 'cancel', 'confirm'].map(operation => [operation, async (credential, value) => { state.calls.push([operation, credential, value]); return { operation, modelConnected: false } }])),
  }
  const handler = createAssistantCloudHandler({ enabled: true, ports, now: () => state.time, ...options })
  return { handler, state, ports }
}
async function runtimeHarness() {
  const source = await readFile(new URL('server/assistant-v2/cloudRuntime.ts', ROOT), 'utf8')
  const state = { clients: [], journal: null, callerOperations: [], journalOperations: [], outbound: [], plannerFactories:[],plannerCalls:[],budgetFactories:[],budgetCalls:[],writeCalls:[],insideBudget:0,budgetMode:'allow',studyFactories:[],toolFactories:[],taskFactories:[],taskCalls:[],materialCalls:[] }
  const module = { exports: {} }
  const verifySession = async (client, credential) => {
    assert.equal(client.key, ENV.SUPABASE_ANON_KEY)
    assert.equal(client.options.global.headers.Authorization, `Bearer ${credential}`)
    return { ...SESSION, expiresAt: '2090-01-01T00:00:00Z' }
  }
  const imports = {
    'node:crypto': crypto,
    '@supabase/supabase-js': { createClient(url, key, options) {
      const client = { url, key, options, rpc(name, args) {
        (key === ENV.SUPABASE_SERVICE_ROLE_KEY ? state.journalOperations : state.callerOperations).push({ name, args, client })
        const query = Promise.resolve({ data: name === 'xelay_teaching_workspace' ? state.importWorkspace : [], error: null })
        query.abortSignal = signal => { assert.ok(signal instanceof AbortSignal); return query }
        return query
      } }
      state.clients.push(client); return client
    } },
    './cloudHandler.ts': { createAssistantCloudHandler },
    './authenticatedRead.ts': { createAuthenticatedAssistantReadService(dependencies) {
      return { async read(credential, value, signal) {
        const session = await dependencies.verifySession(credential, signal)
        await dependencies.createCallerRepository(session, credential).catalog(signal)
        return { userId: session.userId, records: [{kind:'lesson',id:uid(999),scheduleId:LESSON,groupId:GROUP,subjectId:SUBJECT,title:'Вища математика',date:value.scope.from||'2026-11-03',startsAt:'08:30',endsAt:'09:50'}],truncated:false,modelContext: { fixture: 'PRIVATE_MODEL_CONTEXT' } }
      } }
    } },
    './cloudStudyServices.ts': {createCloudStudyServices(dependencies){
      state.studyFactories.push(dependencies)
      const read=imports['./authenticatedRead.ts'].createAuthenticatedAssistantReadService(dependencies).read
      return{read,async materialContent(credential,value,signal){
        state.materialCalls.push({operation:'content',credential,value})
        const session=await dependencies.verifySession(credential,signal),client=dependencies.createCallerClient(session,credential)
        assert.equal(client.key,ENV.SUPABASE_ANON_KEY);assert.equal(client.options.global.headers.Authorization,`Bearer ${credential}`)
        await client.rpc('fixture_caller_material_rights',{materialId:value.materialId})
        return{userId:session.userId,allowAi:true,text:'Exact synthetic author material.',title:'Synthetic lecture',rightsVersion:'a'.repeat(32),sources:[{id:value.materialId,title:'Synthetic lecture',path:`/groups/${GROUP}?tab=materials`}]}
      },async assertMaterialRights(credential,value,signal){
        state.materialCalls.push({operation:'recheck',credential,value});const session=await dependencies.verifySession(credential,signal)
        return{userId:session.userId,allowAi:true,rightsVersion:'a'.repeat(32)}
      }}
    }},
    './cloudTools.ts':{createAssistantCloudTools(dependencies){state.toolFactories.push(dependencies);return createAssistantCloudTools(dependencies)}},
    './cloudTaskModel.ts':{createOpenAiCloudTaskModel(options){
      assert.equal(options.apiKey,MODEL_KEY);assert.equal(options.enabled,true);assert.equal(options.billingApproved,true);state.taskFactories.push(options)
      return{async generate(task){assert.equal(state.insideBudget,1,'task provider requires the same durable budget');state.taskCalls.push(task)
        const value = task.task === 'test-import' ? { draftText: '1. Синтетичне запитання\nТип: есе', notes: [] }
          : {safe:true,answer:'Synthetic explanation based on source.',quotes:['Exact synthetic author material.']}
        return{value,usage:{inputTokens:2000,outputTokens:300}}
      }}
    }},
    './supabaseReadRepository.ts': {
      verifySupabaseAssistantSession: verifySession,
      createSupabaseAssistantReadRepository({ client, userId, credential }) {
        assert.equal(client.key, ENV.SUPABASE_ANON_KEY); assert.equal(client.options.global.headers.Authorization, `Bearer ${credential}`)
        return { async catalog() { await client.rpc('fixture_caller_catalog', { userId }); return { userId,
          groups:[{id:GROUP,name:'Synthetic group',program:'Synthetic',studyYear:1,learning:true,permissions:['schedule','homework']}],
          subjects:[{id:SUBJECT,groupId:GROUP,name:'Вища математика',kind:'study'}],courses:[] } } }
      },
    },
    './cloudDraftRepository.ts': { createCloudDraftRepository({ client, confirmationSecret }) {
      assert.equal(client.key, ENV.SUPABASE_SERVICE_ROLE_KEY)
      assert.equal(client.options.global.headers, undefined)
      state.journal = { client, confirmationSecret }
      return { mode: 'supabase-service-journal', async list(userId) { await client.rpc('fixture_private_journal_list', { userId }); return [] } }
    } },
    './cloudWrites.ts': { createCloudConfirmedAssistantWrites(dependencies) {
      return Object.fromEntries(['list', 'prepare', 'edit', 'cancel', 'confirm','form'].map(operation => [operation, async (credential,value) => {
        state.writeCalls.push({operation,credential,value})
        const session = await dependencies.verifySession(credential)
        const client = await dependencies.createCallerClient(session, credential)
        assert.equal(client.key, ENV.SUPABASE_ANON_KEY)
        assert.equal(client.options.global.headers.Authorization, `Bearer ${credential}`)
        await client.rpc('fixture_caller_business_check', { operation })
        await dependencies.journal.list(session.userId)
        return operation==='prepare'?{status:'draft',draft:{id:DRAFT,action:value.action,scope:value.scope,payload:value.payload,revision:1,status:'pending'}}:{ drafts: [], modelConnected: false }
      }]))
    } },
    './cloudChat.ts':{createAuthenticatedAssistantChat},
    './cloudPlanner.ts':{createOpenAiAssistantPlanner(options){
      assert.equal(options.apiKey,MODEL_KEY);assert.equal(options.enabled,true);assert.equal(options.billingApproved,true);state.plannerFactories.push(options)
      return{async plan(request){assert.equal(state.insideBudget,1,'provider must be called only inside a verified reservation');state.plannerCalls.push(request)
        return{intent:{kind:'homework',subject:'subject1',date:'2026-11-03',topic:'Службова перевірка'},usage:{inputTokens:2000,outputTokens:300}}
      }}
    }},
    './modelBudget.ts':{
      createSupabaseModelBudgetLedger({client}){assert.equal(client.key,ENV.SUPABASE_SERVICE_ROLE_KEY);assert.equal(client.options.global.headers,undefined);return{mode:'private-model-budget',client}},
      createAssistantModelBudget(dependencies){state.budgetFactories.push(dependencies);assert.equal(dependencies.ledger.mode,'private-model-budget')
        return{async run(credential,request,operation){
          assert.equal(credential,TOKEN);const session=await dependencies.verifySession(credential);assert.equal(session.userId,USER)
          assert.equal(request.requestId,REQUEST_ID);assert.match(request.contextHash,/^[a-f0-9]{64}$/)
          state.budgetCalls.push({credential,request})
          if(state.budgetMode!=='allow')throw Object.assign(new Error('RAW_PRIVATE_BUDGET_MESSAGE'),{code:state.budgetMode==='disabled'?'assistant_model_budget_disabled':'assistant_model_budget_exhausted',status:state.budgetMode==='disabled'?503:429})
          state.insideBudget++;try{const result=await operation();assert.deepEqual(result.usage,{inputTokens:2000,outputTokens:300});return{value:result.value,remaining:{dayMicrousd:50000,monthMicrousd:100000,userDayRequests:4},finalized:true}}finally{state.insideBudget--}
        }}
      },
    },
  }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, Buffer, AbortSignal, Date, process: { env: {} }, require(name) { assert.ok(name in imports, 'Only reviewed runtime dependencies: ' + name); return imports[name] },
      fetch: async (input, init) => { state.outbound.push({ input, init }); return new Response('{}', { status: 200 }) } })
  return { ...module.exports, state }
}

test('only fixed routes/methods/query shape exist; arbitrary model/provider/payment routes stay unreachable', async () => {
  for (const route of ['model', 'generate', 'pay', 'billing', 'provider', 'dean', '__proto__', 'constructor', 'drafts/get', 'drafts/prepare/../confirm']) {
    const h = harness(); const result = await dispatch(h.handler, { route })
    assert.equal(result.status, 404); assert.deepEqual(result.body, { error: 'not_found' }); assert.equal(h.state.calls.length, 0)
  }
  for (const url of ['/api/assistant', '/api/assistant?route=catalog&userId=' + OTHER, '/api/assistant?route=catalog&route=drafts', '/api/assistant?route=catalog&model=flash']) {
    const h = harness(); assert.equal((await dispatch(h.handler, { url })).status, 400); assert.equal(h.state.calls.length, 0)
  }
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
    const h = harness(); assert.equal((await dispatch(h.handler, { route: 'catalog', method })).status, 405); assert.equal(h.state.calls.length, 0)
  }
  assert.equal((await dispatch(harness().handler,{route:'chat',method:'GET'})).status,405)
})

test('same-origin POST and strict bearer headers are required before any authenticated port', async () => {
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.invalid' }, { origin: 'null' }, { origin: 'https://www.xelay.ink.evil.invalid' }, { origin: ['https://www.xelay.ink'] }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const h = harness(); const result = await dispatch(h.handler, { route: 'drafts/prepare', body: {}, headers })
    assert.equal(result.status, 403); assert.equal(h.state.calls.length, 0)
  }
  for (const authorization of [undefined, '', 'Basic credentials', 'Bearer short', 'Bearer ' + 'a'.repeat(8193), `Bearer ${TOKEN} trailing`, [`Bearer ${TOKEN}`], `Bearer ${TOKEN}\n`]) {
    const h = harness(); assert.equal((await dispatch(h.handler, { headers: { authorization } })).status, 401); assert.equal(h.state.calls.length, 0)
  }
  const h = harness()
  assert.equal((await dispatch(h.handler, { route: 'read', body: { topic: 'study', scope: {} }, headers: { origin: 'https://xelay.ink', 'sec-fetch-site': undefined } })).status, 200)
})

test('bootstrap stays private, cannot turn on a model and disabled/missing configuration never initializes ports', async () => {
  for (const options of [{ enabled: false }, { enabled: true, ports: undefined }]) {
    const h = harness(options)
    const bootstrap = await dispatch(h.handler, { route: 'bootstrap' })
    assert.deepEqual(bootstrap.body, { available: false, modelConnected: false, writesAvailable: false })
    assert.equal(h.state.calls.length, 0)
    const catalog = await dispatch(h.handler)
    assert.equal(catalog.status, 503); assert.equal(h.state.calls.length, 0)
  }
  const h = harness(); assert.deepEqual((await dispatch(h.handler, { route: 'bootstrap' })).body, { available: true, modelConnected: false, writesAvailable: true })
  assert.equal(h.state.calls.length, 0)
})

test('chat is a fixed POST capability and remains explicitly disconnected without the optional model port',async()=>{
  const h=harness(),result=await dispatch(h.handler,{route:'chat',body:CHAT_BODY})
  assert.equal(result.status,409);assert.deepEqual(result.body,{error:'model_not_connected'})
  assert.ok(h.state.calls.every(call=>call[0]==='verify'))
  assert.equal((await dispatch(h.handler,{route:'chat',method:'GET'})).status,405)
  h.ports.chat=async()=>({userId:USER,kind:'clarify',text:'Synthetic'})
  assert.deepEqual((await dispatch(h.handler,{route:'bootstrap'})).body,{available:true,modelConnected:true,writesAvailable:true})
})

test('chat requires the exact origin, bearer, request UUID and top-level shape before a planner can run',async()=>{
  for(const headers of[{origin:undefined},{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'},{authorization:undefined}]){
    const h=harness();h.ports.chat=async()=>assert.fail('untrusted browser reached chat')
    const result=await dispatch(h.handler,{route:'chat',body:CHAT_BODY,headers});assert.ok([401,403].includes(result.status));assert.equal(h.state.calls.length,0)
  }
  for(const body of[
    {...CHAT_BODY,requestId:undefined},{...CHAT_BODY,requestId:'bad'},{...CHAT_BODY,requestId:'00000000-0000-0000-0000-000000000000'},
    ...[{userId:OTHER},{role:'admin'},{plan:{table:'users'}},{model:'other-model'},{apiKey:'synthetic-ignored'},{confirm:true},{acceptMaterialRights:true}].map(extra=>({...CHAT_BODY,...extra})),
  ]){
    const h=harness();h.ports.chat=async()=>assert.fail('invalid shape reached chat')
    assert.equal((await dispatch(h.handler,{route:'chat',body})).status,400);assert.ok(h.state.calls.every(call=>call[0]==='verify'))
  }
})

test('chat forwards a request-bound caller and body without its accounting identifier and never confirms a draft',async()=>{
  const h=harness(),requestId='ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF'
  h.ports.chat=async(credential,body,signal,request)=>{h.state.calls.push(['chat',credential,body,signal,request]);return{userId:USER,kind:'draft',draft:{id:DRAFT,status:'pending'}}}
  const result=await dispatch(h.handler,{route:'chat',body:{...CHAT_BODY,requestId}})
  assert.equal(result.status,200);assert.equal(result.body.kind,'draft');assert.equal(result.body.draft.status,'pending')
  const call=h.state.calls.at(-1);assert.equal(call[0],'chat');assert.equal(call[1],TOKEN);assert.equal(call[4],requestId.toLowerCase());assert.ok(call[3] instanceof AbortSignal)
  assert.equal('requestId' in call[2],false);assert.deepEqual(call[2],{message:CHAT_BODY.message,teacherMessage:CHAT_BODY.teacherMessage})
  assert.ok(h.state.calls.every(call=>['verify','chat'].includes(call[0])))
  assert.match(result.headers['cache-control'],/no-store/);assert.equal(result.headers['access-control-allow-origin'],undefined)
})

test('a chat projection for a different owner and raw provider errors cannot reach the browser',async()=>{
  const h=harness();h.ports.chat=async()=>({userId:OTHER,kind:'read',text:'FOREIGN_PRIVATE_DATA'})
  const foreign=await dispatch(h.handler,{route:'chat',body:CHAT_BODY});assert.equal(foreign.status,401);assert.deepEqual(foreign.body,{error:'session_changed'});assert.equal(foreign.raw.includes('FOREIGN'),false)
  for(const[code,status]of[['assistant_model_budget_exhausted',429],['model_balance_required',503],['assistant_model_budget_disabled',503]]){
    h.ports.chat=async()=>{throw Object.assign(new Error('RAW_PRIVATE_PROVIDER_KEY'),{code,status})}
    const result=await dispatch(h.handler,{route:'chat',body:CHAT_BODY});assert.equal(result.status,status);assert.deepEqual(result.body,{error:code});assert.equal(result.raw.includes('RAW_PRIVATE'),false)
  }
})

test('session confirmation/activity/expiry and identity changes fail closed without exposing data', async () => {
  for (const session of [null, { ...SESSION, accountActive: false }, { ...SESSION, emailConfirmed: false }, { ...SESSION, expiresAt: 'invalid' }, { ...SESSION, expiresAt: new Date(NOW).toISOString() }]) {
    const h = harness(); h.state.session = session
    assert.equal((await dispatch(h.handler)).status, 401)
    assert.ok(h.state.calls.every(call => call[0] === 'verify'))
  }
  for (const latest of [null, { ...SESSION, userId: OTHER }, { ...SESSION, sessionId: 'different' }, { ...SESSION, accountActive: false }, { ...SESSION, emailConfirmed: false }, { ...SESSION, expiresAt: 'invalid' }, { ...SESSION, expiresAt: new Date(NOW).toISOString() }]) {
    const h = harness(); h.state.latestSession = latest
    const result = await dispatch(h.handler)
    assert.equal(result.status, 401); assert.deepEqual(result.body, { error: 'session_changed' })
  }
  const h = harness(); h.ports.catalog = async () => ({ userId: OTHER, groups: ['FOREIGN'] })
  assert.equal((await dispatch(h.handler)).status, 401)
})

test('POST bodies are bounded JSON objects for both streams and platform-parsed requests', async () => {
  for (const headers of [{ 'content-type': undefined }, { 'content-type': 'text/plain' }, { 'content-type': 'application/json; charset=ascii' }, { 'content-encoding': 'gzip' }]) {
    const h = harness(); const result = await dispatch(h.handler, { route: 'read', body: {}, headers })
    assert.equal(result.status, 415); assert.ok(h.state.calls.every(call => call[0] === 'verify'))
  }
  for (const options of [{ bytes: 'not json' }, { bytes: 'null' }, { bytes: '[]' }, { bytes: '{"__proto__":{"role":"admin"}}' },
    { parsed: { constructor: {} } }, { parsed: 'not json' }, { bytes: JSON.stringify({ text: 'x'.repeat(180000) }) },
    { parsed: { text: 'x'.repeat(180000) } }, { chunks: [Buffer.alloc(90001, 97), Buffer.alloc(90001, 97)] },
    { body: {}, headers: { 'content-length': '180001' } }, { body: {}, headers: { 'content-length': '-1' } }]) {
    const h = harness(); const result = await dispatch(h.handler, { route: 'read', ...options })
    assert.ok([400, 413].includes(result.status)); assert.ok(h.state.calls.every(call => call[0] === 'verify'))
  }
  for (const parsed of [JSON.stringify({ topic: 'study', scope: {} }), Buffer.from(JSON.stringify({ topic: 'study', scope: {} })), { topic: 'study', scope: {} }]) {
    const h = harness(); assert.equal((await dispatch(h.handler, { route: 'read', parsed })).status, 200)
  }
})

test('browser identity, arbitrary plans, role and model settings cannot be smuggled into read/draft ports', async () => {
  const values = {
    read: { topic: 'study', scope: {} }, 'drafts/prepare': { action: 'homework.upsert', scope: {}, payload: {} },
    'drafts/edit': { id: uid(90), revision: 1, confirmationToken: 'f'.repeat(48), payload: {} },
    'drafts/cancel': { id: uid(90), revision: 1, confirmationToken: 'f'.repeat(48) },
    'drafts/confirm': { id: uid(90), revision: 1, confirmationToken: 'f'.repeat(48) },
  }
  for (const [route, body] of Object.entries(values)) for (const extra of [{ userId: OTHER }, { role: 'admin' }, { plan: { table: 'users' } }, { model: 'paid-provider' }, ...(route==='drafts/confirm'?[]:[{ acceptMaterialRights: true }])]) {
    const h = harness(); assert.equal((await dispatch(h.handler, { route, body: { ...body, ...extra } })).status, 400)
    assert.ok(h.state.calls.every(call => call[0] === 'verify'))
  }
  for (const [route, body] of Object.entries(values)) {
    const h = harness(); const result = await dispatch(h.handler, { route, body })
    assert.equal(result.status, 200)
    assert.equal(h.state.calls.at(-1)[0], route === 'read' ? 'read' : route.slice('drafts/'.length))
    assert.equal(h.state.calls.at(-1)[1], TOKEN)
  }
})

test('explicit material-rights checkbox is accepted only as a boolean on draft confirmation',async()=>{
  const binding={id:uid(90),revision:1,confirmationToken:'f'.repeat(48)}
  for(const acceptMaterialRights of [true,false]){
    const h=harness(),result=await dispatch(h.handler,{route:'drafts/confirm',body:{...binding,acceptMaterialRights}})
    assert.equal(result.status,200);assert.equal(h.state.calls.at(-1)[2].acceptMaterialRights,acceptMaterialRights)
  }
  for(const acceptMaterialRights of ['true',1,null,{},[]]){
    const h=harness(),result=await dispatch(h.handler,{route:'drafts/confirm',body:{...binding,acceptMaterialRights}})
    assert.equal(result.status,400);assert.ok(h.state.calls.every(c=>c[0]==='verify'))
  }
})

test('new tool routes keep POST/origin/owner gates and remain off without the optional model tools',async()=>{
  for(const route of ['import/prepare','homework/prepare-batch','materials/explain']){
    const h=harness();assert.equal((await dispatch(h.handler,{route,method:'GET'})).status,405)
    assert.equal((await dispatch(h.handler,{route,body:{},headers:{origin:'https://evil.invalid'}})).status,403)
    assert.equal((await dispatch(h.handler,{route,body:{}})).status,409)
    assert.ok(h.state.calls.every(c=>c[0]==='verify'))
    h.ports.tools=Object.fromEntries(['importSchedule','batchHomework','explainMaterial'].map(op=>[op,async()=>({userId:OTHER,text:'FOREIGN_CONTENT'})]))
    const foreign=await dispatch(h.handler,{route,body:{}});assert.equal(foreign.status,401);assert.equal(foreign.raw.includes('FOREIGN_CONTENT'),false)
  }
})

test('only import preparation gets the larger bounded image body allowance',async()=>{
  const h=harness();let calls=0
  h.ports.tools={importSchedule:async()=>{calls++;return{userId:USER,drafts:[]}},batchHomework:async()=>assert.fail(),explainMaterial:async()=>assert.fail()}
  const body={source:'x'.repeat(200000)}
  assert.equal((await dispatch(h.handler,{route:'import/prepare',body})).status,200)
  assert.equal((await dispatch(h.handler,{route:'homework/prepare-batch',body})).status,413)
  assert.equal((await dispatch(h.handler,{route:'materials/explain',body})).status,413)
  assert.equal((await dispatch(h.handler,{route:'import/prepare',body:{source:'x'.repeat(3800001)}})).status,413)
  assert.equal(calls,1)
})

test('private read model context is removed and responses cannot be cached or embedded', async () => {
  const h = harness(), result = await dispatch(h.handler, { route: 'read', body: { topic: 'study', scope: {} } })
  assert.equal(result.status, 200); assert.equal(result.body.modelContext, undefined); assert.equal(result.raw.includes('PRIVATE_MODEL_CONTEXT'), false)
  assert.match(result.headers['cache-control'], /no-store/)
  assert.equal(result.headers['x-content-type-options'], 'nosniff')
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(result.headers['referrer-policy'], 'no-referrer')
  assert.equal(result.headers['access-control-allow-origin'], undefined)
})

test('errors redact provider keys, stack traces and unexpected codes; explicit safe error statuses survive', async () => {
  const h = harness(); h.ports.read = async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_KEY'), { code: 'PRIVATE_CODE', status: 418, stack: 'PRIVATE_STACK' }) }
  const result = await dispatch(h.handler, { route: 'read', body: { topic: 'study', scope: {} } })
  assert.deepEqual(result.body, { error: 'assistant_unavailable' }); assert.equal(result.status, 503); assert.equal(/PRIVATE/.test(result.raw), false)
  h.ports.read = async () => { throw Object.assign(new Error('PRIVATE_MESSAGE'), { code: 'access_denied', status: 403 }) }
  assert.deepEqual((await dispatch(h.handler, { route: 'read', body: { topic: 'study', scope: {} } })).body, { error: 'access_denied' })
})

test('burst limits reset after a minute, including a full 5000-user map', async () => {
  const h = harness()
  for (let index = 0; index < 90; index++) assert.equal((await dispatch(h.handler, { route: 'drafts' })).status, 200)
  assert.equal((await dispatch(h.handler, { route: 'drafts' })).status, 429)
  h.state.time += 60001
  assert.equal((await dispatch(h.handler, { route: 'drafts' })).status, 200)
  const full = harness()
  for (let index = 0; index < 5000; index++) { full.state.session.userId = uid(index + 1); assert.equal((await dispatch(full.handler, { route: 'drafts' })).status, 200) }
  full.state.session.userId = uid(6001)
  assert.equal((await dispatch(full.handler, { route: 'drafts' })).status, 429)
  full.state.time += 60001
  assert.equal((await dispatch(full.handler, { route: 'drafts' })).status, 200)
})

test('runtime configuration is project-pinned, rejects confused keys and requires reviewed journal readiness', async () => {
  const { assistantCloudConfiguration: configure, createAssistantCloudRuntime: runtime, state } = await runtimeHarness()
  assert.equal(configure(ENV).valid, true)
  assert.equal(configure({ ...ENV, SUPABASE_ANON_KEY: jwt('anon'), SUPABASE_SERVICE_ROLE_KEY: jwt('service_role') }).valid, true)
  for (const patch of [{ ASSISTANT_CLOUD_DRAFTS_READY: undefined }, { ASSISTANT_CLOUD_DRAFTS_READY: 'TRUE' }, { SUPABASE_URL: 'http://127.0.0.1' },
    { SUPABASE_URL: ENV.SUPABASE_URL + '.evil.invalid' }, { SUPABASE_URL: 'https://evil.invalid@baohfpadxvhqhhjjqtil.supabase.co' },
    { SUPABASE_ANON_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY }, { SUPABASE_ANON_KEY: jwt('service_role') }, { SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_ANON_KEY },
    { SUPABASE_ANON_KEY: 'junk.' + Buffer.from('{"role":"anon"}').toString('base64url') + '.junk' },
    { SUPABASE_ANON_KEY: jwt('anon', { ref: 'foreign-project' }) }, { SUPABASE_ANON_KEY: jwt('anon', {}, { alg: 'none' }) },
    { SUPABASE_ANON_KEY: jwt('anon', { exp: 1 }) }, { SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) }, { SUPABASE_SERVICE_ROLE_KEY: jwt('service_role', { ref: 'foreign-project' }) }]) {
    const env = { ...ENV, ...patch }
    assert.equal(configure(env).valid, false, JSON.stringify(patch))
    const before = state.clients.length, handler = runtime(env)
    assert.equal(state.clients.length, before)
    assert.equal((await dispatch(handler, { route: 'bootstrap' })).body.available, false)
  }
  assert.equal(configure({ ...ENV, VERCEL_ENV: 'preview', VERCEL_URL: 'xelay-preview.vercel.app' }).origins.includes('https://xelay-preview.vercel.app'), true)
  assert.equal(configure({ ...ENV, VERCEL_ENV: 'production', VERCEL_URL: 'xelay-preview.vercel.app' }).origins.includes('https://xelay-preview.vercel.app'), false)
  assert.equal(configure({ ...ENV, VERCEL_ENV: 'preview', VERCEL_URL: 'xelay.vercel.app.evil.invalid' }).origins.length, 2)
  assert.equal(configure({ ...ENV, ASSISTANT_LOCAL_PREVIEW: 'true' }).origins.includes('http://127.0.0.1:3078'), true)
  assert.equal(configure({ ...ENV, ASSISTANT_LOCAL_PREVIEW: 'true', VERCEL: '1' }).origins.includes('http://127.0.0.1:3078'), false)
})

test('model runtime requires three independent approval/readiness flags and an existing server key',async()=>{
  const {assistantCloudConfiguration:configure,createAssistantCloudRuntime:runtime,state}=await runtimeHarness()
  assert.equal(configure(MODEL_ENV).modelEnabled,true)
  for(const patch of[
    {ASSISTANT_MODEL_ENABLED:undefined},{ASSISTANT_MODEL_ENABLED:'TRUE'},{ASSISTANT_MODEL_BUDGET_READY:undefined},
    {ASSISTANT_MODEL_SPEND_APPROVED:undefined},{OPENAI_API_KEY:undefined},{OPENAI_API_KEY:'invalid-public-key'},
    {ASSISTANT_ENABLED:'false'},{ASSISTANT_CLOUD_DRAFTS_READY:'false'},
  ]){
    const env={...MODEL_ENV,...patch};assert.equal(configure(env).modelEnabled,false)
    const handler=runtime(env);const result=await dispatch(handler,{route:'bootstrap'});assert.equal(result.body.modelConnected,false)
    assert.equal(state.plannerFactories.length,0);assert.equal(state.budgetFactories.length,0);assert.equal(state.plannerCalls.length,0)
  }
  assert.equal(configure(ENV).modelEnabled,false)
})

test('actual authenticated chat reaches the fixed planner only inside the separate budget and prepares without confirmation',async()=>{
  const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness(),handler=runtime(MODEL_ENV)
  assert.equal(state.plannerFactories.length,1);assert.equal(state.budgetFactories.length,1);assert.equal(state.plannerCalls.length,0)
  assert.equal((await dispatch(handler,{route:'bootstrap'})).body.modelConnected,true)
  const response=await dispatch(handler,{route:'chat',body:CHAT_BODY})
  assert.equal(response.status,200);assert.equal(response.body.userId,USER);assert.equal(response.body.kind,'draft')
  assert.equal(response.body.draft.action,'homework.upsert');assert.equal(response.body.draft.scope.groupId,GROUP)
  assert.equal(response.body.draft.payload.lessonId,LESSON);assert.equal(response.body.draft.payload.date,'2026-11-03')
  assert.equal(response.body.draft.payload.body,CHAT_BODY.teacherMessage);assert.equal(response.body.draft.payload.dueAt,null)
  assert.equal(state.budgetCalls.length,1);assert.equal(state.plannerCalls.length,1)
  const {signal,...plannerData}=state.plannerCalls[0];assert.ok(signal instanceof AbortSignal)
  assert.equal(state.budgetCalls[0].request.contextHash,crypto.createHash('sha256').update(JSON.stringify(plannerData)).digest('hex'))
  assert.equal(state.budgetCalls[0].request.requestId,REQUEST_ID);assert.equal(state.budgetCalls[0].credential,TOKEN)
  const prepared=state.writeCalls.filter(call=>call.operation==='prepare');assert.equal(prepared.length,1)
  assert.equal(state.writeCalls.some(call=>call.operation==='confirm'),false)
  for(const secret of[TOKEN,MODEL_KEY,ENV.SUPABASE_SERVICE_ROLE_KEY,state.journal.confirmationSecret,USER,GROUP,SUBJECT,LESSON])assert.equal(JSON.stringify(plannerData).includes(secret),false,'planner must not receive identity or credentials')
  for(const secret of[TOKEN,MODEL_KEY,ENV.SUPABASE_SERVICE_ROLE_KEY,state.journal.confirmationSecret,'PRIVATE_MODEL_CONTEXT'])assert.equal(response.raw.includes(secret),false)
  assert.ok(state.callerOperations.every(row=>row.client.key===ENV.SUPABASE_ANON_KEY&&row.client.options.global.headers.Authorization===`Bearer ${TOKEN}`))
  assert.ok(state.journalOperations.every(row=>row.client.key===ENV.SUPABASE_SERVICE_ROLE_KEY&&!row.client.options.global.headers))
})

test('disabled or exhausted assistant budget blocks every provider and write operation even when model configuration is ready',async()=>{
  for(const mode of['disabled','exhausted']){
    const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness(),handler=runtime(MODEL_ENV);state.budgetMode=mode
    const result=await dispatch(handler,{route:'chat',body:CHAT_BODY})
    assert.equal(result.status,mode==='disabled'?503:429)
    assert.deepEqual(result.body,{error:mode==='disabled'?'assistant_model_budget_disabled':'assistant_model_budget_exhausted'})
    assert.equal(state.budgetCalls.length,1);assert.equal(state.plannerCalls.length,0);assert.equal(state.writeCalls.length,0);assert.equal(state.insideBudget,0)
    assert.equal(result.raw.includes('RAW_PRIVATE'),false)
  }
})

test('material tool runtime keeps source rights caller-scoped and generates only inside the durable budget',async()=>{
  const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness(),handler=runtime(MODEL_ENV)
  assert.equal(state.taskFactories.length,1);assert.equal(state.taskCalls.length,0);assert.equal(state.toolFactories.length,1)
  const result=await dispatch(handler,{route:'materials/explain',body:{requestId:REQUEST_ID,scope:{groupId:GROUP},materialId:DRAFT,question:'Поясни основну думку.'}})
  assert.equal(result.status,200);assert.equal(result.body.userId,USER);assert.equal(result.body.sources[0].id,DRAFT)
  assert.equal(state.taskCalls.length,1);assert.equal(state.budgetCalls.length,1);assert.equal(state.plannerCalls.length,0)
  assert.deepEqual(state.materialCalls.map(c=>c.operation),['content','recheck'])
  assert.ok(state.materialCalls.every(c=>c.credential===TOKEN));assert.equal(state.writeCalls.length,0);assert.equal(state.journalOperations.length,0)
  const {signal,...data}=state.taskCalls[0]
  assert.ok(signal instanceof AbortSignal);assert.equal(state.budgetCalls[0].request.contextHash,crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'))
  for(const secret of[TOKEN,USER,GROUP,MODEL_KEY,ENV.SUPABASE_SERVICE_ROLE_KEY])assert.equal(JSON.stringify(data).includes(secret),false)
  assert.ok(state.callerOperations.every(r=>r.client.key===ENV.SUPABASE_ANON_KEY&&r.client.options.global.headers.Authorization===`Bearer ${TOKEN}`))
})

test('teacher question recognition uses caller-scoped authorization and the existing durable budget without creating drafts', async () => {
  const { createAssistantCloudRuntime: runtime, state } = await runtimeHarness(), handler = runtime(MODEL_ENV)
  const route = 'tests/import-preview', sourceText = '1) Синтетичне запитання для есе'
  const body = { requestId: REQUEST_ID, courseId: SUBJECT, sourceText, consent: true }
  assert.equal((await dispatch(handler, { route, body })).status, 403)
  assert.equal(state.budgetCalls.length, 0)
  state.importWorkspace = { teacher_status: { has_current_access: false }, courses: [{ id: SUBJECT, permissions: ['assignments'], archived_at: null }] }
  assert.equal((await dispatch(handler, { route, body })).status, 403)
  assert.equal(state.budgetCalls.length, 0)
  state.importWorkspace.teacher_status.has_current_access = true
  assert.equal((await dispatch(handler, { route, body: { ...body, consent: false } })).status, 400)
  assert.equal((await dispatch(handler, { route, body: { ...body, image: 'AAAA' } })).status, 400)
  assert.equal((await dispatch(handler, { route, body, headers: { origin: 'https://other.example' } })).status, 403)
  assert.equal(state.budgetCalls.length, 0)
  state.budgetMode = 'exhausted'
  assert.equal((await dispatch(handler, { route, body })).status, 429)
  assert.equal(state.taskCalls.length, 0)
  state.budgetMode = 'allow'
  const result = await dispatch(handler, { route, body })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { userId: USER, draftText: '1. Синтетичне запитання\nТип: есе', notes: [] })
  assert.equal(result.headers['cache-control'], 'private, no-store, max-age=0')
  assert.equal(state.taskCalls.length, 1)
  assert.deepEqual(state.taskCalls[0].data, { source: sourceText })
  assert.ok(state.callerOperations.filter(row => row.name === 'xelay_teaching_workspace').every(row =>
    row.client.key === ENV.SUPABASE_ANON_KEY && row.client.options.global.headers.Authorization === `Bearer ${TOKEN}`))
  assert.equal(state.writeCalls.length, 0)
  assert.equal(state.journalOperations.length, 0)
})

test('task budget failure blocks provider and arbitrary file paths never reach material or private-byte ports',async()=>{
  for(const mode of ['disabled','exhausted']){
    const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness(),handler=runtime(MODEL_ENV);state.budgetMode=mode
    const result=await dispatch(handler,{route:'materials/explain',body:{requestId:REQUEST_ID,scope:{groupId:GROUP},materialId:DRAFT}})
    assert.equal(result.status,mode==='disabled'?503:429);assert.equal(state.taskCalls.length,0);assert.equal(state.writeCalls.length,0);assert.equal(state.outbound.length,0)
  }
  const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness(),handler=runtime(MODEL_ENV)
  const result=await dispatch(handler,{route:'materials/explain',body:{requestId:REQUEST_ID,scope:{groupId:GROUP},materialId:DRAFT,path:'https://169.254.169.254/metadata'}})
  assert.equal(result.status,400);assert.equal(state.materialCalls.length,0);assert.equal(state.budgetCalls.length,0)
})

test('private material byte capability pins project, bucket, descriptor size and suppresses redirects',async()=>{
  const {createAssistantCloudRuntime:runtime,state}=await runtimeHarness();runtime(ENV)
  const load=state.studyFactories[0].readStorageFile,path=`${GROUP}/${USER}/${DRAFT}.txt`
  for(const descriptor of [{bucket:'other',path,size:2},{bucket:'xelay-study-materials',path:'https://evil.invalid',size:2},{bucket:'xelay-study-materials',path,size:8*1024*1024+1}])await assert.rejects(load(descriptor),e=>e.code==='material_file_invalid')
  assert.equal(state.outbound.length,0)
  const bytes=await load({bucket:'xelay-study-materials',path,size:2})
  assert.equal(Buffer.from(bytes).toString(),'{}');assert.equal(state.outbound.length,1)
  const request=state.outbound[0];assert.equal(request.input,`${ENV.SUPABASE_URL}/storage/v1/object/authenticated/xelay-study-materials/${path}`)
  assert.equal(request.init.redirect,'error');assert.equal(request.init.headers.apikey,ENV.SUPABASE_SERVICE_ROLE_KEY)
  assert.equal(request.init.headers.authorization,`Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`)
  assert.equal(request.init.headers.authorization.includes(TOKEN),false)
})

test('runtime keeps caller JWT business access separate from the private service-only journal', async () => {
  const { createAssistantCloudRuntime: runtime, state } = await runtimeHarness()
  const handler = runtime(ENV)
  assert.equal(state.clients.length, 1); assert.equal(state.clients[0].key, ENV.SUPABASE_SERVICE_ROLE_KEY)
  assert.match(state.journal.confirmationSecret, /^[a-f0-9]{64}$/)
  assert.notEqual(state.journal.confirmationSecret, ENV.SUPABASE_SERVICE_ROLE_KEY)
  for (const route of ['catalog', 'drafts', 'read']) {
    const result = await dispatch(handler, { route, ...(route === 'read' ? { body: { topic: 'study', scope: {} } } : {}) })
    assert.equal(result.status, 200)
    assert.equal(result.raw.includes(ENV.SUPABASE_SERVICE_ROLE_KEY), false)
    assert.equal(result.raw.includes(state.journal.confirmationSecret), false)
  }
  assert.ok(state.journalOperations.length > 0); assert.ok(state.callerOperations.length > 0)
  assert.ok(state.journalOperations.every(row => row.client.key === ENV.SUPABASE_SERVICE_ROLE_KEY && !row.client.options.global.headers))
  assert.ok(state.callerOperations.every(row => row.client.key === ENV.SUPABASE_ANON_KEY && row.client.options.global.headers.Authorization === `Bearer ${TOKEN}`))
  assert.ok(state.clients.every(row => row.url === ENV.SUPABASE_URL && row.options.auth.persistSession === false && row.options.auth.autoRefreshToken === false && row.options.auth.detectSessionInUrl === false))
  await state.clients[0].options.global.fetch(ENV.SUPABASE_URL + '/rest/v1/fixture', { redirect: 'follow' })
  assert.equal(state.outbound.length, 1); assert.equal(state.outbound[0].init.redirect, 'error'); assert.ok(state.outbound[0].init.signal instanceof AbortSignal)
})

test('API entry point only constructs the reviewed inactive-by-default runtime', async () => {
  const source = await readFile(new URL('api/assistant.ts', ROOT), 'utf8')
  let factories = 0
  const handler = () => {}, module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require(name) { assert.equal(name, '../server/assistant-v2/cloudRuntime.ts'); return { createAssistantCloudRuntime() { factories++; return handler } } } })
  assert.equal(factories, 1); assert.equal(module.exports.default, handler)
})
