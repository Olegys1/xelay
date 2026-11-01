// Actual drawer hooks/handlers with an explicit synthetic transport. No SDK,
// provider, real account, network, browser session, listener or paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../',import.meta.url), read = path => readFileSync(new URL(path,root),'utf8')
const compile = source => ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const USER='10000000-0000-4000-8000-000000000001', GROUP='20000000-0000-4000-8000-000000000001', SECOND='20000000-0000-4000-8000-000000000002'
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = value => !value || typeof value!=='object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value,...nodes(value.props?.children)]
const text = value => value==null||typeof value==='boolean' ? '' : Array.isArray(value) ? value.map(text).join(' ') : typeof value==='object' ? text(value.props?.children) : String(value)
function hooksRuntime() {
  const cells=[],effects=[];let index=0,dirty=false,component,tree
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]))
  const hooks={
    useState(initial){const i=index++;if(!cells[i])cells[i]={value:typeof initial==='function'?initial():initial};const cell=cells[i];cell.set??=next=>{const value=typeof next==='function'?next(cell.value):next;if(!Object.is(value,cell.value)){cell.value=value;dirty=true}};return[cell.value,cell.set]},
    useRef(initial){return cells[index++]??={current:initial}},useId(){return'chat-fixture-'+index++},
    useMemo(callback,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:callback()};return cells[i].value},
    useCallback(callback,deps){return hooks.useMemo(()=>callback,deps)},
    useEffect(callback,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const prior=cells[i];cells[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{prior?.cleanup?.();cells[i].cleanup=callback()})}},
  }
  const render=()=>{for(let pass=0;pass<40;pass++){index=0;dirty=false;tree=component({ownerId:USER,pathname:'/'});effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Synthetic drawer did not settle')}
  return{hooks,start(value){component=value;return render()},render,get tree(){return tree},find(predicate){const result=nodes(tree).find(predicate);assert.ok(result,'Actual drawer control exists');return result},async flush(){for(let n=0;n<30;n++){await Promise.resolve();render()}},unmount(){for(const cell of cells)cell?.cleanup?.()}}
}
async function fixture(t, options = {}) {
  const run=hooksRuntime(),events=new EventTarget(),stored=new Map(),requests=[],reads=[],writes=[];let reply=async()=>({userId:USER,kind:'reply',text:'Привіт! Що зробимо?'})
  const storage={get length(){return stored.size},key:i=>[...stored.keys()][i]??null,getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}
  const window={location:{pathname:'/',search:''},localStorage:storage,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),matchMedia:()=>({matches:false})}
  const globals={window,document:{addEventListener(){},removeEventListener(){}},navigator:{onLine:true},URL,URLSearchParams,AbortController,structuredClone,requestAnimationFrame:callback=>callback(),setTimeout,clearTimeout,CustomEvent:class extends Event{constructor(type,options){super(type);this.detail=options.detail}},fetch(){throw Error('Network forbidden')}}
  function evaluate(source,imports={}){const module={exports:{}};vm.runInNewContext(compile(source),{...globals,module,exports:module.exports,require(name){assert.ok(Object.hasOwn(imports,name),'Explicit import '+name);return imports[name]}});return module.exports}
  const helpers=evaluate(read('src/lib/assistant-v2/workspaceTools.ts')),context=evaluate(read('src/lib/assistant-v2/pageContext.ts'))
  class AssistantCloudError extends Error{constructor(code){super(code);this.code=code}}
  const calls={bootstrap:0,catalog:0,drafts:0};const catalog=options.catalog||{userId:USER,groups:[{id:GROUP,name:'Демо-1',learning:true,permissions:[],studyYear:1},{id:SECOND,name:'Демо-2',learning:true,permissions:[],studyYear:1}],courses:[],subjects:[]}
  const api={bootstrap:async()=>{calls.bootstrap++;return options.bootstrap ? options.bootstrap() : {available:true,modelConnected:true,writesAvailable:true}},catalog:async()=>{calls.catalog++;return options.loadCatalog ? options.loadCatalog() : structuredClone(catalog)},drafts:async()=>{calls.drafts++;return {drafts:[]}},chat:async(value,signal)=>{requests.push({value:plain(value),signal});return reply(value,signal)},read:async value=>{reads.push(value);return{userId:USER,records:[],audience:'student',readAt:'2026-11-02T10:00:00Z',truncated:false}},clear(){},prepare(){writes.push('prepare');throw Error('Unexpected save')},confirm(){writes.push('confirm');throw Error('Unexpected confirmation')}}
  const component=evaluate(read('src/components/assistant-v2/XelayAssistant.tsx')+'\nexport {AssistantDrawer,RecordCard};',{
    react:run.hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>'Icon'+String(name)}),
    '../../context/AuthContext':{},'../../lib/supabase':{supabase:{}},'../../lib/assistant-v2/cloudClient':{createAssistantCloudClient:()=>api,AssistantCloudError},'../../lib/assistant-v2/workspaceTools':helpers,'../../lib/assistant-v2/pageContext':context,'./xelay-assistant.css':{},
  })
  run.start(component.AssistantDrawer);await run.flush();run.find(node=>node.type==='button'&&String(node.props.className).startsWith('xai-launcher')).props.onClick();await run.flush();t.after(()=>run.unmount())
  const composer=()=>run.find(node=>node.type==='textarea'&&node.props.maxLength===6000)
  return{run,RecordCard:component.RecordCard,requests,reads,writes,calls,api,catalog,window,offlineCache:helpers.createAssistantOfflineCache(storage,USER),AssistantCloudError,setReply(value){reply=value},get text(){return text(run.tree)},async send(value){composer().props.onChange({target:{value}});run.render();run.find(node=>node.type==='form'&&node.props.className==='xai-chat-composer').props.onSubmit({preventDefault(){}});await run.flush()},async group(value){run.find(node=>node.type==='select').props.onChange({target:{value}});await run.flush()},async context(value){context.publishAssistantPageContext({source:'synthetic-page',ownerId:USER,mode:'learning',...value});await run.flush()},composer}
}
const clarify=()=>({userId:USER,kind:'clarify',text:'Оберіть потрібну пару.',continuation:'server-signed-choice',choices:{type:'lesson',items:[{id:'lesson',label:'OLD_CHOICE'}]}})

test('actual drawer renders a conversational reply without inventing a read or triggering a save',async t=>{
  const f=await fixture(t);await f.send('ПРИВІТ');assert.match(f.text,/Привіт! Що зробимо/);assert.doesNotMatch(f.text,/записів поки немає/)
  assert.equal(f.requests.length,1);assert.equal(f.reads.length,0);assert.equal(f.writes.length,0)
})

test('a personal elective card is visibly personal and never offers group homework controls',async t=>{
  const f=await fixture(t),record={id:SECOND,groupId:GROUP,kind:'lesson',title:'Моя вибіркова',date:'2026-11-02',startsAt:'11:20',endsAt:'12:40',personalElective:true,scheduleId:'not-authoritative-for-personal'}
  const card=f.RecordCard({record,canHomework:true,onHomework(){assert.fail('Personal lesson cannot edit group homework')}})
  assert.match(text(card),/Моя вибіркова дисципліна/)
  assert.equal(nodes(card).some(node=>node.type==='button'&&text(node).includes('Додати або змінити ДЗ')),false)
  const shared=f.RecordCard({record:{...record,personalElective:undefined},canHomework:true,onHomework(){}})
  assert.equal(nodes(shared).some(node=>node.type==='button'&&text(node).includes('Додати або змінити ДЗ')),true)
})

test('a homework-only card identifies the actual subject beside its generic title, group and whole unchanged body',async t=>{
  const f=await fixture(t),body='Якщо заняття відбудеться, підготуйте задачі 1–3.\nІнакше не здавайте. https://example.com/full-conditions'
  const record={id:SECOND,groupId:GROUP,kind:'homework',title:'Практична №3',subjectName:'Вища математика',body,date:'2026-11-05'}
  const props={record,groupName:'ЕУБ-4',canHomework:false,onHomework(){assert.fail('A read is not a save')}}
  const card=f.RecordCard(props),rendered=text(card)
  assert.match(rendered,/Практична №3/);assert.match(rendered,/Предмет:  Вища математика/);assert.match(rendered,/ЕУБ-4/)
  assert.equal(nodes(card).find(node=>node.type==='p'&&node.props.className==='xai-body').props.children,body)
  const titled=f.RecordCard({...props,record:{...record,title:'Практична з ВИЩА   МАТЕМАТИКА №3'}})
  assert.equal(nodes(titled).some(node=>node.type==='p'&&text(node).startsWith('Предмет:')),false,'an obvious title repetition is not added')
  for(const subjectName of [undefined,'', '   ']){
    const missing=f.RecordCard({...props,record:{...record,subjectName}})
    assert.equal(nodes(missing).some(node=>node.type==='p'&&text(node).startsWith('Предмет:')),false,'unknown subjects are not invented')
  }
})

test('actual drawer displays group timetable and homework without inventing a missing seminar subject',async t=>{
  const f=await fixture(t),scheduleId='30000000-0000-4000-8000-000000000001',day='2026-11-06'
  f.setReply(async()=>({userId:USER,kind:'read',text:'Пари на п’ятницю.',read:{userId:USER,audience:'student',readAt:'2026-11-01T10:00:00Z',truncated:false,records:[
    {id:scheduleId,kind:'lesson',groupId:GROUP,scheduleId,title:'Предмет без семінару',date:day,startsAt:'08:30',endsAt:'09:50',sourcePath:`/groups/${GROUP}?tab=schedule&date=${day}`},
    {id:'40000000-0000-4000-8000-000000000001',kind:'homework',groupId:GROUP,lessonId:scheduleId,title:'Завдання до цієї пари',body:'Повні умови без зміни.',date:day,sourcePath:`/groups/${GROUP}?tab=schedule&date=${day}`},
  ]}}))
  await f.group(GROUP);await f.send('Що у п’ятницю?')
  const cards=nodes(f.run.tree).filter(node=>typeof node.type==='function'&&node.type.name==='RecordCard').map(node=>node.type(node.props))
  assert.equal(cards.length,2)
  const rendered=text(cards)
  assert.match(rendered,/Предмет без семінару/);assert.match(rendered,/Завдання до цієї пари/);assert.match(rendered,/Повні умови без зміни/)
  const sources=nodes(cards).filter(node=>node.type==='a'&&String(node.props.href).startsWith('/groups/'+GROUP))
  assert.equal(sources.length,2);assert.ok(sources.every(node=>node.props.href.includes('date='+day)))
  assert.deepEqual(f.writes,[])
})
test('changing the chat group clears prior choice chips, signed continuation and prior user history',async t=>{
  const f=await fixture(t);f.setReply(async()=>clarify());await f.send('OLD_GROUP_REQUEST');assert.match(f.text,/OLD_CHOICE/)
  await f.group(SECOND);assert.doesNotMatch(f.text,/OLD_CHOICE|OLD_GROUP_REQUEST/)
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Новий контекст.'}));await f.send('Привіт')
  const next=f.requests[1].value;assert.equal(next.scope.groupId,SECOND);assert.deepEqual(next.history,[]);assert.equal(next.continuation,undefined)
})
test('an authorized page context change also clears dialogue and discards an older in-flight answer',async t=>{
  const f=await fixture(t);let resolve;f.setReply(()=>new Promise(done=>{resolve=done}));await f.send('OLD_PENDING_REQUEST');assert.equal(f.requests.length,1)
  await f.context({groupId:SECOND,date:'2026-11-03'});assert.equal(f.requests[0].signal.aborted,true)
  resolve({userId:USER,kind:'reply',text:'STALE_ANSWER'});await f.run.flush();assert.doesNotMatch(f.text,/OLD_PENDING_REQUEST|STALE_ANSWER/)
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Далі.'}));await f.send('Що вмієш?');assert.deepEqual(f.requests[1].value.history,[]);assert.equal(f.requests[1].value.scope.groupId,SECOND)
})
test('an expired clarification clears the token, restores input and waits for a fresh explicit send',async t=>{
  for(const code of ['chat_context_expired','chat_continuation_invalid']){
    const f=await fixture(t);f.setReply(async()=>clarify());await f.send('Покажи пари')
    f.setReply(async()=>{throw new f.AssistantCloudError(code)});await f.send('А завтра?');assert.match(f.text,/Час уточнення минув/);assert.match(f.text,/Автоматичного повтору немає/);assert.equal(f.composer().props.value,'А завтра?');assert.doesNotMatch(f.text,/OLD_CHOICE/)
    await f.run.flush();assert.equal(f.requests.length,2)
    f.setReply(async()=>({userId:USER,kind:'reply',text:'Новий запит.'}));await f.send('Покажи всі мої пари на завтра');assert.equal(f.requests[2].value.continuation,undefined);assert.deepEqual(f.requests[2].value.history,[]);assert.deepEqual(f.writes,[])
  }
})
test('expiration preserves the exact separately pasted teacher text for a manual fresh request',async t=>{
  const f=await fixture(t);f.setReply(async()=>clarify());await f.send('Додай ДЗ')
  f.run.find(node=>node.type==='button'&&text(node).includes('Додати повідомлення викладача')).props.onClick();f.run.render()
  const copied='Якщо буде пара, підготуйте приклад.\nІнакше нічого не здавайте.'
  f.run.find(node=>node.type==='textarea'&&node.props.maxLength===10000).props.onChange({target:{value:copied}});f.run.render()
  f.setReply(async()=>{throw new f.AssistantCloudError('chat_context_expired')});await f.send('Врахуй це повідомлення')
  assert.equal(f.requests[1].value.teacherMessage,copied);assert.equal(f.composer().props.value,'Врахуй це повідомлення')
  assert.equal(f.run.find(node=>node.type==='textarea'&&node.props.maxLength===10000).props.value,copied);assert.equal(f.requests.length,2);assert.deepEqual(f.writes,[])
})
test('smalltalk replies keep only a token explicitly returned by the server and retire older choices',async t=>{
  const f=await fixture(t);f.setReply(async()=>clarify());await f.send('Покажи пари')
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Будь ласка!',continuation:'server-signed-followup'}));await f.send('Дякую');assert.doesNotMatch(f.text,/OLD_CHOICE/)
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Уточню дату.'}));await f.send('А на п’ятницю?');assert.equal(f.requests[2].value.continuation,'server-signed-followup')
  await f.send('Іще питання');assert.equal(f.requests[3].value.continuation,undefined)
})
test('assistant responses, private records and grade values never enter the next model-bound user history',async t=>{
  const f=await fixture(t);f.setReply(async()=>({userId:USER,kind:'read',text:'PRIVATE_ASSISTANT_ANSWER',read:{userId:USER,audience:'student',readAt:'2026-11-02T10:00:00Z',truncated:false,records:[{id:'grade',kind:'grade',groupId:GROUP,subjectId:'',title:'PRIVATE_GRADE_TITLE',body:'PRIVATE_RECORD_BODY',points:97,maxPoints:100}]}}));await f.send('Покажи мої бали')
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Будь ласка!'}));await f.send('Дякую')
  assert.deepEqual(f.requests[1].value.history,[{role:'user',content:'Покажи мої бали'}]);assert.doesNotMatch(JSON.stringify(f.requests[1].value),/PRIVATE_|97/)
})
test('starting a new conversation clears history and continuation while keeping the selected authorized group',async t=>{
  const f=await fixture(t);await f.group(SECOND);f.setReply(async()=>clarify());await f.send('Попередній запит')
  f.run.find(node=>node.type==='button'&&node.props['aria-label']==='Нова розмова').props.onClick();await f.run.flush()
  assert.doesNotMatch(f.text,/Попередній запит|OLD_CHOICE/)
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Привіт!'}));await f.send('ПРИВІТ')
  assert.deepEqual(f.requests[1].value.history,[]);assert.equal(f.requests[1].value.continuation,undefined);assert.equal(f.requests[1].value.scope.groupId,SECOND)
})

const pendingDraft=()=>({id:'50000000-0000-4000-8000-000000000001',action:'organizer.task.create',title:'Перевірити конспект',revision:1,status:'pending',createdAt:'2026-11-02T10:00:00Z',expiresAt:'2026-11-02T10:10:00Z',scope:{},payload:{title:'Перевірити конспект',notes:'Тільки тестова справа',space:'personal',dueAt:null},confirmationToken:'synthetic-reviewed-token',fields:[],items:[{id:'task',label:'Особиста справа',after:'Перевірити конспект'}]})

test('the initial assistant is one chat and one composer without manual, data or draft tabs and upload blocks',async t=>{
  const f=await fixture(t)
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='form'&&node.props.className==='xai-chat-composer').length,1)
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='textarea').length,1)
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='nav').length,0)
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='input'&&node.props.type==='file').length,0)
  assert.equal(nodes(f.run.tree).some(node=>['xai-action-choices','xai-prepared-list','xai-draft','xai-import-form'].includes(node.props?.className)),false)
  assert.equal(nodes(f.run.tree).some(node=>node.type==='details'&&node.props.className==='xai-context-settings'&&!node.props.open),true)
  assert.equal(nodes(f.run.tree).some(node=>node.type==='details'&&node.props.className==='xai-chat-privacy'&&!node.props.open),true)
})
test('one real accepted learning group is automatic even when allowed test or teaching groups appear first',async t=>{
  const catalog={userId:USER,defaultLearningGroupId:GROUP,groups:[{id:SECOND,name:'Тест',learning:true,testGroup:true,permissions:[]},{id:GROUP,name:'Реальна група',learning:true,permissions:[]}],courses:[],subjects:[]}
  const f=await fixture(t,{catalog});await f.send('Які в мене завтра пари?')
  assert.equal(f.requests[0].value.scope.groupId,GROUP);assert.match(f.text,/Реальна група/);assert.match(f.text,/підключено автоматично/)
  const selector=f.run.find(node=>node.type==='select'&&node.props['aria-label']==='Група для розмови');assert.equal(selector.props.value,GROUP)
  await f.group(SECOND);await f.send('Покажи саме цю тестову групу');assert.equal(f.requests[1].value.scope.groupId,SECOND)
})
test('an invalid declared default cannot select a test group and multiple ordinary groups remain an explicit choice',async t=>{
  const catalog={userId:USER,defaultLearningGroupId:SECOND,groups:[{id:SECOND,name:'Тест',learning:true,testGroup:true,permissions:[]},{id:GROUP,name:'Єдина справжня',learning:true,permissions:[]}],courses:[],subjects:[]}
  const f=await fixture(t,{catalog});await f.send('Покажи розклад');assert.equal(f.requests[0].value.scope.groupId,GROUP)
  const multiple=await fixture(t);await multiple.send('Покажи розклад');assert.equal(multiple.requests[0].value.scope.groupId,undefined)
})
test('a returned draft is reviewed and explicitly confirmed inline while the same chat and composer remain',async t=>{
  const f=await fixture(t),draft=pendingDraft()
  f.setReply(async()=>({userId:USER,kind:'draft',text:'Підготував справу. Перевірте зміст.',draft}))
  f.api.confirm=async target=>{f.writes.push('confirm:'+target.id);return {draft:{...target,status:'confirmed'},receipt:{draftId:target.id,action:target.action,savedAt:'2026-11-02T10:01:00Z',affectedIds:['synthetic-task'],path:'/organizer',syntheticOnly:false}}}
  await f.send('Додай справу перевірити конспект')
  assert.match(f.text,/Додай справу перевірити конспект/);assert.match(f.text,/Підготував справу/)
  assert.ok(nodes(f.run.tree).some(node=>node.props?.['aria-label']==='Підготовка зміни у розмові'))
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='form'&&node.props.className==='xai-chat-composer').length,1)
  let confirm=f.run.find(node=>node.type==='button'&&text(node).includes('Підтвердити й зберегти'));assert.equal(confirm.props.disabled,true);assert.deepEqual(f.writes,[])
  f.run.find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});f.run.render()
  confirm=f.run.find(node=>node.type==='button'&&text(node).includes('Підтвердити й зберегти'));assert.equal(Boolean(confirm.props.disabled),false);confirm.props.onClick();await f.run.flush()
  assert.deepEqual(f.writes,['confirm:'+draft.id]);assert.match(f.text,/Збереження підтверджене сервером/);assert.match(f.text,/Додай справу перевірити конспект/)
  f.run.find(node=>node.type==='button'&&node.props.className==='xai-chat-draft-link').props.onClick();await f.run.flush()
  assert.equal(nodes(f.run.tree).some(node=>node.type==='button'&&text(node).includes('Підтвердити й зберегти')),false)
})
test('structured forms and schedule attachments appear only when returned by the chat, without executing them automatically',async t=>{
  const catalog={userId:USER,groups:[{id:GROUP,name:'Реальна група',learning:true,permissions:['schedule']}],courses:[],subjects:[]},f=await fixture(t,{catalog})
  const form={action:'schedule.copy',title:'Коли перенести пари',scope:{groupId:GROUP},payload:{sourceDate:'2026-11-02'},fields:[{key:'sourceDate',label:'Звідки',type:'date',required:true}]}
  f.setReply(async()=>({userId:USER,kind:'clarify',text:'Уточніть дату перенесення.',form}));await f.send('Перенеси пари на суботу')
  assert.match(f.text,/Уточніть дату перенесення/);assert.ok(nodes(f.run.tree).some(node=>node.type==='form'&&node.props.className==='xai-form xai-structured-form'));assert.equal(f.writes.length,0)
  assert.equal(nodes(f.run.tree).some(node=>node.type==='input'&&node.props.type==='file'),false)
  f.setReply(async()=>({userId:USER,kind:'clarify',text:'Додайте фото розкладу.',tool:{type:'schedule-import',scope:{groupId:GROUP}}}));await f.send('Імпортуй розклад із фотографії')
  assert.equal(nodes(f.run.tree).filter(node=>node.type==='input'&&node.props.type==='file').length,1)
  assert.match(f.text,/Імпортуй розклад із фотографії/);assert.equal(f.writes.length,0);assert.equal(f.requests.length,2)
})
test('reopening the chat and repeated online events do not repeat bootstrap, catalog or record reads',async t=>{
  const f=await fixture(t);assert.deepEqual(f.calls,{bootstrap:1,catalog:1,drafts:0})
  for(let n=0;n<3;n++){
    f.run.find(node=>node.type==='button'&&node.props.className==='xai-icon-button'&&node.props['aria-label']==='Закрити помічника').props.onClick();await f.run.flush()
    f.run.find(node=>node.type==='button'&&String(node.props.className).startsWith('xai-launcher')).props.onClick();await f.run.flush()
    f.window.dispatchEvent(new Event('online'));await f.run.flush()
  }
  assert.deepEqual(f.calls,{bootstrap:1,catalog:1,drafts:0});assert.equal(f.reads.length,0)
  f.window.dispatchEvent(new Event('offline'));await f.run.flush();f.window.dispatchEvent(new Event('online'));await f.run.flush()
  assert.deepEqual(f.calls,{bootstrap:2,catalog:2,drafts:0});assert.equal(f.reads.length,0)
})

test('a cold assistant opens before either response, starts both safe reads in parallel and keeps typed text without auto-send',async t=>{
  for(const first of ['catalog','bootstrap']){
    let finishBootstrap,finishCatalog
    const bootstrap=new Promise(resolve=>{finishBootstrap=resolve}),catalogPending=new Promise(resolve=>{finishCatalog=resolve})
    const f=await fixture(t,{bootstrap:()=>bootstrap,loadCatalog:()=>catalogPending})
    assert.deepEqual(f.calls,{bootstrap:1,catalog:1,drafts:0},'catalog is dispatched while bootstrap is still unresolved, rather than a second round trip')
    assert.ok(nodes(f.run.tree).some(node=>node.props?.role==='dialog'))
    assert.equal(Boolean(f.composer().props.disabled),false)
    f.composer().props.onChange({target:{value:'Покажи моє ДЗ на завтра'}});f.run.render()
    const ready={available:true,modelConnected:true,writesAvailable:true},catalog={userId:USER,groups:[{id:GROUP,name:'Моя група',learning:true,permissions:[]}],subjects:[],courses:[]}
    const sendButton=()=>f.run.find(node=>node.type==='button'&&node.props['aria-label']==='Надіслати повідомлення')
    assert.equal(sendButton().props.disabled,true)
    if(first==='catalog')finishCatalog(catalog);else finishBootstrap(ready)
    await f.run.flush();assert.equal(sendButton().props.disabled,true);assert.equal(f.requests.length,0)
    if(first==='catalog')finishBootstrap(ready);else finishCatalog(catalog)
    await f.run.flush();assert.equal(Boolean(sendButton().props.disabled),false);assert.equal(f.composer().props.value,'Покажи моє ДЗ на завтра');assert.equal(f.requests.length,0)
    f.run.find(node=>node.type==='form'&&node.props.className==='xai-chat-composer').props.onSubmit({preventDefault(){}});await f.run.flush();assert.equal(f.requests.length,1)
    assert.equal(f.requests[0].value.scope.groupId,GROUP)
  }
})

test('restored catalog metadata remains read-only after a failed access refresh and cannot authorize a chat or confirmation',async t=>{
  let loads=0
  const catalog={userId:USER,groups:[{id:GROUP,name:'Моя група',learning:true,permissions:['homework']}],subjects:[],courses:[]}
  const f=await fixture(t,{catalog,loadCatalog:async()=>{if(++loads>1)throw Error('Synthetic unavailable');return catalog}})
  f.setReply(async()=>({userId:USER,kind:'draft',text:'Перевірте справу.',draft:pendingDraft()}));await f.send('Додай особисту справу')
  f.window.dispatchEvent(new Event('offline'));await f.run.flush();f.window.dispatchEvent(new Event('online'));await f.run.flush()
  assert.match(f.text,/Показано збережений перелік груп/)
  await f.send('Цей запит має залишитися у полі');assert.equal(f.requests.length,1);assert.equal(f.composer().props.value,'Цей запит має залишитися у полі')
  f.run.find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});f.run.render()
  const confirm=f.run.find(node=>node.type==='button'&&text(node).includes('Підтвердити й зберегти'));assert.equal(confirm.props.disabled,true)
  confirm.props.onClick();await f.run.flush();assert.deepEqual(f.writes,[])
})

test('canonical returned read date replaces an older page date for the visible stamp and subsequent user followups',async t=>{
  const f=await fixture(t);await f.context({groupId:GROUP,date:'2026-11-03'})
  f.setReply(async()=>({userId:USER,kind:'read',text:'Відповідь про вибрану дату.',continuation:'synthetic-date-followup',read:{userId:USER,audience:'student',view:'homework',topic:'study',scope:{groupId:GROUP,from:'2026-11-05',to:'2026-11-05',period:'current'},records:[],readAt:'2026-11-01T10:00:00Z',truncated:false}}))
  await f.send('Покажи ДЗ на четвер')
  assert.ok(nodes(f.run.tree).some(node=>node.type==='time'&&node.props.dateTime==='2026-11-05'))
  f.setReply(async()=>({userId:USER,kind:'reply',text:'Уточню.'}));await f.send('А що з матеріалами?')
  assert.equal(f.requests[1].value.scope.date,'2026-11-05');assert.equal(f.requests[1].value.continuation,'synthetic-date-followup')
})

test('filtered homework or schedule chat replies cannot overwrite the full composite offline copy at the same scope',async t=>{
  const f=await fixture(t),scope={groupId:GROUP,from:'2026-11-05',to:'2026-11-05',period:'current'}
  const lesson={id:'30000000-0000-4000-8000-000000000001',kind:'lesson',groupId:GROUP,title:'Розклад математики',date:scope.from,startsAt:'09:40',endsAt:'11:00'},homework={id:'40000000-0000-4000-8000-000000000001',kind:'homework',groupId:GROUP,title:'Повне ДЗ',body:'Збережені умови',date:scope.from}
  const reply=(records,view)=>({userId:USER,kind:'read',text:'Записи з платформи.',read:{userId:USER,audience:'student',topic:'study',scope,records,readAt:'2026-11-01T10:00:00Z',truncated:false,...(view?{view}:{})}})
  f.setReply(async()=>reply([lesson,homework]));await f.send('Покажи пари й ДЗ')
  const original=plain(f.offlineCache.read('study',scope).result)
  assert.equal(original.records.length,2)
  for(const [records,view] of [[[homework],'homework'],[[lesson],'schedule'],[[],'homework']]){
    f.setReply(async()=>reply(records,view));await f.send('Покажи окрему частину')
    assert.deepEqual(plain(f.offlineCache.read('study',scope).result),original)
  }
  const updated={...homework,body:'Оновлені повні умови'}
  f.setReply(async()=>reply([lesson,updated],'all'));await f.send('Онови повний перегляд')
  const full=plain(f.offlineCache.read('study',scope).result)
  assert.equal(full.records.length,2);assert.equal(full.records.find(record=>record.kind==='homework').body,updated.body)
})
