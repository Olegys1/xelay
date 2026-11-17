import test from'node:test'
import assert from'node:assert/strict'
import{readFileSync}from'node:fs'
import path from'node:path'
import{fileURLToPath}from'node:url'
import vm from'node:vm'
import ts from'typescript'

const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module)
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,TextEncoder,TextDecoder,Uint8Array,AbortController,Response,URL,Date,JSON,Map,Set,Promise,Number,Math,setTimeout,clearTimeout,require(name){if(name.endsWith('.js'))name=name.slice(0,-3);if(name.startsWith('.'))return load(path.resolve(path.dirname(absolute),name)+'.ts');throw Error('Unexpected dependency '+name)}});return module.exports}
const a=load('src/lib/maxTutor.ts'),client=load('src/lib/maxTutorProductionClient.ts'),local=load('src/lib/maxTutorLocalClient.ts'),provider=load('server/student-learning/maxTutorOpenAi.ts'),copy=v=>JSON.parse(JSON.stringify(v))
const source={id:'own-note',title:'Мій конспект',text:'Підготовка визначає мету. Виконання створює результат. Перевірка порівнює результат із метою.',page:null,kind:'own_note'}
function fixture(format){
 const request={requestId:'study-'+format,mode:a.tutorStudyMode(format),prompt:'Допоможи підготуватися за власним конспектом.',sources:[source],studyFormat:format}
 const study={format,gaps:[],reading:[],written:[],dialogue:[]},bundle={version:2,mode:request.mode,title:'Особиста вправа',introduction:'Потренуємося за конспектом.',steps:[{title:'Початок',body:'Прочитай умову й обраний матеріал.'}],questions:[],cards:[],plan:[],math:null,citations:[{sourceId:source.id,quote:source.text}],study}
 if(format==='true_false')bundle.questions=[{id:'tf-one',text:'Підготовка визначає мету.',options:['Правда','Неправда'],correctIndex:0,explanation:'Це зазначено в конспекті.',sourceId:source.id}]
 if(format==='gap_fill')study.gaps=[{id:'gap-one',before:'Перший етап — ',after:'.',acceptedAnswers:['Підготовка'],explanation:'Підготовка визначає мету.',sourceId:source.id}]
 if(format==='smart_text')study.reading=[{id:'read-one',text:'Підготовка визначає мету.',terms:[{term:'Підготовка',explanation:'Перший етап.'}],sourceId:source.id}]
 if(format==='written'||format==='exercise')study.written=[{id:'write-one',prompt:'Поясни роль підготовки.',criteria:['Зазначено визначення мети'],modelAnswer:'Підготовка визначає мету проєкту.',sourceId:source.id}]
 if(format==='podcast')study.dialogue=[{id:'voice-one',speaker:'student',text:'Навіщо потрібна підготовка?',sourceId:source.id},{id:'voice-two',speaker:'tutor',text:'Щоб визначити мету.',sourceId:source.id}]
 return{request,bundle}
}

test('all six real formats validate with explicit metadata and retain source and mode limits',()=>{
 for(const format of a.TUTOR_STUDY_FORMATS){const{request,bundle}=fixture(format);assert.equal(a.validateTutorRequest(request).studyFormat,format);assert.equal(a.validateTutorBundle(bundle,request).study.format,format)
  assert.doesNotThrow(()=>a.validateTutorRequest({...request,sources:[]}));assert.throws(()=>a.validateTutorRequest({...request,mode:'chat'}))
  assert.throws(()=>a.validateTutorBundle({...bundle,version:1},request));assert.throws(()=>a.validateTutorBundle({...bundle,study:{...bundle.study,format:'other'}},request))
 }
})

test('all study formats accept a topic alone without fabricating source IDs or quotations',()=>{
 for(const format of a.TUTOR_STUDY_FORMATS){const{request,bundle}=fixture(format);request.sources=[];request.prompt='Попит і пропозиція';bundle.citations=[]
  for(const item of [...bundle.questions,...bundle.study.gaps,...bundle.study.reading,...bundle.study.written,...bundle.study.dialogue])item.sourceId=''
  assert.equal(a.validateTutorBundle(bundle,request).study.format,format)
  const invented=copy(bundle);invented.citations=[{sourceId:'',quote:'Not a supplied source'}];assert.throws(()=>a.validateTutorBundle(invented,request))
  const item=[...bundle.questions,...bundle.study.gaps,...bundle.study.reading,...bundle.study.written,...bundle.study.dialogue][0];item.sourceId='foreign';assert.throws(()=>a.validateTutorBundle(bundle,request))
 }
})
test('malformed source IDs, hidden grades, invented terms, duplicate IDs and fake answer keys cannot enter a version2 artifact',()=>{
 const{request,bundle}=fixture('gap_fill')
 for(const change of[
  g=>{g.sourceId='foreign'},g=>{g.acceptedAnswers=['Invented answer']},g=>{g.before='<script>evil</script>'},g=>{g.acceptedAnswers=['Підготовка',' підготовка ']},g=>{g.id='constructor'},g=>{g.aiScore=100},
 ]){const bad=copy(bundle);change(bad.study.gaps[0]);assert.throws(()=>a.validateTutorBundle(bad,request))}
 const reading=fixture('smart_text');reading.bundle.study.reading[0].terms[0].term='Термін, якого немає';assert.throws(()=>a.validateTutorBundle(reading.bundle,reading.request))
 const tf=fixture('true_false');tf.bundle.questions[0].options=['Так','Ні'];assert.throws(()=>a.validateTutorBundle(tf.bundle,tf.request))
})
test('gap answers normalize supported typing differences, save zero-correct results and lock submitted text',()=>{
 const{bundle}=fixture('gap_fill');let progress=a.emptyTutorProgress(bundle)
 assert.equal(progress.version,2);assert.equal(a.submitTutorStudy(progress,bundle,'gap-one'),progress)
 progress=a.answerTutorStudy(progress,bundle,'gap-one',' ПІДГОТОВКА ');progress=a.submitTutorStudy(progress,bundle,'gap-one')
 assert.deepEqual(copy(a.tutorStudyResult(bundle,progress)),{answered:1,total:1,correct:1,mistakes:[],writtenSubmitted:0,writtenTotal:0})
 assert.equal(a.answerTutorStudy(progress,bundle,'gap-one','Виконання'),progress)
 let wrong=a.answerTutorStudy(a.emptyTutorProgress(bundle),bundle,'gap-one','Виконання');wrong=a.submitTutorStudy(wrong,bundle,'gap-one');assert.equal(a.tutorStudyResult(bundle,wrong).correct,0);assert.deepEqual(copy(a.tutorStudyResult(bundle,wrong).mistakes),['gap-one'])
 assert.equal(a.normalizeTutorPracticeAnswer('  обʼєкт  '),a.normalizeTutorPracticeAnswer("ОБ'ЄКТ"))
})
test('written practice is explicitly self-assessed; saved answer feedback contains submitted text but no hidden model answer',()=>{
 const{request,bundle}=fixture('written');let progress=a.emptyTutorProgress(bundle)
 assert.equal(a.rateTutorStudy(progress,bundle,'write-one','known'),progress)
 progress=a.answerTutorStudy(progress,bundle,'write-one','Моя відповідь: визначити мету.');progress=a.submitTutorStudy(progress,bundle,'write-one');progress=a.rateTutorStudy(progress,bundle,'write-one','repeat')
 assert.equal(a.tutorStudyResult(bundle,progress).writtenSubmitted,1);assert.equal(progress.studyRatings['write-one'],'repeat');assert.equal(progress.aiScore,undefined)
 const run={id:request.requestId,createdAt:new Date().toISOString(),demo:false,request,bundle:{...bundle,study:{...bundle.study,written:[{...bundle.study.written[0],modelAnswer:'HIDDEN_MODEL_ANSWER'}]}},progress}
 const prompt=local.buildTutorPersonalFollowUp(run,'explain');assert.match(prompt,/Моя відповідь/);assert.match(prompt,/Критерії/);assert.match(prompt,/не офіційне оцінювання/);assert.doesNotMatch(prompt,/HIDDEN_MODEL_ANSWER/);assert.ok(prompt.length<=2400)
})
test('version2 text progress rejects unknown items, extra scores and premature self-ratings and is included in outbox signatures',()=>{
 const{bundle}=fixture('exercise'),empty=a.emptyTutorProgress(bundle),next=a.answerTutorStudy(empty,bundle,'write-one','Власна відповідь')
 for(const invalid of[{...empty,studyAnswers:{foreign:'secret'}},{...empty,studyRatings:{'write-one':'known'}},{...empty,studyDone:['foreign']},{...empty,studySubmitted:['write-one']},{...empty,studyAnswers:{'write-one':'<img src=x>'}},{...empty,aiScore:100}])assert.throws(()=>client.validateProductionProgress(invalid,{bundle}))
 assert.notEqual(client.productionProgressSignature(empty),client.productionProgressSignature(next));assert.equal(client.productionProgressExtends(next,empty),false)
 const submitted=a.submitTutorStudy(next,bundle,'write-one');assert.equal(client.productionProgressExtends(next,submitted),true)
})
test('version1 remains exact while version2 history restores text answers and reading/audio completion',()=>{
 const old=a.createTutorDemo('legacy-quiz','quiz');assert.deepEqual(copy(a.emptyTutorProgress()),{answers:{},submitted:[],cardRatings:{},doneTasks:[]})
 const{request,bundle}=fixture('written');let progress=a.submitTutorStudy(a.answerTutorStudy(a.emptyTutorProgress(bundle),bundle,'write-one','Визначають мету.'),bundle,'write-one')
 const runs=[{id:'legacy-quiz',createdAt:new Date().toISOString(),demo:false,...old,progress:a.emptyTutorProgress()},{id:request.requestId,createdAt:new Date().toISOString(),demo:false,request,bundle,progress}]
 const restored=a.parseTutorState(a.storeTutorState({version:1,runs,activeRunId:request.requestId}));assert.equal(restored.runs.length,2);assert.deepEqual(copy(restored.runs[1].progress),copy(progress));assert.equal(restored.runs[0].bundle.version,1)
 for(const[format,id]of[['smart_text','read-one'],['podcast','voice-two']]){const f=fixture(format),p=a.toggleTutorStudyDone(a.emptyTutorProgress(f.bundle),f.bundle,id);assert.deepEqual(copy(p.studyDone),[id]);assert.deepEqual(copy(a.toggleTutorStudyDone(p,f.bundle,id).studyDone),[])}
})
test('eight long offline written sessions reload losslessly, while invalid or oversized queues retain an exportable original',()=>{
 const runs=[];const items={}
 for(let index=0;index<8;index++){
  const f=fixture('written');f.request.requestId='long-written-'+index;f.bundle.study.written=Array.from({length:4},(_,i)=>({...f.bundle.study.written[0],id:'written-'+i}))
  const run={id:f.request.requestId,createdAt:new Date().toISOString(),demo:false,request:f.request,bundle:f.bundle,progress:a.emptyTutorProgress(f.bundle),revision:0};runs.push(run)
  let progress=run.progress;for(const item of run.bundle.study.written)progress=a.answerTutorStudy(progress,run.bundle,item.id,'ї'.repeat(4000))
  items[run.id]={revision:0,progress:client.validateProductionProgress(progress,run)}
 }
 const history={scope:{userId:'owner',sessionId:'session'},runs,activeRunId:runs[0].id},raw=JSON.stringify({version:1,ownerId:'owner',items});assert.ok(raw.length>100000)
 const restored=client.restoreProductionProgress(history,raw);assert.equal(restored.conflict,false);assert.equal(restored.recoveryRaw,null);assert.equal(Object.keys(restored.pending).length,8)
 for(const run of restored.state.runs)for(const answer of Object.values(run.progress.studyAnswers))assert.equal(answer,'ї'.repeat(4000))
 for(const invalid of['broken json',' '.repeat(client.MAX_PRODUCTION_PROGRESS_OUTBOX_BYTES+1),JSON.stringify({version:1,ownerId:'owner',items:{[runs[0].id]:{revision:0,progress:{...items[runs[0].id].progress,aiScore:100}}}})]){
  const failed=client.restoreProductionProgress(history,invalid);assert.equal(failed.conflict,true);assert.equal(failed.recoveryRaw,invalid)
 }
})
test('gap grounding uses the same exact literal spelling as SQL, while submitted answers retain forgiving comparison',()=>{
 const f=fixture('gap_fill');f.request.sources=[{...source,text:"З'ясування мети."}];f.bundle.citations=[{sourceId:source.id,quote:"З'ясування мети."}]
 f.bundle.study.gaps[0].acceptedAnswers=['з’ясування'];assert.throws(()=>a.validateTutorBundle(f.bundle,f.request))
 f.bundle.study.gaps[0].acceptedAnswers=["З'ясування"];assert.equal(a.validateTutorBundle(f.bundle,f.request).version,2)
 const progress=a.submitTutorStudy(a.answerTutorStudy(a.emptyTutorProgress(f.bundle),f.bundle,'gap-one',' з’ясування '),f.bundle,'gap-one');assert.equal(a.tutorStudyResult(f.bundle,progress).correct,1)
})
test('the actual production wrapper quarantines a broken outbox without overwriting it and exports its original bytes',async()=>{
 const raw='{"version":1,"ownerId":"owner","items":BROKEN_LOCAL_ANSWERS}',key='xelay:max:tutor-progress-outbox:owner:v1',storage=new Map([[key,raw]]),cells=[],effects=[],writes=[],downloads=[];let at=0,exported
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
 const hooks={useState(value){const i=at++;if(!cells[i])cells[i]={value:typeof value==='function'?value():value};return[cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}]},useRef(value){return cells[at++]??={current:value}},useMemo(fn,deps){const i=at++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn()};return cells[i].value},useEffect(fn,deps){const i=at++;if(!cells[i]||!same(cells[i].deps,deps)){cells[i]={deps};effects.push(fn)}}};hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps)
 const jsx=(type,props,key)=>({type,props:props||{},key}),module={exports:{}},child=()=>null,scope={userId:'owner',sessionId:'session'},history={scope,runs:[],activeRunId:''}
 const compiled=ts.transpileModule(readFileSync(path.join(root,'src/components/student/ProductionMaxTutorAssistant.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 vm.runInNewContext(compiled,{module,exports:module.exports,Map,Set,JSON,Date,Number,Math,Intl,Promise,Blob,AbortController,URL:{createObjectURL(blob){exported=blob;return'blob:synthetic'},revokeObjectURL(){}},document:{createElement(){return{click(){downloads.push(this.download)}}}},localStorage:{getItem:k=>storage.get(k)??null,setItem(k,v){writes.push(v);storage.set(k,v)},removeItem:k=>storage.delete(k)},window:{addEventListener(){},removeEventListener(){},confirm:()=>false},setTimeout:()=>1,clearTimeout(){},require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name==='lucide-react')return new Proxy({},{get:(_,id)=>String(id)});if(name==='../../lib/maxTutorProductionClient')return client;if(name==='./MaxTutorAssistant')return{MaxTutorAssistant:child};throw Error('Unexpected '+name)}})
 const props={status:{scope,canEdit:true,canGenerate:true,budget:{limitUsd:10,remainingUsd:10},budgetResetsAt:null},client:{history:async()=>history,progress:async()=>{throw Error('Quarantined progress must not be sent')}}}
 const render=()=>{at=0;return module.exports.ProductionMaxTutorAssistant(props)},nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)],text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(''):typeof node==='object'?text(node.props?.children):String(node)
 render();const cleanup=effects.shift()();await Promise.resolve();await Promise.resolve();const tree=render(),all=nodes(tree)
 assert.match(text(tree),/оригінал залишено на пристрої/);assert.equal(all.find(n=>n.type===child).props.enabled,false);assert.equal(all.find(n=>n.type===child).props.transport,undefined)
 all.find(n=>n.type==='button'&&text(n).includes('Копія відповідей')).props.onClick();assert.equal(await exported.text(),raw);assert.equal(downloads.length,1)
 all.find(n=>n.type==='button'&&text(n).includes('Оновити стан')).props.onClick();assert.equal(storage.get(key),raw);cleanup();assert.equal(storage.get(key),raw);assert.equal(writes.length,0)
})
test('actual production autosave coalesces text for 600ms with a three-second bound, while blur, submission and numeric answers flush immediately',async()=>{
 const scope={userId:'owner',sessionId:'session'},f=fixture('written'),written={id:f.request.requestId,createdAt:new Date().toISOString(),demo:false,...f,progress:a.emptyTutorProgress(f.bundle),revision:0},demo=a.createTutorDemo('numeric-quiz','quiz'),quiz={id:'numeric-quiz',createdAt:written.createdAt,demo:false,...demo,progress:a.emptyTutorProgress(),revision:0},history={scope,runs:[written,quiz],activeRunId:written.id}
 written.bundle.study.written.push({...written.bundle.study.written[0],id:'write-two'})
 const cells=[],effects=[],timers=new Map(),events=new Map(),storage=new Map(),calls=[];let at=0,clock=10000,timerId=0,hold=false,release=null
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i])),settle=async()=>{for(let i=0;i<5;i++)await Promise.resolve()}
 const hooks={useState(value){const i=at++;if(!cells[i])cells[i]={value:typeof value==='function'?value():value};return[cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}]},useRef(value){return cells[at++]??={current:value}},useMemo(fn,deps){const i=at++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn()};return cells[i].value},useEffect(fn,deps){const i=at++;if(!cells[i]||!same(cells[i].deps,deps)){cells[i]={deps};effects.push(fn)}}};hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps)
 const jsx=(type,props,key)=>({type,props:props||{},key}),module={exports:{}},child=()=>null,FakeDate=class extends Date{static now(){return clock}},key='xelay:max:tutor-progress-outbox:owner:v1'
 const compiled=ts.transpileModule(readFileSync(path.join(root,'src/components/student/ProductionMaxTutorAssistant.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 const network={history:async()=>history,async progress(base,progress,signal){calls.push({id:base.id,progress:copy(progress),signal});if(hold)await new Promise(resolve=>{release=resolve});return{...base,progress,revision:base.revision+1}}}
 vm.runInNewContext(compiled,{module,exports:module.exports,Map,Set,JSON,Date:FakeDate,Number,Math,Intl,Promise,Blob,AbortController,URL,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),confirm:()=>false},setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,at:clock+delay});return id},clearTimeout:id=>timers.delete(id),require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name==='lucide-react')return new Proxy({},{get:(_,id)=>String(id)});if(name==='../../lib/maxTutorProductionClient')return client;if(name==='./MaxTutorAssistant')return{MaxTutorAssistant:child};throw Error('Unexpected '+name)}})
 const props={status:{scope,canEdit:true,canGenerate:true,budget:{limitUsd:10,remainingUsd:10},budgetResetsAt:null},client:network},render=()=>{at=0;return module.exports.ProductionMaxTutorAssistant(props)},nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
 async function tick(ms){const end=clock+ms;while(true){const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;clock=due[1].at;timers.delete(due[0]);due[1].fn();await settle()}clock=end;await settle()}
 render();const cleanup=effects.shift()();await settle();let tree=render(),api=nodes(tree).find(n=>n.type===child).props,progress=written.progress
 const type=value=>{progress=a.answerTutorStudy(progress,written.bundle,'write-one',value);api.onProgressChange(written.id,progress)}
 type('П');assert.equal(JSON.parse(storage.get(key)).items[written.id].progress.studyAnswers['write-one'],'П');assert.equal(calls.length,0)
 await tick(200);type('Підготовка');api.onStateChange({version:1,runs:[{...written,progress},quiz],activeRunId:written.id});await tick(599);assert.equal(calls.length,0);await tick(1);assert.equal(calls.length,1);assert.equal(calls[0].progress.studyAnswers['write-one'],'Підготовка')
 type('Безперервне');for(let i=0;i<5;i++){await tick(500);type('Безперервне '+i)}assert.equal(calls.length,1);await tick(500);assert.equal(calls.length,2,'Continuous typing flushes by three seconds')
 type('Збереження при виході з поля');assert.equal(calls.length,2);tree.props.onBlurCapture();assert.equal(calls.length,3);await settle()
 type('Фінальна відповідь');progress=a.submitTutorStudy(progress,written.bundle,'write-one');api.onProgressChange(written.id,progress);assert.equal(calls.length,4);assert.deepEqual(calls[3].progress.studySubmitted,['write-one']);await settle()
 api.onProgressChange(quiz.id,a.answerTutorQuestion(quiz.progress,quiz.bundle,quiz.bundle.questions[0].id,0));assert.equal(calls.length,5);assert.equal(calls[4].progress.answers[quiz.bundle.questions[0].id],0);await settle()
 // New typing during an in-flight save waits for its own deadline instead of
 // turning the drain loop into one request per network round trip.
 const typeSecond=value=>{progress=a.answerTutorStudy(progress,written.bundle,'write-two',value);api.onProgressChange(written.id,progress)}
 hold=true;typeSecond('Довга мережа');await tick(600);assert.equal(calls.length,6);await tick(100);typeSecond('Новий текст під час запиту');release();await settle();assert.equal(calls.length,6);await tick(599);assert.equal(calls.length,6);hold=false;await tick(1);assert.equal(calls.length,7);await settle()
 // Pagehide keeps the latest text locally even before the debounce expires.
 typeSecond('Незавершений локальний текст');events.get('pagehide')();assert.equal(JSON.parse(storage.get(key)).items[written.id].progress.studyAnswers['write-two'],'Незавершений локальний текст');const count=calls.length;cleanup();await tick(4000);assert.equal(calls.length,count)
})
test('real provider schema requests version2 format-specific fields without enabling tools or provider-side storage',async()=>{
 for(const format of a.TUTOR_STUDY_FORMATS){const{request,bundle}=fixture(format);let sent
  const api=provider.createMaxTutorOpenAi({enabled:true,billingApproved:true,apiKey:'synthetic-server-credential',model:'configured-model',fetcher:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}),{headers:{'Content-Type':'application/json'}})}})
  const generated=await api.generate(request,{signal:new AbortController().signal});assert.equal(generated.bundle.study.format,format);assert.equal(sent.text.format.schema.properties.version.enum[0],2);assert.equal(sent.text.format.schema.properties.study.properties.format.enum[0],format);assert.deepEqual(sent.tools,[]);assert.equal(sent.store,false);assert.match(sent.instructions,/student self-assessment/)
 }
})
