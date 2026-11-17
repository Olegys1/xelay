import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {randomUUID} from 'node:crypto'
import ts from 'typescript'

const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8'),plain=value=>JSON.parse(JSON.stringify(value))
const content=node=>(node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(content).join(' '):typeof node==='object'?content(node.props?.children):String(node)).replace(/\s+/g,' ').trim()
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{resolve,reject,promise}}
function load(file,imports={},globals={}){const module={exports:{}};runInNewContext(ts.transpileModule(read(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Date,Math,Number,BigInt,Map,Set,JSON,Promise,Error,Intl,TextEncoder,URL,Blob,AbortController,...globals,require(name){assert.ok(name in imports,'Known import '+name);return imports[name]}});return module.exports}
const practice=load('src/lib/plusLearningPractice.ts'),scopeA={userId:'synthetic-a',sessionId:'session-a'},scopeB={userId:'synthetic-b',sessionId:'session-b'}
function fixture(id='synthetic-quiz',kind='quiz'){
 const questions=kind==='quiz'?[{id:'question',text:'Синтетичне запитання',options:['Відповідь A','Відповідь B'],correctIndex:1,explanation:'Синтетичне пояснення',sourceId:''}]:[],cards=kind==='cards'?[{id:'card',front:'Синтетична картка',back:'Синтетична відповідь',sourceId:''}]:[]
 return{id,createdAt:'2026-11-17T10:00:00Z',demo:false,revision:1,request:{mode:kind,prompt:'Синтетична тема'},bundle:{title:'Синтетичний матеріал '+id,introduction:'Синтетичні навчальні дані для перевірки.',questions,cards},progress:{answers:questions.length?{question:0}:{},submitted:questions.length?['question']:[],cardRatings:{},doneTasks:[]}}
}
function library(scope,extra={}){const document={version:1,notes:[],reviews:[],...(extra.document||{})};return{snapshot:{status:'ready',scope,revision:1,document,canEdit:true,updatedAt:'2026-11-17T10:00:00Z',runs:[],nextCursor:null,...extra,document},document,phase:'saved',error:'',canEdit:true,hasLocalChanges:false,conflictSnapshot:null}}
function harness(options={}){
 const instances=new Map(),effects=[],controllers=[],calls=[],dom=new Map(),listeners=new Map(),timers=new Map();let current,dirty=false,tree,seen=new Set(),domSeen=new Set(),timer=0,mounts=0,unmounts=0,lastTutorProps,confirmResult=true
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 const hooks={useState(initial){const instance=current,at=instance.cursor++;instance.cells[at]??={value:typeof initial==='function'?initial():initial};return[instance.cells[at].value,next=>{const value=typeof next==='function'?next(instance.cells[at].value):next;if(!Object.is(value,instance.cells[at].value)){instance.cells[at].value=value;dirty=true}}]},useRef(initial){const at=current.cursor++;return current.cells[at]??={current:initial}},useMemo(fn,deps){const at=current.cursor++;if(!current.cells[at]||!same(current.cells[at].deps,deps))current.cells[at]={deps,value:fn()};return current.cells[at].value},useEffect(fn,deps){const instance=current,at=instance.cursor++;if(!instance.cells[at]||!same(instance.cells[at].deps,deps)){const old=instance.cells[at];instance.cells[at]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();instance.cells[at].cleanup=fn()})}}}
 hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps)
 const jsx=(type,props,key)=>({type,props:props||{},key})
 function Tutor(){hooks.useEffect(()=>{mounts++;return()=>unmounts++},[]);return jsx('div',{'data-tutor':'synthetic'})}
 const client={getRun:async(id,signal)=>{calls.push(['getRun',id,signal]);return(options.getRun||((id)=>fixture(id)))(id,signal)},loadRuns:async(cursor,signal)=>{calls.push(['loadRuns',cursor,signal]);return(options.loadRuns||(()=>({scope:props.scope,runs:[],nextCursor:null})))(cursor,signal)},getRuns:async(ids,signal)=>{calls.push(['getRuns',plain(ids),signal]);return(options.getRuns||((ids)=>({scope:props.scope,runs:ids.map(id=>fixture(id)),nextRunIds:[]})))(ids,signal)}}
 const props={scope:scopeA,canEdit:true,libraryClient:client,initialTab:'library',renderTutor:value=>{lastTutorProps=value;return jsx(Tutor,{})},...options.props}
 function makeController({ownerId,sessionId}){
  const scope={userId:ownerId,sessionId},subs=new Set();let state=(options.stateFor||((scope)=>library(scope)))(scope),disposed=false
  const api={ownerId,sessionId,state:()=>state,subscribe(fn){subs.add(fn);return()=>subs.delete(fn)},async load(){calls.push(['load',ownerId,sessionId]);await Promise.resolve();if(!disposed)subs.forEach(fn=>fn())},edit(fn){calls.push(['edit',ownerId]);if(options.editError)throw Error(options.editError);const document=fn(state.document);state={...state,document,phase:options.editPhase||'pending',hasLocalChanges:true};subs.forEach(fn=>fn())},sync(){calls.push(['sync',ownerId])},dispose(){disposed=true;calls.push(['dispose',ownerId,sessionId])},exportPending(){return JSON.stringify(state.document)},useServerVersion(){calls.push(['server',ownerId])},keepLocalVersion(){calls.push(['local',ownerId])},update(next){state={...state,...next};subs.forEach(fn=>fn())},get disposed(){return disposed}}
  controllers.push(api);return api
 }
 const ui=load('src/components/student/PlusLearningWorkspace.tsx',{react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'react-dom':{createPortal:node=>node},'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),'../../lib/studentLearningLibrary':{createStudentLearningLibraryController:makeController},'../../lib/plusLearningPractice':practice,'./plusLearningWorkspace.css':{}},{crypto:{randomUUID},window:{addEventListener(name,fn){listeners.set(name,[...(listeners.get(name)||[]),fn])},removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(value=>value!==fn))},confirm(message){calls.push(['confirm',message]);return confirmResult}},setInterval(fn){const id=++timer;timers.set(id,fn);return id},clearInterval(id){timers.delete(id)},setTimeout(){return++timer},document:{createElement(){return{click(){}}}}})
 function expand(node,path='root'){
  if(node==null||typeof node!=='object')return node
  if(Array.isArray(node))return node.map((item,index)=>expand(item,path+':'+(item?.key??index)))
  if(typeof node.type==='function'){const key=path+'/'+node.type.name+':'+(node.key??''),instance=instances.get(key)||{cells:[],cursor:0};instances.set(key,instance);seen.add(key);instance.cursor=0;const previous=current;current=instance;const result=node.type(node.props);current=previous;return expand(result,key)}
  domSeen.add(path);let element=dom.get(path);if(!element){element={selectionStart:0,selectionEnd:0,props:node.props};dom.set(path,element)}element.props=node.props
  if(node.props.ref&&typeof node.props.ref==='object')node.props.ref.current=element
  return{...node,__domPath:path,props:{...node.props,children:expand(node.props.children,path+'/'+node.type)}}
 }
 function render(){for(let tries=0;tries<30;tries++){dirty=false;seen=new Set();domSeen=new Set();tree=expand(jsx(ui.default,props));for(const[key,instance]of instances)if(!seen.has(key)){instance.cells.forEach(cell=>cell?.cleanup?.());instances.delete(key)}for(const[path,element]of dom)if(!domSeen.has(path)){if(element.props.ref&&typeof element.props.ref==='object')element.props.ref.current=null;dom.delete(path)}effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Plus workspace hooks did not settle')}
 render()
 return{props,calls,controllers,render,get tree(){return tree},get tutorProps(){return lastTutorProps},get counts(){return{mounts,unmounts}},all:fn=>nodes(tree).filter(fn),find:fn=>nodes(tree).find(fn),button(label){return nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||content(node).includes(label)))},click(label){const button=this.button(label);assert.ok(button,'Button '+label);assert.equal(!!button.props.disabled,false);const result=button.props.onClick();render();return result},field(label){const element=nodes(tree).find(node=>node.type==='label'&&content(node).startsWith(label));return nodes(element).find(node=>['input','textarea'].includes(node.type))},change(label,value){this.field(label).props.onChange({target:{value}});render()},select(start,end){const element=dom.get(this.field('Текст конспекту').__domPath);element.selectionStart=start;element.selectionEnd=end},confirm(value){confirmResult=value},async settle(){for(let index=0;index<8;index++){await Promise.resolve();render()}},unmount(){for(const instance of instances.values())instance.cells.forEach(cell=>cell?.cleanup?.());instances.clear()}}
}

test('library navigation retains one shared chat and its pending answers instead of mounting another assistant',async()=>{
 const run=fixture(),h=harness({stateFor:scope=>library(scope,{runs:[run]})});await h.settle()
 assert.equal(h.counts.mounts,1);assert.equal(h.all(node=>node.props?.['data-tutor']).length,1)
 const current={...run,progress:{...run.progress,answers:{question:1},submitted:[]}}
 h.tutorProps.onWorkspaceState({version:1,runs:[current],activeRunId:run.id});h.render();assert.match(content(h.tree),/0\s*\/\s*1 відповідей перевірено/)
 h.click('На сьогодні');h.click('Чат');h.click('Бібліотека');assert.equal(h.counts.mounts,1);assert.equal(h.counts.unmounts,0)
 assert.equal(current.progress.answers.question,1);assert.equal(h.tutorProps.openedRunScope.userId,scopeA.userId)
 h.unmount();assert.equal(h.counts.unmounts,1)
})

test('an account or login-session switch aborts an archive request and discards late private results',async()=>{
 for(const target of[scopeB,{...scopeA,sessionId:'new-session'}]){
  const pending=deferred(),h=harness({getRun:()=>pending.promise,stateFor:scope=>library(scope,{runs:scope.sessionId===scopeA.sessionId?[fixture('private-first-account')]:[],document:{notes:scope.sessionId===scopeA.sessionId?[{id:'note-private',title:'Приватний синтетичний конспект',subject:'',text:'Синтетичний текст',updatedAt:'2026-11-17T10:00:00Z'}]:[],reviews:[]}})})
  await h.settle();h.click('Продовжити');const request=h.calls.find(call=>call[0]==='getRun');assert.ok(request)
  h.props.scope=target;h.render();await h.settle();assert.equal(request[2].aborted,true);assert.equal(h.controllers[0].disposed,true)
  pending.resolve(fixture('private-late-response'));await h.settle()
  assert.doesNotMatch(content(h.tree),/private-first-account|private-late-response|Приватний синтетичний конспект/);assert.equal(h.tutorProps.openedRun,undefined);h.unmount()
 }
})

test('a rejected save retains the complete note draft and a read-only former subscriber cannot mutate it',async()=>{
 const h=harness({editError:'Синтетична помилка збереження'});await h.settle();h.click('Конспект');h.change('Назва','Мій конспект');h.change('Предмет','Економіка');h.change('Текст конспекту','Цей текст має залишитися після помилки.');h.click('Зберегти конспект')
 assert.equal(h.field('Текст конспекту').props.value,'Цей текст має залишитися після помилки.');assert.match(content(h.tree),/Синтетична помилка збереження/);h.unmount()
 const note={id:'saved-note',title:'Збережений конспект',subject:'',text:'Збережений синтетичний текст.',updatedAt:'2026-11-17T10:00:00Z'},readonly=harness({props:{canEdit:false},stateFor:scope=>({...library(scope,{document:{notes:[note],reviews:[]}}),canEdit:false})});await readonly.settle();assert.equal(readonly.button('Конспект').props.disabled,true);readonly.click('Відкрити');assert.equal(readonly.field('Текст конспекту').props.readOnly,true);assert.equal(readonly.button('Зберегти конспект').props.disabled,true);assert.equal(readonly.calls.some(call=>call[0]==='edit'),false);readonly.unmount()
})

test('oversized source notes remain complete and only an explicitly selected excerpt is sent to the shared composer',async()=>{
 const text='Синтетичний текст. '.repeat(900),note={id:'long-note',title:'Довгий конспект',subject:'',text,updatedAt:'2026-11-17T10:00:00Z'},h=harness({stateFor:scope=>library(scope,{document:{notes:[note],reviews:[]}})});await h.settle();h.click('Розібрати конспект Довгий конспект');assert.equal(h.field('Текст конспекту').props.value,text);assert.match(content(h.tree),/Виділи потрібний уривок/);assert.equal(h.tutorProps.coachAction,undefined)
 h.select(0,31);h.click('Розібрати виділене');assert.equal(h.tutorProps.coachAction.source.text,text.slice(0,31).trim());assert.equal(h.tutorProps.coachAction.source.title,note.title);assert.equal(h.calls.some(call=>call[0]==='edit'),false);h.unmount()
})

test('personal review persists only scheduling metadata, reports offline state, and preserves original answers',async()=>{
 const run=fixture(),before=plain(run.progress),h=harness({props:{initialTab:'today'},editPhase:'offline',stateFor:scope=>library(scope,{runs:[run]})});await h.settle();h.click('Синтетичне запитання');h.click('Відповідь B');h.click('Показати пояснення');assert.match(content(h.tree),/Правильно\./);h.click('Пам’ятаю');assert.match(content(h.tree),/Без зв’язку · зміни на пристрої/)
 const doc=h.controllers[0].state().document;assert.equal(doc.reviews.length,1);assert.equal(doc.reviews[0].rating,'good');assert.equal(doc.notes.length,0);assert.deepEqual(plain(run.progress),before);assert.equal(h.calls.some(call=>['getRun','getRuns','loadRuns'].includes(call[0])),false);h.unmount()
})

test('unloaded due reviews are counted and recovered in bounded batches without falsely claiming completion',async()=>{
 const pending=deferred(),reviews=Array.from({length:35},(_,i)=>({id:'review-'+i,runId:'old-'+i,itemId:'question',kind:'mistake',rating:'again',dueAt:'2026-01-01T00:00:00Z',intervalDays:0,repetitions:0})),h=harness({props:{initialTab:'today'},stateFor:scope=>library(scope,{document:{notes:[],reviews}}),getRuns:()=>pending.promise});await h.settle()
 const calls=h.calls.filter(call=>call[0]==='getRuns');assert.equal(calls.length,1);assert.equal(calls[0][1].length,30);assert.equal(h.calls.some(call=>call[0]==='getRun'),false);assert.match(content(h.tree),/35\s*для повторення сьогодні/);assert.match(content(h.tree),/Відкрий попередні повторення/)
 pending.resolve({scope:scopeA,runs:reviews.slice(0,30).map(review=>fixture(review.runId)),nextRunIds:[]});await h.settle();assert.equal(h.calls.filter(call=>call[0]==='getRuns').length,1,'loading one batch must not trigger a request storm');assert.match(content(h.tree),/Ще 5 повторень/);h.unmount()
})

test('Max reuses the cloud library without a hidden second assistant and forwards sources through the parent callback',async()=>{
 const actions=[],note={id:'max-note',title:'Спільна бібліотека',subject:'',text:'Синтетичний матеріал.',updatedAt:'2026-11-17T10:00:00Z'},opened=[],h=harness({props:{experience:'max',onOpenChat:action=>actions.push(action),onOpenRun:run=>opened.push(run)},stateFor:scope=>library(scope,{runs:[fixture()],document:{notes:[note],reviews:[]}})});await h.settle();assert.equal(h.counts.mounts,0);h.click('Розібрати конспект Спільна бібліотека');assert.equal(actions[0].source.text,note.text);h.click('Продовжити');await h.settle();assert.equal(opened.length,1);assert.equal(h.counts.mounts,0);h.unmount()
})

test('conflict resolution requires an explicit confirmation and never silently overwrites either version',async()=>{
 const h=harness({stateFor:scope=>({...library(scope),phase:'conflict',hasLocalChanges:true})});await h.settle();assert.match(content(h.tree),/Твої зміни залишилися на цьому пристрої/);h.confirm(false);h.click('Взяти версію Xelay');h.click('Зберегти мою версію');assert.equal(h.calls.some(call=>call[0]==='server'||call[0]==='local'),false);h.confirm(true);h.click('Зберегти мою версію');assert.equal(h.calls.filter(call=>call[0]==='local').length,1);h.unmount()
})
