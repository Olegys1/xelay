import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiAssistantPlanner, ASSISTANT_OPENAI_MODEL, ASSISTANT_OPENAI_LIMITS, ASSISTANT_CHAT_PLANNER_SCHEMA, ASSISTANT_CHAT_PLANNER_INSTRUCTIONS } from '../../server/assistant-v2/cloudPlanner.ts'
import { createAssistantModelBudget, assistantModelCostMicrousd, ASSISTANT_MODEL_BUDGET_LIMITS } from '../../server/assistant-v2/modelBudget.ts'

// Fixed synthetic requests and fake HTTP streams only. No environment keys,
// SDK client, real service, local listener or provider network is accessed.
const KEY = ['sk', 'synthetic_planner_fixture_only_123456789012345'].join('-')
const sourceCopy = 'Якщо заняття відбудеться, розв’яжіть вправи 1–4. Інакше нічого не здавайте.\nОберіть або презентацію, або конспект. https://example.com/source'
const context = () => ({ now: '2026-10-31T23:30:00Z', timeZone: 'Europe/Kyiv', hasLearningGroup: true,
  subjects: [{ ref: 'subject1', name: 'Вища математика' }, { ref: 'subject2', name: 'Економічна теорія' }],
  courses: [{ ref: 'course1', name: 'Вища математика' }], scope: { period: 'current' },
  allowedKinds: ['homework', 'read', 'schedule', 'organizer', 'reply', 'clarify', 'unsupported'], allowedTopics: ['study', 'materials', 'results', 'teaching', 'gradebook'] })
const request = (patch = {}) => ({ message: 'Додай ДЗ по вишмату на завтра', teacherMessage: sourceCopy, history: [], context: context(), ...patch })
const homework = (patch = {}) => ({ kind: 'homework', subject: 'subject1', date: '2026-11-02', topic: 'Практичні вправи', ...patch })
const output = (intent = homework(), patch = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ intent }) }] }], usage: { input_tokens: 1200, output_tokens: 80 }, ...patch })
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
function harness(options = {}) {
  const state = { calls: [], moderationCalls: [], requests: [], next: () => jsonResponse(output()),
    nextModeration: () => jsonResponse({ results: [{ flagged: false, categories: { violence: false } }] }) }
  const planner = createOpenAiAssistantPlanner({ apiKey: KEY, enabled: true, billingApproved: true,
    fetchImpl: async (url, init) => {
      state.requests.push({url,init})
      if(url==='https://api.openai.com/v1/moderations'){state.moderationCalls.push({url,init});return state.nextModeration(url,init)}
      state.calls.push({ url, init }); return state.next(url, init)
    }, ...options })
  return { state, planner }
}
const denied = (operation, code) => assert.rejects(operation, error => error.code === code && error.message === code && !error.message.includes(KEY))
const posted = state => JSON.parse(state.calls[0].init.body)
const dataPart = state => JSON.parse(posted(state).input[0].content[0].text)

test('model requires explicit enabled and billing-approved flags before any provider request', async () => {
  for (const options of [{ enabled: undefined }, { enabled: false }, { billingApproved: undefined }, { billingApproved: false }, { enabled: 'true' }, { billingApproved: 'true' }]) {
    const h = harness(options); await denied(h.planner.plan(request()), 'model_not_connected'); assert.equal(h.state.requests.length, 0)
  }
  for (const apiKey of ['', 'not-a-provider-key', 'Bearer '+KEY, KEY+'\n']) {
    const h = harness({ apiKey }); await denied(h.planner.plan(request()), 'model_configuration_required'); assert.equal(h.state.requests.length, 0)
  }
})

test('one fixed Responses request is tool-free, non-stored, bounded and never exposes its key in URL or input', async () => {
  const h = harness(), result = await h.planner.plan(request({ endpoint: 'https://example.invalid/collect', actor: { role: 'admin' }, serviceRoleKey: 'PRIVATE_DO_NOT_FORWARD' }))
  assert.equal(h.state.calls.length, 1)
  const { url, init } = h.state.calls[0], wire = posted(h.state)
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
  assert.equal(init.headers.authorization, 'Bearer '+KEY); assert.equal(wire.model, ASSISTANT_OPENAI_MODEL)
  assert.equal(wire.model, 'gpt-5.4-mini'); assert.equal(wire.service_tier, 'default'); assert.equal(wire.store, false); assert.equal(wire.max_output_tokens, 4000)
  assert.ok(Buffer.byteLength(init.body)+512<=40000)
  assert.deepEqual(wire.reasoning, { effort: 'none' }); assert.equal(wire.text.format.type, 'json_schema'); assert.equal(wire.text.format.strict, true)
  assert.equal('tools' in wire, false); assert.equal('tool_choice' in wire, false); assert.equal('background' in wire, false)
  assert.equal(init.signal instanceof AbortSignal, true)
  assert.equal(init.body.includes(KEY), false); assert.equal(init.body.includes('PRIVATE_DO_NOT_FORWARD'), false); assert.equal(init.body.includes('example.invalid'), false)
  assert.equal(dataPart(h.state).teacherMessage, sourceCopy)
  assert.deepEqual(result, { intent: homework(), usage: { inputTokens: 1200, outputTokens: 80 } })
  assert.equal(h.state.moderationCalls.length,2)
  assert.deepEqual(h.state.requests.map(item=>item.url.split('/').at(-1)),['moderations','responses','moderations'])
  for(const {url,init}of h.state.moderationCalls){assert.equal(url,'https://api.openai.com/v1/moderations');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer '+KEY);assert.equal(init.body.includes(KEY),false);assert.equal(init.signal instanceof AbortSignal,true);assert.equal(JSON.parse(init.body).model,'omni-moderation-latest')}
  assert.deepEqual(JSON.parse(h.state.moderationCalls[0].init.body).input,JSON.stringify(dataPart(h.state)))
  assert.deepEqual(JSON.parse(h.state.moderationCalls[1].init.body).input,JSON.stringify(homework()))
})

test('strict conversation schema supports bounded replies and concrete clarifications without actions or private fields',async()=>{
  const alternatives=ASSISTANT_CHAT_PLANNER_SCHEMA.properties.intent.anyOf
  for(const [kind,maximum]of [['reply',1200],['clarify',600]]){
    const schema=alternatives.find(item=>item.properties.kind.enum[0]===kind)
    assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['kind','text'])
    assert.deepEqual(schema.properties.text,{type:'string',minLength:1,maxLength:maximum})
  }
  assert.match(ASSISTANT_CHAT_PLANNER_INSTRUCTIONS,/ПРИВІТ/)
  assert.match(ASSISTANT_CHAT_PLANNER_INSTRUCTIONS,/Привіт, покажи розклад на завтра/)
  assert.match(ASSISTANT_CHAT_PLANNER_INSTRUCTIONS,/не читай записи заради привітання/)
  assert.match(ASSISTANT_CHAT_PLANNER_INSTRUCTIONS,/одним конкретним доречним запитанням/)
  for(const [message,text]of [['ПРИВІТ','Привіт! Можу допомогти з навчальними справами у Xelay. З чого почнемо?'],['дякую','Будь ласка!'],['Що ти вмієш?','Можу показати розклад і ДЗ, знайти матеріали та допомогти підготувати чернетку особистої справи.']]){
    const h=harness();h.state.next=()=>jsonResponse(output({kind:'reply',text}))
    const result=await h.planner.plan(request({message,teacherMessage:undefined}))
    assert.deepEqual(result.intent,{kind:'reply',text});assert.equal(h.state.calls.length,1);assert.equal(h.state.moderationCalls.length,2)
  }
  const h=harness(),text='Ви хочете переглянути матеріал чи підготувати новий для своєї групи?'
  h.state.next=()=>jsonResponse(output({kind:'clarify',text}))
  assert.deepEqual((await h.planner.plan(request({message:'допоможи з матеріалом',teacherMessage:undefined}))).intent,{kind:'clarify',text})
})

test('conversation text cannot smuggle links, markup, code, private identifiers or completed writes through a reply',async()=>{
  for(const kind of ['reply','clarify'])for(const text of [' ','x'.repeat(kind==='reply'?1201:601),'Привіт\u0000','Перейдіть https://example.com/confirm','www.example.com','<img src=x onerror=alert(1)>','```js\nalert(1)\n```','Ваша група 10000000-0000-4000-8000-000000000001','ДЗ збережено.']){
    const h=harness();h.state.next=()=>jsonResponse(output({kind,text}))
    await denied(h.planner.plan(request()),'model_invalid_response')
  }
  for(const intent of [{kind:'reply',text:'Привіт!',action:'homework.upsert'},{kind:'reply',text:'Привіт!',groupId:null},{kind:'reply',text:'Привіт!',confirmation:true}]){
    const h=harness();h.state.next=()=>jsonResponse(output(intent));await denied(h.planner.plan(request()),'model_invalid_response')
  }
  const deniedKind=harness();deniedKind.state.next=()=>jsonResponse(output({kind:'reply',text:'Привіт!'}))
  await denied(deniedKind.planner.plan(request({context:{...context(),allowedKinds:['read','clarify','unsupported']}})),'model_invalid_response')
})

test('a greeting containing a concrete schedule request can still return the scoped read intent',async()=>{
  const h=harness(),intent={kind:'read',topic:'study',subject:null,courseRef:null,date:'2026-11-02'}
  h.state.next=()=>jsonResponse(output(intent))
  assert.deepEqual((await h.planner.plan(request({message:'Привіт, покажи розклад на завтра',teacherMessage:undefined}))).intent,{kind:'read',topic:'study',date:'2026-11-02'})
})

test('flagged current input stops before the paid Responses call and flagged output is never returned',async()=>{
  for(const verdict of [{flagged:true,categories:{violence:false}},{flagged:false,categories:{violence:true}}]){
    const input=harness();input.state.nextModeration=()=>jsonResponse({results:[verdict]})
    await denied(input.planner.plan(request()),'model_refused');assert.equal(input.state.calls.length,0);assert.equal(input.state.moderationCalls.length,1)
    const output=harness();output.state.next=()=>jsonResponse({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({intent:{kind:'reply',text:'Привіт!'}})}]}],usage:{input_tokens:100,output_tokens:20}})
    output.state.nextModeration=()=>jsonResponse({results:[output.state.moderationCalls.length===1?{flagged:false,categories:{violence:false}}:verdict]})
    await denied(output.planner.plan(request()),'model_refused');assert.equal(output.state.calls.length,1);assert.equal(output.state.moderationCalls.length,2)
  }
})

test('unavailable or malformed safety checks fail closed before input dispatch or output delivery without retry',async()=>{
  const variants=[()=>jsonResponse({error:{message:'PRIVATE_PROVIDER_DATA '+KEY}},503),()=>{throw new Error('PRIVATE_PROVIDER_DATA '+KEY)},()=>jsonResponse({results:[]}),()=>jsonResponse({results:[{flagged:false}]}),()=>jsonResponse({results:[{flagged:'false',categories:{violence:false}}]}),()=>jsonResponse({results:[{flagged:false,categories:{violence:'false'}}]}),()=>jsonResponse({results:[{flagged:false,categories:{}}]}),()=>new Response('not-json')]
  for(const next of variants)for(const stage of ['input','output']){
    const h=harness();h.state.nextModeration=()=>stage==='output'&&h.state.moderationCalls.length===1?jsonResponse({results:[{flagged:false,categories:{violence:false}}]}):next()
    await denied(h.planner.plan(request()),'model_safety_unavailable')
    assert.equal(h.state.calls.length,stage==='input'?0:1);assert.equal(h.state.moderationCalls.length,stage==='input'?1:2)
  }
})

test('current command and copied teacher conditions are transmitted exactly without a model-generated replacement body', async () => {
  const h = harness(), original = request(), snapshot = structuredClone(original)
  await h.planner.plan(original)
  assert.deepEqual(original, snapshot)
  const supplied = dataPart(h.state)
  assert.equal(supplied.message, original.message); assert.equal(supplied.teacherMessage, sourceCopy)
  assert.match(supplied.teacherMessage, /Якщо/); assert.match(supplied.teacherMessage, /Інакше/); assert.match(supplied.teacherMessage, /або презентацію, або конспект/)
  h.state.next = () => jsonResponse(output(homework({ body: 'Rewritten task which was never authorized' })))
  await denied(h.planner.plan(request()), 'model_invalid_response')
})

test('only short public subject/course slots are sent, never extra profile, roster, grade or material fields', async () => {
  for (const patch of [{ roster: [{ email: 'PRIVATE_NOT_SENT' }] }, { grades: [{ points: 4 }] }, { actor: { id: 'PRIVATE_ID' } }, { protectedMaterials: [{ body: 'PRIVATE_MATERIAL' }] }, { credentials: KEY }]) {
    const h = harness(); await denied(h.planner.plan(request({ context: { ...context(), ...patch } })), 'model_context_invalid'); assert.equal(h.state.calls.length, 0)
  }
  for (const item of [{ ref: '10000000-0000-4000-8000-000000000001', name: 'Math' }, { ref: 'subject0', name: 'Math' }, { ref: 'subject1', name: 'Math', body: 'PRIVATE_MATERIAL' }]) {
    const h = harness(); await denied(h.planner.plan(request({ context: { ...context(), subjects: [item] } })), 'model_context_invalid'); assert.equal(h.state.calls.length, 0)
  }
})

test('invalid scope slots, calendar dates, duplicate references and non-string allowed kinds fail before fetch', async () => {
  const patches = [
    { scope: { period: 'current', date: '2026-02-31' } }, { scope: { period: 'current', subjectRef: 'subject99' } },
    { scope: { period: 'current', courseRef: 'course99' } }, { scope: { period: 'private' } },
    { subjects: [{ ref: 'subject1', name: 'Math' }, { ref: 'subject1', name: 'Duplicate' }] },
    { courses: [{ ref: 'subject1', name: 'Wrong namespace' }] },
    { allowedKinds: ['confirm'] }, { allowedTopics: ['private-admin-data'] },
    { allowedActions:['payments.charge'] }, {allowedActions:[{toString(){return 'seminar.book'}}]},
    { allowedKinds: [{ toString() { return 'read' } }] }, { allowedTopics: [{ toString() { return 'study' } }] },
    { timeZone: 'UTC' }, { now: 'not-a-time' },
  ]
  for (const patch of patches) { const h = harness(); await denied(h.planner.plan(request({ context: { ...context(), ...patch } })), 'model_context_invalid'); assert.equal(h.state.calls.length, 0) }
  const h = harness(); await h.planner.plan(request({ context: { ...context(), scope: { date: '2028-02-29', period: 'current' } } })); assert.equal(h.state.calls.length, 1)
})

test('historical assistant or system content cannot send private read results back to the provider', async () => {
  for (const role of ['assistant', 'system', 'tool']) {
    const h = harness(); await denied(h.planner.plan(request({ history: [{ role, content: 'PRIVATE_GRADE_OR_FILE_CONTENT' }] })), 'model_context_invalid'); assert.equal(h.state.calls.length, 0)
  }
  const h = harness(), history = [{ role: 'user', content: 'Які завтра пари?' }]
  await h.planner.plan(request({ history })); assert.deepEqual(dataPart(h.state).history, history)
})

test('the UTF-8 input upper bound removes only whole old user messages and preserves current copy byte-for-byte', async () => {
  const h = harness(), history = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: String(i)+':'+String(i).repeat(5998) }))
  const current = 'Поточний запит '+ 'x'.repeat(5000), copy = sourceCopy+' '+ 'y'.repeat(5500)
  await h.planner.plan(request({ message: current, teacherMessage: copy, history }))
  assert.ok(Buffer.byteLength(h.state.calls[0].init.body) <= ASSISTANT_OPENAI_LIMITS.wireBytes)
  assert.ok(Buffer.byteLength(h.state.calls[0].init.body)+512 <= ASSISTANT_OPENAI_LIMITS.inputTokens)
  const sent = dataPart(h.state)
  assert.equal(sent.message, current); assert.equal(sent.teacherMessage, copy)
  assert.ok(sent.history.length < history.length); assert.ok(sent.history.length > 0)
  assert.deepEqual(sent.history, history.slice(-sent.history.length))
  assert.equal(ASSISTANT_OPENAI_LIMITS.wireBytes, 48000); assert.equal(ASSISTANT_OPENAI_LIMITS.outputTokens, 4000)
  assert.equal(ASSISTANT_OPENAI_LIMITS.inputTokens, 40000); assert.equal(ASSISTANT_OPENAI_LIMITS.inputTokens, ASSISTANT_MODEL_BUDGET_LIMITS.inputTokens)
  assert.equal(ASSISTANT_OPENAI_LIMITS.reservedMicrousd, 50000); assert.equal(ASSISTANT_OPENAI_LIMITS.attempts, 1)
})

test('multibyte teacher text remains complete while old history is dropped to fit the input budget',async()=>{
  const h=harness(),history=Array.from({length:6},(_,i)=>({role:'user',content:String(i)+':'+String(i).repeat(5998)}))
  const current='Поточний запит '+ 'x'.repeat(3000),copy='Якщо є змога, опрацюйте весь текст:\n'+'漢'.repeat(5000)+'\nІнакше нічого не здавайте.'
  const original=request({message:current,teacherMessage:copy,history}),snapshot=structuredClone(original)
  assert.ok(copy.length<=10000&&Buffer.byteLength(copy)>copy.length)
  await h.planner.plan(original)
  const sent=dataPart(h.state)
  assert.equal(sent.message,current);assert.equal(sent.teacherMessage,copy);assert.deepEqual(original,snapshot)
  assert.ok(sent.history.length>0&&sent.history.length<history.length)
  assert.deepEqual(sent.history,history.slice(-sent.history.length))
  assert.ok(Buffer.byteLength(h.state.calls[0].init.body)+512<=40000)
})

test('an over-budget current teacher copy is rejected without truncating it or making a paid request', async () => {
  const h = harness(), original = request({ message: '漢'.repeat(6000), teacherMessage: '漢'.repeat(10000),history:[] }), snapshot = structuredClone(original)
  await denied(h.planner.plan(original), 'model_context_too_large'); assert.equal(h.state.calls.length, 0); assert.deepEqual(original, snapshot)
})

test('a current multibyte request exceeding the new token upper bound is rejected before fetch even below the old wire cap',async()=>{
  const h=harness(),baseline=harness(),original=request({message:'漢'.repeat(4500),teacherMessage:'界'.repeat(6500),history:[]}),snapshot=structuredClone(original)
  // Obtain only the fixed synthetic envelope from a small mocked request, then
  // measure the proposed current copy. This distinguishes the new 40k bound
  // from the old 48k wire cap without executing the oversized model request.
  await baseline.planner.plan(request())
  const envelope=posted(baseline.state),data=dataPart(baseline.state)
  envelope.input[0].content[0].text=JSON.stringify({...data,message:original.message,teacherMessage:original.teacherMessage,history:[]})
  const candidateBytes=Buffer.byteLength(JSON.stringify(envelope))
  assert.ok(candidateBytes<=48000);assert.ok(candidateBytes+512>40000)
  await denied(h.planner.plan(original),'model_context_too_large')
  assert.equal(h.state.calls.length,0);assert.deepEqual(original,snapshot)
})

test('already cancelled work does not fetch and cancellation during dispatch does not retry', async () => {
  const abort = new AbortController(); abort.abort()
  const h = harness(); await denied(h.planner.plan(request({ signal: abort.signal })), 'request_cancelled'); assert.equal(h.state.requests.length, 0)
  const active = new AbortController(), next = harness()
  next.state.next = () => { active.abort(); throw new Error('PRIVATE_UPSTREAM_TOKEN') }
  await denied(next.planner.plan(request({ signal: active.signal })), 'request_cancelled'); assert.equal(next.state.calls.length, 1)
  const beforeDispatch=new AbortController(),blocked=harness()
  blocked.state.nextModeration=()=>{beforeDispatch.abort();return jsonResponse({results:[{flagged:false,categories:{violence:false}}]})}
  await denied(blocked.planner.plan(request({signal:beforeDispatch.signal})),'request_cancelled')
  assert.equal(blocked.state.calls.length,0);assert.equal(blocked.state.moderationCalls.length,1)
})

test('provider failures are redacted, classified and never retried or followed to another endpoint', async () => {
  for (const [status, code] of [[401,'model_configuration_required'],[403,'model_configuration_required'],[402,'model_balance_required'],[429,'model_rate_limited'],[500,'model_unavailable'],[503,'model_unavailable'],[302,'model_unavailable']]) {
    const h = harness(); h.state.next = () => jsonResponse({ error: { message: 'PRIVATE_PROVIDER_DATA '+KEY } }, status)
    await denied(h.planner.plan(request()), code); assert.equal(h.state.calls.length, 1)
  }
  const h = harness(); h.state.next = () => { throw new Error('PRIVATE_PROVIDER_DATA '+KEY) }
  await denied(h.planner.plan(request()), 'model_unavailable'); assert.equal(h.state.calls.length, 1)
})

test('incomplete, malformed or non-assistant provider messages never become intents', async () => {
  const values = [
    output(homework(), { status: 'incomplete' }), output(homework(), { status: 'in_progress' }),
    output(homework(), { output: null }), output(homework(), { usage: null }),
    output(homework(), { output: [{ type: 'function_call', name: 'write_database', arguments: '{}' }] }),
    output(homework(), { output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: '{}' }] }] }),
    output(homework(), { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not-json' }] }] }),
  ]
  for (const value of values) { const h = harness(); h.state.next = () => jsonResponse(value); await denied(h.planner.plan(request()), 'model_invalid_response'); assert.equal(h.state.calls.length, 1) }
  const h = harness(); h.state.next = () => new Response('<html>PRIVATE_UPSTREAM_DATA</html>')
  await denied(h.planner.plan(request()), 'model_invalid_response')
})

test('refusals remain distinct safe failures and cannot be converted to a fabricated successful action', async () => {
  const h = harness(); h.state.next = () => jsonResponse(output(homework(), { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL_DETAIL' }] }] }))
  await denied(h.planner.plan(request()), 'model_refused'); assert.equal(h.state.calls.length, 1)
})

test('oversized advertised or streamed responses are bounded and the oversized stream is cancelled', async () => {
  for (const length of ['-1','invalid','128001']) {
    const h = harness(); h.state.next = () => jsonResponse(output(), 200, { 'content-length': length })
    await denied(h.planner.plan(request()), 'model_invalid_response'); assert.equal(h.state.calls.length, 1)
  }
  let cancelled = false
  const h = harness(); h.state.next = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128001)) }, cancel() { cancelled = true } }))
  await denied(h.planner.plan(request()), 'model_invalid_response'); assert.equal(cancelled, true); assert.equal(h.state.calls.length, 1)
})

test('usage counters must be finite safe integer telemetry rather than arbitrary malformed provider values', async () => {
  for (const usage of [{ input_tokens: -1, output_tokens: 1 }, { input_tokens: '1', output_tokens: 1 }, { input_tokens: 2000001, output_tokens: 1 }, { input_tokens: 1, output_tokens: 2000001 }, { input_tokens: 1, output_tokens: 1.5 }, { input_tokens: 1 }]) {
    const h = harness(); h.state.next = () => jsonResponse(output(homework(), { usage })); await denied(h.planner.plan(request()), 'model_invalid_response')
  }
})

test('only the default service tier is requested and unexpected response tiers cannot be priced as standard', async () => {
  const h = harness(); h.state.next = () => jsonResponse(output(homework(), { service_tier: 'default' }))
  await h.planner.plan(request()); assert.equal(posted(h.state).service_tier, 'default')
  for (const service_tier of ['priority', 'flex', 'auto', null, 0]) {
    const next = harness(); next.state.next = () => jsonResponse(output(homework(), { service_tier }))
    await denied(next.planner.plan(request()), 'model_invalid_response'); assert.equal(next.state.calls.length, 1)
  }
})

test('valid over-limit telemetry reaches accounting and the budget halts before returning any model intent', async () => {
  // This proves application accounting and post-call halt, not a global cap on
  // the provider account or the behaviour of a provider reporting bad usage.
  const owner = '10000000-0000-4000-8000-000000000001', requestId = '10000000-0000-4000-8000-000000000002', stamp = Date.now()
  const remaining = { dayMicrousd: 100000, monthMicrousd: 100000, userDayRequests: 1 }
  for (const usage of [{ inputTokens: 40001, outputTokens: 80 }, { inputTokens: 1200, outputTokens: 4001 }, { inputTokens: 70000, outputTokens: 4000 }]) {
    const h = harness(), finishes = []
    h.state.next = () => jsonResponse(output(homework(), { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, service_tier: 'default' }))
    const ledger = { mode: 'private-model-budget',
      async reserve() { return { allowed: true, reused: false, userId: owner, requestId, state: 'reserved', reservedMicrousd: 50000, expiresAt: new Date(stamp + 60000).toISOString(), remaining } },
      async finish(userId, binding, claimHash, outcome, actualUsage) {
        finishes.push({ userId, binding, outcome, actualUsage })
        return { finished: true, requestId, reused: false, state: 'over_limit', halted: true, chargedMicrousd: Math.max(50000, assistantModelCostMicrousd(actualUsage)), remaining }
      } }
    const budget = createAssistantModelBudget({ ledger, now: () => stamp, verifySession: async () => ({ userId: owner, accountActive: true, emailConfirmed: true, expiresAt: new Date(stamp+120000).toISOString(), sessionId: 'synthetic-session' }) })
    await denied(budget.run('synthetic-owner-credential-only', { requestId, contextHash: 'a'.repeat(64) }, async () => { const planned = await h.planner.plan(request()); return { value: planned.intent, usage: planned.usage } }), 'assistant_model_budget_halted')
    assert.equal(h.state.calls.length, 1); assert.equal(finishes.length, 1)
    assert.deepEqual(finishes[0].actualUsage, usage); assert.equal(finishes[0].outcome, 'succeeded')
  }
})

test('unknown output fields are rejected even when null and output dates must be actual calendar days', async () => {
  for (const intent of [homework({ adminOverride: null }), homework({ body: null }), homework({ groupId: null }), homework({ confirmation: true }), homework({ date: '2026-02-31' }), homework({ date: 'tomorrow' })]) {
    const h = harness(); h.state.next = () => jsonResponse(output(intent)); await denied(h.planner.plan(request()), 'model_invalid_response')
  }
  const h = harness(); h.state.next = () => jsonResponse(output(homework(), { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ intent: homework(), unexpected: null }) }] }] }))
  await denied(h.planner.plan(request()), 'model_invalid_response')
})

test('allowed action/topic boundaries and course slots cannot be expanded by a model response', async () => {
  const cases = [
    [homework(), { allowedKinds: ['read','clarify','unsupported'] }],
    [{ kind: 'read', topic: 'gradebook', courseRef: 'course1', subject: null, date: null }, { allowedTopics: ['study','materials','results'] }],
    [{ kind: 'read', topic: 'teaching', courseRef: 'course99', subject: null, date: null }, {}],
    [{ kind: 'confirm', id: 'some-draft' }, {}],
    [{ kind: 'clarify', text: ' ' }, {}],
  ]
  for (const [intent, patch] of cases) { const h = harness(); h.state.next = () => jsonResponse(output(intent)); await denied(h.planner.plan(request({ context: { ...context(), ...patch } })), 'model_invalid_response') }
})

test('valid nullable fields are omitted from intents while no private response metadata escapes', async () => {
  const h = harness(); h.state.next = () => jsonResponse(output(homework({ subject: null, date: null, topic: null }), { id: 'PRIVATE_PROVIDER_RESPONSE_ID', metadata: { secret: KEY } }))
  const result = await h.planner.plan(request())
  assert.deepEqual(result, { intent: { kind: 'homework' }, usage: { inputTokens: 1200, outputTokens: 80 } })
  assert.equal(JSON.stringify(result).includes(KEY), false); assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER'), false)
})
