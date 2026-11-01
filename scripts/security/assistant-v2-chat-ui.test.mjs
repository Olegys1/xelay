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
async function fixture(t) {
  const run=hooksRuntime(),events=new EventTarget(),stored=new Map(),requests=[],reads=[],writes=[];let reply=async()=>({userId:USER,kind:'reply',text:'Привіт! Що зробимо?'})
  const storage={get length(){return stored.size},key:i=>[...stored.keys()][i]??null,getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}
  const window={location:{pathname:'/',search:''},localStorage:storage,addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),dispatchEvent:events.dispatchEvent.bind(events),matchMedia:()=>({matches:false})}
  const globals={window,document:{addEventListener(){},removeEventListener(){}},navigator:{onLine:true},URL,URLSearchParams,AbortController,structuredClone,requestAnimationFrame:callback=>callback(),setTimeout,clearTimeout,CustomEvent:class extends Event{constructor(type,options){super(type);this.detail=options.detail}},fetch(){throw Error('Network forbidden')}}
  function evaluate(source,imports={}){const module={exports:{}};vm.runInNewContext(compile(source),{...globals,module,exports:module.exports,require(name){assert.ok(Object.hasOwn(imports,name),'Explicit import '+name);return imports[name]}});return module.exports}
  const helpers=evaluate(read('src/lib/assistant-v2/workspaceTools.ts')),context=evaluate(read('src/lib/assistant-v2/pageContext.ts'))
  class AssistantCloudError extends Error{constructor(code){super(code);this.code=code}}
  const catalog={userId:USER,groups:[{id:GROUP,name:'Демо-1',learning:true,permissions:[],studyYear:1},{id:SECOND,name:'Демо-2',learning:true,permissions:[],studyYear:1}],courses:[],subjects:[]}
  const api={bootstrap:async()=>({available:true,modelConnected:true,writesAvailable:true}),catalog:async()=>structuredClone(catalog),chat:async(value,signal)=>{requests.push({value:plain(value),signal});return reply(value,signal)},read:async value=>{reads.push(value);return{userId:USER,records:[],audience:'student',readAt:'2026-11-02T10:00:00Z',truncated:false}},clear(){},prepare(){writes.push('prepare');throw Error('Unexpected save')},confirm(){writes.push('confirm');throw Error('Unexpected confirmation')}}
  const component=evaluate(read('src/components/assistant-v2/XelayAssistant.tsx')+'\nexport {AssistantDrawer};',{
    react:run.hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>'Icon'+String(name)}),
    '../../context/AuthContext':{},'../../lib/supabase':{supabase:{}},'../../lib/assistant-v2/cloudClient':{createAssistantCloudClient:()=>api,AssistantCloudError},'../../lib/assistant-v2/workspaceTools':helpers,'../../lib/assistant-v2/pageContext':context,'./xelay-assistant.css':{},
  })
  run.start(component.AssistantDrawer);await run.flush();run.find(node=>node.type==='button'&&String(node.props.className).startsWith('xai-launcher')).props.onClick();await run.flush();t.after(()=>run.unmount())
  const composer=()=>run.find(node=>node.type==='textarea'&&node.props.maxLength===6000)
  return{run,requests,reads,writes,AssistantCloudError,setReply(value){reply=value},get text(){return text(run.tree)},async send(value){composer().props.onChange({target:{value}});run.render();run.find(node=>node.type==='form'&&node.props.className==='xai-chat-composer').props.onSubmit({preventDefault(){}});await run.flush()},async group(value){run.find(node=>node.type==='select').props.onChange({target:{value}});await run.flush()},async context(value){context.publishAssistantPageContext({source:'synthetic-page',ownerId:USER,mode:'learning',...value});await run.flush()},composer}
}
const clarify=()=>({userId:USER,kind:'clarify',text:'Оберіть потрібну пару.',continuation:'server-signed-choice',choices:{type:'lesson',items:[{id:'lesson',label:'OLD_CHOICE'}]}})

test('actual drawer renders a conversational reply without inventing a read or triggering a save',async t=>{
  const f=await fixture(t);await f.send('ПРИВІТ');assert.match(f.text,/Привіт! Що зробимо/);assert.doesNotMatch(f.text,/записів поки немає/)
  assert.equal(f.requests.length,1);assert.equal(f.reads.length,0);assert.equal(f.writes.length,0)
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
