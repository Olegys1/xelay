import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import * as workspace from '../src/lib/deanWorkspace.ts'

const nodes=n=>n==null||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)]
const text=n=>n==null||typeof n==='boolean'?'':Array.isArray(n)?n.map(text).join(' '):typeof n==='object'?text(n.props?.children):String(n)
function harness(file,exportName,props){
 const cells=[],effects=[];let cursor=0,tree,dirty=true
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
 const hooks={
  useState(initial){const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{const v=typeof next==='function'?next(cells[i].value):next;if(!Object.is(v,cells[i].value)){cells[i].value=v;dirty=true}}]},
  useRef(initial){return cells[cursor++]??={current:initial}},
  useMemo(fn,deps){const i=cursor++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn()};return cells[i].value},
  useEffect(fn,deps){const i=cursor++,old=cells[i];if(!old||!same(old.deps,deps)){cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[i].cleanup=fn()})}}
 }
 const jsx=(type,props)=>({type,props:props??{}})
 const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,key)=>key}),'../lib/deanWorkspace':workspace,'../lib/supabase':{supabase:{}},'../context/AuthContext':{},'../components/AuthModal':{},'../components/AdminSecurityGate':{},'../components/PrivacyConsentNotice':{},'../components/DeanOnlinePlanner':{DeanOnlinePlanner:'Planner',DeanStaffAccounts:'Staff'},'../components/DeanInputs':{DeanInputs:'Inputs'},'../components/DeanShell':{DeanShell:'Shell',DeanGuide:'Guide'},'./deanWorkspace.css':{}}
 const module={exports:{}}
 runInNewContext(ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Set,Map,Date,Math,Number,JSON,Error,setInterval:()=>1,clearInterval(){},require(name){assert.ok(name in imports,'Known import '+name);return imports[name]}})
 const Component=module.exports[exportName]
 const render=()=>{cursor=0;dirty=false;tree=Component(props);while(effects.length)effects.shift()()}
 return {get tree(){return tree},async settle(){for(let i=0;i<15;i++){if(dirty)render();await new Promise(resolve=>setImmediate(resolve))}assert.equal(dirty,false,'No render loop')},update(value){props={...props,...value};dirty=true},navigate(section){tree.props.onSection(section)},unmount(){for(const cell of cells)cell?.cleanup?.()}}
}
const source={students:[{id:'s',name:'Synthetic student',group:'G'}],events:[{id:'e',course:'Synthetic course',teacher:'Synthetic teacher',teacherIds:['t'],studentIds:['s'],activity:'lecture',day:1,period:1,weeks:[1]}],metadata:{},blockers:[]}
const draft={id:'d',title:'Synthetic draft',revision:1,document:{source,mapping:{},monday:'',rows:[]},approved_revision:null,published_revision:null}

test('calendar opens with two reads, requests directories on demand and keeps staff credentials mounted',async t=>{
 const calls=[]
 const h=harness('src/pages/DeanWorkspacePage.tsx','DeanWorkspace',{async rpc(action){calls.push(action);if(action==='bootstrap')return{admin:true,drafts:[draft],draft};if(action==='main_summary')return{main:{draft_id:'d',revision:1,version:1},canSelect:true};if(action==='main')return{main:{draft_id:'d',revision:1,version:1,document:draft.document},canSelect:true};if(action==='catalog')return{groups:[]};if(action==='teacher_catalog')return[];throw Error('Unexpected '+action)}});t.after(()=>h.unmount())
 await h.settle();assert.deepEqual(calls,['bootstrap','main_summary']);assert.ok(nodes(h.tree).some(n=>n.type==='Planner'));assert.equal(nodes(h.tree).some(n=>n.type==='Staff'),false)
 h.navigate('people');await h.settle();assert.deepEqual(calls.slice(2),['catalog','teacher_catalog'])
 h.navigate('schedule');await h.settle();assert.equal(calls.length,4)
 h.navigate('main');await h.settle();assert.equal(calls.at(-1),'main');assert.ok(nodes(h.tree).some(n=>n.type==='Planner'&&n.props.readOnly&&n.props.source.events.length===1))
 h.navigate('access');await h.settle();assert.ok(nodes(h.tree).some(n=>n.type==='Staff'))
 h.navigate('schedule');await h.settle();assert.ok(nodes(h.tree).some(n=>n.type==='Staff'),'Leaving access must not lose newly issued passwords')
 assert.ok(calls.every(a=>['bootstrap','main_summary','main','catalog','teacher_catalog'].includes(a)))
})

test('planner defers job history while calendar selectors still work',async t=>{
 const calls=[]
 const h=harness('src/components/DeanOnlinePlanner.tsx','DeanOnlinePlanner',{source,draft,dirty:false,onApply(){throw Error('No mutations')},api:{async online(a){calls.push(a);return[]},server(){throw Error('No calculation on opening')}}});t.after(()=>h.unmount())
 await h.settle();assert.deepEqual(calls,[]);assert.match(text(h.tree),/Synthetic course/)
 const teacher=nodes(h.tree).find(n=>n.type==='button'&&text(n)==='Викладачі');teacher.props.onClick();await h.settle();assert.match(text(h.tree),/Synthetic teacher/);assert.deepEqual(calls,[])
 h.update({view:'variants'});await h.settle();assert.deepEqual(calls,['jobs'])
 h.update({view:'schedule'});await h.settle();assert.deepEqual(calls,['jobs'])
})

test('denied bootstrap renders no protected planner or directory',async t=>{
 const calls=[];const h=harness('src/pages/DeanWorkspacePage.tsx','DeanWorkspace',{async rpc(action){calls.push(action);throw Error('Access denied')}});t.after(()=>h.unmount());await h.settle()
 assert.deepEqual(calls,['bootstrap']);assert.equal(nodes(h.tree).some(n=>n.type==='Planner'||n.type==='Staff'),false);assert.match(text(h.tree),/Access denied/)
})
