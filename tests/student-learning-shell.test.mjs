import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {randomUUID} from 'node:crypto'
import ts from 'typescript'

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const nodes=node=>node==null||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
function load(path,imports,globals={}){const module={exports:{}};runInNewContext(ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Date,Number,JSON,Set,Map,AbortController,crypto:{randomUUID},...globals,require(name){assert.ok(name in imports,'Known dependency '+name);return imports[name]}});return module.exports}
function harness({withHeader=true}={}){
 const instances=new Map(),elements=new Map(),storage=new Map(),effects=[],host={id:'xelay-learning-navigation'},clients=[],requests=[]
 let auth={authUser:{id:'owner-a'},xelayUser:{id:'owner-a',name:'Синтетичний Студент',firstName:'Синтетичний'},authReadEpoch:1,authReadBlocked:false,isLoading:false,sessionUnavailable:false,refreshUser(){}},current,dirty=false,tree,mounts=0,unmounts=0,seen
 const jsx=(type,props,key)=>({type,props:props||{},key}),same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 let studio
 const hooks={
  useState(initial){const instance=current,at=instance.cursor++;instance.cells[at]??={value:typeof initial==='function'?initial():initial};return[instance.cells[at].value,next=>{const old=instance.cells[at].value,value=typeof next==='function'?next(old):next;if(!Object.is(old,value)){instance.cells[at].value=value;dirty=true}}]},
  useRef(initial){return current.cells[current.cursor++]??={current:initial}},
  useMemo(fn,deps){const at=current.cursor++;if(!current.cells[at]||!same(current.cells[at].deps,deps))current.cells[at]={deps,value:fn()};return current.cells[at].value},
  useEffect(fn,deps){const instance=current,at=instance.cursor++,old=instance.cells[at];if(!old||!same(old.deps,deps)){instance.cells[at]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();instance.cells[at].cleanup=fn()})}},
  lazy(factory){const body=String(factory);if(body.includes('MaxLearningStudio'))return props=>jsx(studio,props);return props=>jsx('mock-tool',{'data-tool':body.match(/(?:StudentDeskTools|StudyWorkbench|StudentPracticeLab|MaxExamPreparation|MaxTutorActivity)/)?.[0]||'optional',...props})},
  Suspense:props=>props.children,
 }
 hooks.useLayoutEffect=hooks.useEffect;hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps);hooks.useId=()=>hooks.useMemo(()=>randomUUID(),[])
 const shared={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'react-dom':{createPortal:(children,target)=>jsx('portal',{children,target})},'lucide-react':new Proxy({},{get:(_,key)=>String(key)})}
 const globals={window:{addEventListener(){},removeEventListener(){}},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},document:{getElementById:id=>withHeader&&id===host.id?host:null}}
 const studioData=load('src/lib/maxStudio.ts',{})
 studio=load('src/components/student/MaxLearningStudio.tsx',{...shared,'../../lib/maxStudio':studioData,'../../lib/maxTutorCoach':{sendMaxTutorCoachEvent(){}},'./StudentLearningGuide':{StudentLearningGuide:()=>null},'./maxLearningStudio.css':{}},globals).default
 function ProductionAssistant(){hooks.useEffect(()=>{mounts++;return()=>unmounts++},[]);return jsx('div',{'data-live-assistant':true,children:'Особистий чат'})}
 const page=load('src/pages/StudentLearningPage.tsx',{...shared,'../context/AuthContext':{useAuth:()=>auth},'../components/AuthModal':{AuthModal:()=>null},'../components/XelayLogo':{XelayLogo:()=>jsx('svg',{})},'../components/student/StudentLearningGuide':{StudentLearningGuide:()=>null},'../components/student/ProductionMaxTutorAssistant':{ProductionMaxTutorAssistant:ProductionAssistant},'../lib/supabase':{supabase:{auth:{getSession(){throw Error('A layout change must not fetch a new session')}}}},'../lib/maxTutorProductionClient':{createMaxTutorProductionClient:options=>{clients.push(options.ownerId);return{status:async()=>{requests.push(options.ownerId);return{planId:'max',audience:'student',scope:{userId:options.ownerId,sessionId:'synthetic-session'},canGenerate:true,canEdit:true}}}}},'./studentLearningPage.css':{}},globals)
 function expand(node,path='root'){
  if(node==null||typeof node!=='object')return node
  if(Array.isArray(node))return node.map((child,at)=>expand(child,path+':'+(child?.key??at)))
  if(typeof node.type==='function'){const key=path+'/'+node.type.name+':'+(node.key??''),instance=instances.get(key)||{cells:[],cursor:0};instances.set(key,instance);seen.add(key);instance.cursor=0;const old=current;current=instance;const result=node.type(node.props);current=old;return expand(result,key)}
  let element=elements.get(path);if(!element){element={open:false,querySelector(){return null}};elements.set(path,element)}
  if(typeof node.props.ref==='function')node.props.ref(element);else if(node.props.ref)node.props.ref.current=element
  return{...node,props:{...node.props,children:expand(node.props.children,path+'/'+node.type)}}
 }
 function render(){for(let i=0;i<30;i++){dirty=false;seen=new Set();tree=expand(jsx(page.StudentLearningPage,{}));for(const[key,instance]of instances)if(!seen.has(key)){for(const cell of instance.cells)cell?.cleanup?.();instances.delete(key)}effects.splice(0).forEach(fn=>fn());if(!dirty)return}throw Error('Hooks did not settle')}
 render()
 return{render,setAuth(value){auth=value;render()},get auth(){return auth},get tree(){return tree},clients,requests,host,get mounts(){return mounts},get unmounts(){return unmounts},button(label){return nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node).trim()===label))},all:fn=>nodes(tree).filter(fn),async settle(){for(let i=0;i<15;i++){await Promise.resolve();render()}}}
}

test('the immersive page portals one studio navigation to the existing header and keeps a single assistant while tools change',async()=>{
 const h=harness();await h.settle()
 assert.deepEqual(h.clients,['owner-a']);assert.deepEqual(h.requests,['owner-a']);assert.equal(h.mounts,1)
 assert.equal(h.all(node=>node.props?.className?.includes('slp-local-rail')).length,0)
 assert.equal(h.all(node=>node.type==='portal'&&node.props.target===h.host).length,2)
 assert.equal(h.all(node=>node.props?.['aria-label']==='Розділи Студії Макс').length,1)
 for(const label of ['Мої інструменти','Власна практика']){assert.ok(h.button(label),h.all(node=>node.type==='button').map(text).join('|'));h.button(label).props.onClick();await h.settle();assert.equal(h.mounts,1);assert.equal(h.unmounts,0);assert.equal(h.all(node=>node.props?.['data-live-assistant']).length,1)}
 h.button('Чат').props.onClick();await h.settle()
 assert.equal(h.all(node=>node.props?.className==='slp-max-canvas')[0].props.hidden,false)
 assert.equal(h.button('Чат').props['aria-current'],'page');assert.equal(h.mounts,1);assert.deepEqual(h.requests,['owner-a'])
})

test('a missing app header gets one fallback rail, while identity replacement and blocked reads remove the old workspace',async()=>{
 const fallback=harness({withHeader:false});await fallback.settle()
 assert.equal(fallback.all(node=>node.type==='aside'&&node.props?.['aria-label']==='Меню навчального простору').length,1)
 assert.equal(fallback.all(node=>node.props?.['aria-label']==='Розділи Студії Макс').length,1)
 const h=harness();await h.settle()
 h.setAuth({...h.auth,authUser:{id:'owner-b'},xelayUser:{id:'owner-b',name:'Інший Синтетичний'},authReadEpoch:2});await h.settle()
 assert.deepEqual(h.clients,['owner-a','owner-b']);assert.deepEqual(h.requests,['owner-a','owner-b']);assert.equal(h.unmounts,1)
 h.setAuth({...h.auth,authReadBlocked:true});await h.settle()
 assert.equal(h.all(node=>node.props?.['data-live-assistant']).length,0);assert.equal(h.unmounts,2)
 assert.deepEqual(h.requests,['owner-a','owner-b']);assert.doesNotMatch(text(h.tree),/Особистий чат/)
})
