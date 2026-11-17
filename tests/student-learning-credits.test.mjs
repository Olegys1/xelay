import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../src/components/student/StudentLearningQuota.tsx',import.meta.url),'utf8')
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const catalogue=[{id:'credits_1000',credits:1000,priceUah:99},{id:'credits_3000',credits:3000,priceUah:249},{id:'credits_10000',credits:10000,priceUah:749}]
function harness(overrides={}){
 let cursor=0,dirty=false,tree,network=0,focus=null;const cells=[],effects=[],listeners=new Map()
 const body={id:'body'},document={body,addEventListener(name,fn){listeners.set(name,[...(listeners.get(name)||[]),fn])},removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(item=>item!==fn))}}
 const window={innerWidth:390,innerHeight:520,addEventListener(){},removeEventListener(){}}
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]))
 const hooks={useState(initial){const at=cursor++;cells[at]??={value:typeof initial==='function'?initial():initial};return[cells[at].value,next=>{const value=typeof next==='function'?next(cells[at].value):next;if(!Object.is(cells[at].value,value)){cells[at].value=value;dirty=true}}]},useRef(initial){return cells[cursor++]??={current:initial}},useEffect(fn,deps){const at=cursor++,old=cells[at];if(!old||!same(old.deps,deps)){cells[at]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[at].cleanup=fn()})}},useId(){cursor++;return'quota-credits-test'}};hooks.useLayoutEffect=hooks.useEffect
 const jsx=(type,props,key)=>({type,props:props||{},key}),module={exports:{}}
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,document,window,Intl,Date,Math,Number,Error,fetch(){network++;throw Error('No unrequested network')},require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'fragment'};if(name==='react-dom')return{createPortal:(children,target)=>jsx('portal',{children,target})};if(name==='lucide-react')return new Proxy({},{get:(_,name)=>name});if(name==='./studentLearningQuota.css')return{};throw Error('Unexpected dependency '+name)}})
 const props={budget:{limitUsd:10,remainingUsd:2.5},credits:{balanceCredits:123.456,reservedCredits:0,debtCredits:0,packages:catalogue,eligible:true,checkoutAvailable:true,mode:'live',onPurchase:async()=>{}},...overrides}
 function expand(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(expand);if(typeof node.type==='function')return expand(node.type(node.props));if(node.props.ref){const element={props:node.props,isConnected:true,focus(){focus=this},getClientRects(){return[{}]},getBoundingClientRect(){return{bottom:500,right:44,width:292,height:460}},closest(){return null},contains(){return false}};typeof node.props.ref==='function'?node.props.ref(element):node.props.ref.current=element}return{...node,props:{...node.props,children:expand(node.props.children)}}}
 function render(){for(let attempt=0;attempt<30;attempt++){dirty=false;cursor=0;tree=expand(jsx(module.exports.StudentLearningQuota,props));effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Hooks did not settle')}
 const find=predicate=>nodes(tree).find(predicate),button=label=>find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node).includes(label)))
 const api={props,render,find,button,get tree(){return tree},get network(){return network},get focus(){return focus},open(){button('Ліміти ШІ: залишилось 25%').props.onClick();render()},buy(){button('Докупити кредити').props.onClick();render()},choose(id){find(node=>node.type==='input'&&node.props.type==='radio'&&node.props.value===id).props.onChange();render()},accept(){find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});render()},unmount(){cells.forEach(cell=>cell?.cleanup?.())}}
 render();return api
}

test('credit balance is separate from period percent and lazy configuration loads only on explicit open',()=>{
 let loads=0;const h=harness({onOpen(){loads++}});assert.equal(loads,0);assert.match(h.button('Ліміти ШІ: залишилось 25%').props['aria-label'],/25%/);h.open();assert.equal(loads,1);assert.match(text(h.tree),/123,456/);assert.equal(h.network,0);assert.doesNotMatch(text(h.tree),/\$|USD|долар|limitUsd/iu);h.button('Закрити ліміти').props.onClick();h.render();h.open();assert.equal(loads,2);h.unmount()
})

test('purchase requires an explicit package and legal consent; changing package resets consent',async()=>{
 const purchased=[];const h=harness();h.props.credits.onPurchase=async id=>{purchased.push(id)};h.open();h.buy();assert.ok(h.button('Оплатити 99 грн').props.disabled);assert.match(text(h.tree),/не згорають/);assert.match(text(h.tree),/активний Макс/);assert.equal(h.find(node=>node.type==='a'&&node.props.href==='/terms').props.rel,'noopener noreferrer');h.accept();assert.equal(h.button('Оплатити 99 грн').props.disabled,false);h.choose('credits_3000');assert.equal(h.button('Оплатити 249 грн').props.disabled,true);h.accept();h.button('Оплатити 249 грн').props.onClick();await new Promise(resolve=>setImmediate(resolve));h.render();assert.deepEqual(purchased,['credits_3000']);assert.equal(h.network,0);h.unmount()
})

test('double click while preparing checkout creates only one request and never marks credits paid locally',async()=>{
 let count=0,resolve;const h=harness();h.props.credits.onPurchase=()=>{count++;return new Promise(done=>{resolve=done})};h.open();h.buy();h.accept();const click=h.button('Оплатити 99 грн').props.onClick;click();click();h.render();assert.equal(count,1);assert.ok(h.button('Готуємо оплату').props.disabled);assert.equal(h.props.credits.balanceCredits,123.456);resolve();await new Promise(resolve=>setImmediate(resolve));h.render();assert.equal(h.props.credits.balanceCredits,123.456);assert.equal(h.find(node=>node.props.role==='alert'),undefined);h.unmount()
})

test('server failure is shown safely, leaves balance unchanged, and a retry is explicit',async()=>{
 let count=0;const h=harness();h.props.credits.onPurchase=async()=>{count++;throw new Error('Оплата тимчасово недоступна')};h.open();h.buy();h.accept();h.button('Оплатити 99 грн').props.onClick();await new Promise(resolve=>setImmediate(resolve));h.render();assert.equal(count,1);assert.match(text(h.find(node=>node.props.role==='alert')),/Оплата тимчасово недоступна/);assert.equal(h.props.credits.balanceCredits,123.456);assert.equal(h.button('Оплатити 99 грн').props.disabled,false);h.unmount()
})

test('missing rollout, pending balance, inactive Max and unavailable checkout cannot create purchases',()=>{
 for(const changes of[{loading:true},{error:'unavailable'},{eligible:false},{checkoutAvailable:false},{mode:'disabled'},{packages:[]}]){let count=0;const h=harness();Object.assign(h.props.credits,changes,{onPurchase:async()=>{count++}});h.render();h.open();assert.equal(h.button('Докупити кредити').props.disabled,true);assert.equal(count,0);assert.equal(h.network,0);h.unmount()}
 const h=harness({credits:undefined});h.open();assert.equal(h.button('Докупити кредити'),undefined);h.unmount()
})

test('available balance is not reduced again by reserved credits and test payments are labelled',()=>{
 const h=harness();Object.assign(h.props.credits,{balanceCredits:10,reservedCredits:8,debtCredits:5,mode:'test'});h.render();h.open();assert.match(text(h.tree),/10/);assert.match(text(h.tree),/8\s+— у запитах/);assert.match(text(h.tree),/5\s+кредитів/);h.buy();assert.ok(h.button('Перейти до тестової оплати'));assert.doesNotMatch(text(h.tree),/\$|USD|долар/iu);h.unmount()
})

test('invalid catalog values are excluded and the purchase popup stays inside a small viewport',()=>{
 const h=harness();h.props.credits.packages=[...catalogue,{id:'fake',credits:NaN,priceUah:1},{id:'negative',credits:100,priceUah:-1}];h.open();h.buy();assert.equal(nodes(h.tree).filter(node=>node.type==='input'&&node.props.type==='radio').length,3);const panel=h.find(node=>node.props.role==='dialog');assert.equal(panel.props.style.left,12);assert.ok(panel.props.style.width<=366);assert.ok(panel.props.style.top>=12);h.unmount()
})

test('opening the package chooser moves keyboard focus to its back control and returning keeps focus in the quota panel',()=>{const h=harness();h.open();h.buy();assert.equal(h.focus.props.className,'slq-back');h.button('До лімітів').props.onClick();h.render();assert.equal(h.focus.props['aria-label'],'Закрити ліміти');assert.ok(h.button('Докупити кредити'));h.unmount()})
