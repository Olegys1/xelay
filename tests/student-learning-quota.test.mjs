import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=()=>readFileSync(new URL('../src/components/student/StudentLearningQuota.tsx',import.meta.url),'utf8')
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
function harness(extra={}){
 let cursor=0,dirty=false,tree,focused=null,networkCalls=0;const cells=[],effects=[],dom=new Map(),listeners=new Map(),portalTargets=[],body={id:'synthetic-body'}
 const document={body,get activeElement(){return focused},addEventListener(name,fn){listeners.set(name,[...(listeners.get(name)||[]),fn])},removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(value=>value!==fn))}}
 const window={innerWidth:1200,innerHeight:900,addEventListener(name,fn){listeners.set('window:'+name,[...(listeners.get('window:'+name)||[]),fn])},removeEventListener(name,fn){listeners.set('window:'+name,(listeners.get('window:'+name)||[]).filter(value=>value!==fn))}}
 const props={budget:{limitUsd:10,remainingUsd:7.8},resetsAt:'2026-12-17T12:00:00Z',canGenerate:true,...extra}
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 const hooks={useState(initial){const at=cursor++;cells[at]??={value:typeof initial==='function'?initial():initial};return [cells[at].value,next=>{const value=typeof next==='function'?next(cells[at].value):next;if(!Object.is(value,cells[at].value)){cells[at].value=value;dirty=true}}]},useRef(initial){return cells[cursor++]??={current:initial}},useMemo(fn,deps){const at=cursor++;if(!cells[at]||!same(cells[at].deps,deps))cells[at]={deps,value:fn()};return cells[at].value},useEffect(fn,deps){const at=cursor++;if(!cells[at]||!same(cells[at].deps,deps)){const previous=cells[at];cells[at]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[at].cleanup=fn()})}}};hooks.useLayoutEffect=hooks.useEffect;hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps);hooks.useId=()=>hooks.useMemo(()=>'quota-synthetic',[])
 const jsx=(type,props,key)=>({type,props:props||{},key}),module={exports:{}}
 runInNewContext(ts.transpileModule(source(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,document,window,Date,Intl,Math,Number,JSON,Set,Map,requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},fetch(){networkCalls++;throw Error('Quota display must not make network calls')},require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};if(name==='react-dom')return {createPortal(children,target){portalTargets.push(target);return jsx('test-portal',{children,target})}};if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name==='./studentLearningQuota.css')return {};throw Error('Unexpected quota dependency '+name)}})
 function expand(node,path='root'){
  if(node==null||typeof node!=='object')return node
  if(Array.isArray(node))return node.map((item,index)=>expand(item,path+':'+(item?.key??index)))
  if(typeof node.type==='function')return expand(node.type(node.props),path+'/'+node.type.name)
  const domPath=node.type==='test-portal'?'document-body/portal':path
  let element=dom.get(domPath)
  if(!element){element={type:node.type,path:domPath,props:node.props,isConnected:true,focus(){focused=this},getClientRects(){return [{}]},closest(){return null},contains(other){return other===this||typeof other?.path==='string'&&other.path.startsWith(domPath+'/')},getBoundingClientRect(){return {left:100,top:500,right:144,bottom:544,width:44,height:44}},querySelector(selector){return this.querySelectorAll(selector)[0]||null},querySelectorAll(){return [...dom.values()].filter(candidate=>candidate.path.startsWith(domPath+'/')&&candidate.type==='button'&&!candidate.props.disabled)}};dom.set(domPath,element)}
  element.props=node.props
  if(typeof node.props.ref==='function')node.props.ref(element);else if(node.props.ref)node.props.ref.current=element
  return {...node,__domPath:domPath,props:{...node.props,children:expand(node.props.children,domPath+'/'+node.type)}}
 }
 function render(){for(let attempt=0;attempt<25;attempt++){dirty=false;cursor=0;tree=expand(jsx(module.exports.StudentLearningQuota,props));effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Quota hooks did not settle')}
 render();return {props,render,api:module.exports,document,body,portalTargets,get tree(){return tree},get networkCalls(){return networkCalls},get focused(){return focused},setFocus(target){focused=target},all:predicate=>nodes(tree).filter(predicate),find:predicate=>nodes(tree).find(predicate),button:()=>nodes(tree).find(node=>node.type==='button'&&String(node.props['aria-label']||'').includes('Ліміти ШІ')),element(node){return dom.get(node.__domPath)},open(){const button=this.button();assert.ok(button,'Quota is a labelled native button');focused=this.element(button);button.props.onClick();render()},dispatch(name,event){for(const listener of [...listeners.get(name)||[]])listener(event);render()},unmount(){cells.forEach(cell=>cell?.cleanup?.());dom.forEach(element=>{element.isConnected=false})}}
}

test('quota percentages are finite, floored and bounded without exposing an allowance as more than 100 percent',()=>{
 const {quotaPercent}=harness().api
 for(const [limit,remaining,expected]of [[10,7.8,78],[10,7.999,79],[10,0,0],[10,-3,0],[10,20,100],[0,10,0],[-2,10,0],[NaN,4,0],[Infinity,4,0],[10,NaN,0],[10,Infinity,0]])assert.equal(quotaPercent(limit,remaining),expected,`${limit}/${remaining}`)
})

test('the closed quota is an accessible circle with the current percentage and makes no request or body portal',()=>{
 const h=harness();assert.ok(h.button());assert.equal(h.button().props.type,'button');assert.ok(h.all(node=>node.type==='svg').length>0);assert.match(String(h.button().props['aria-label']),/78/);assert.equal(h.portalTargets.length,0);assert.equal(h.find(node=>node.props?.role==='dialog'),undefined);assert.doesNotMatch(text(h.tree),/\$|USD|долар|limitUsd|remainingUsd/iu);assert.equal(h.networkCalls,0);h.unmount()
})

test('opening details uses a body portal with a nonmodal labelled dialog and no currency or duplicated model request',()=>{
 const h=harness();h.open();const panel=h.find(node=>node.props?.role==='dialog');assert.ok(panel);assert.equal(panel.props['aria-label']||text(h.find(node=>node.props?.id===panel.props['aria-labelledby'])),'Ліміти ШІ');assert.ok([undefined,false,'false'].includes(panel.props['aria-modal']));assert.equal(h.portalTargets.at(-1),h.body);assert.match(text(panel),/78/);assert.doesNotMatch(text(panel),/\$|USD|долар|limitUsd|remainingUsd/iu);assert.equal(h.networkCalls,0);h.unmount()
})

test('Escape closes quota details and returns keyboard focus to the original button',()=>{
 const h=harness();h.open();const button=h.element(h.button());h.dispatch('keydown',{key:'Escape',preventDefault(){}});assert.equal(h.find(node=>node.props?.role==='dialog'),undefined);assert.equal(h.focused,button);assert.equal(h.networkCalls,0);h.unmount()
})

test('inside pointer interaction keeps details open, while an outside pointer closes them without stealing its focus',()=>{
 const h=harness();h.open();const panel=h.element(h.find(node=>node.props?.role==='dialog'));h.dispatch('pointerdown',{target:panel});assert.ok(h.find(node=>node.props?.role==='dialog'));const outside={path:'outside-private-ui'};h.setFocus(outside);h.dispatch('pointerdown',{target:outside});assert.equal(h.find(node=>node.props?.role==='dialog'),undefined);assert.equal(h.focused,outside);h.unmount()
})

test('a changed quota updates the open display and an exhausted or disabled allowance remains informational',()=>{
 const h=harness();h.open();h.props.budget={limitUsd:10,remainingUsd:1.23};h.render();assert.match(text(h.find(node=>node.props?.role==='dialog')),/12/);h.props.budget={limitUsd:10,remainingUsd:0};h.props.canGenerate=false;h.props.resetsAt=null;h.render();assert.match(String(h.button().props['aria-label']),/0/);assert.ok(h.find(node=>node.props?.role==='dialog'));assert.equal(h.networkCalls,0);assert.doesNotMatch(text(h.tree),/\$|USD|долар/iu);h.unmount()
})

test('the close control restores the trigger, and the displayed reset date uses Kyiv time without accepting an invalid date',()=>{
 const h=harness({resetsAt:'2026-12-17T23:30:00Z'});h.open();assert.match(text(h.find(node=>node.props?.role==='dialog')),/18 грудня/)
 const trigger=h.element(h.button());h.find(node=>node.type==='button'&&node.props['aria-label']==='Закрити ліміти').props.onClick();h.render();assert.equal(h.find(node=>node.props?.role==='dialog'),undefined);assert.equal(h.focused,trigger)
 h.props.resetsAt='malformed-date';h.open();assert.doesNotMatch(text(h.tree),/Invalid Date|NaN/);assert.equal(h.networkCalls,0);h.unmount()
})
