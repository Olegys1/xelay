import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
const source=readFileSync(new URL('../src/components/student/StudentPurchaseCelebration.tsx',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
function harness({reduced=false,plan='max',confirmedPayment=false}={}){
 const layouts=[],effects=[],timers=new Map(),events=new Map(),phaseCalls=[],cleanups=[];let seq=0,closed=0,continued=0
 class Element{constructor(){this.inert=false;this.isConnected=true;this.className='';this.nodes=[]}focus(){document.activeElement=this}closest(){return this.inert?this:null}getClientRects(){return [{}]}contains(n){return this.nodes.includes(n)}querySelector(){return this.nodes[0]||null}querySelectorAll(){return this.nodes}remove(){const i=document.body.children.indexOf(this);if(i>=0)document.body.children.splice(i,1);this.isConnected=false}}
 const opener=new Element(),app=new Element(),alreadyInert=new Element();alreadyInert.inert=true
 const document={activeElement:opener,createElement:()=>new Element(),body:{children:[app,alreadyInert],style:{overflow:'auto'},appendChild(el){el.isConnected=true;this.children.push(el)}},addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name)}}
 const media={matches:reduced,addEventListener:(name,fn)=>events.set('media:'+name,fn),removeEventListener:(name,fn)=>{if(events.get('media:'+name)===fn)events.delete('media:'+name)}}
 const jsx=(type,props)=>({type,props}),hooks={useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>layouts.push(fn),useId:()=>`purchase-${++seq}`,useRef:value=>({current:value}),useState:fn=>[typeof fn==='function'?fn():fn,value=>phaseCalls.push(value)]}
 const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>name==='react'?hooks:name==='react-dom'?{createPortal:(value,host)=>({value,host})}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='lucide-react'?new Proxy({},{get:(_,key)=>String(key)}):{},window:{matchMedia:()=>media},document,HTMLElement:Element,setTimeout:(fn,delay)=>{const id=++seq;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id),Object,Array})
 const portal=module.exports.default({plan,confirmedPayment,onClose:()=>closed++,onContinue:()=>continued++}),section=portal.value.props.children,dialog=new Element(),closeButton=new Element(),continueButton=new Element(),skipButton=new Element();dialog.nodes=[closeButton,continueButton,skipButton];section.props.ref.current=dialog
 layouts.forEach(fn=>cleanups.push(fn()));effects.forEach(fn=>cleanups.push(fn()))
 return {portal,module,dialog,opener,app,alreadyInert,document,events,timers,phaseCalls,closeButton,continueButton,skipButton,get closed(){return closed},get continued(){return continued},cleanup:()=>cleanups.reverse().forEach(fn=>fn?.())}
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];const children=tree.props?.children;return [tree,...(Array.isArray(children)?children:[children]).flatMap(c=>Array.isArray(c)?c.flatMap(nodes):nodes(c))]}
test('portal isolates the background, traps focus and restores prior focus/inert/scroll state on close',()=>{
 const h=harness();assert.equal(h.app.inert,true);assert.equal(h.alreadyInert.inert,true);assert.equal(h.document.body.style.overflow,'hidden');assert.equal(h.document.activeElement,h.closeButton)
 let prevented=0;h.document.activeElement=h.skipButton;h.events.get('keydown')({key:'Tab',shiftKey:false,preventDefault(){prevented++}});assert.equal(h.document.activeElement,h.closeButton)
 h.document.activeElement=h.closeButton;h.events.get('keydown')({key:'Tab',shiftKey:true,preventDefault(){prevented++}});assert.equal(h.document.activeElement,h.skipButton)
 h.events.get('keydown')({key:'Escape',preventDefault(){prevented++},stopPropagation(){}});assert.equal(h.closed,1);assert.equal(prevented,3)
 h.cleanup();assert.equal(h.app.inert,false);assert.equal(h.alreadyInert.inert,true);assert.equal(h.document.body.style.overflow,'auto');assert.equal(h.document.activeElement,h.opener);assert.equal(h.document.body.children.length,2);assert.equal(h.events.size,0);assert.equal(h.timers.size,0)
})
test('three tier scenes stay bounded and explicitly demonstrate instead of charging or activating access',()=>{
 const signatures=[]
 for(const plan of ['start','plus','max']){const h=harness({plan}),all=nodes(h.portal.value),text=all.flatMap(n=>Array.isArray(n.props?.children)?n.props.children:[n.props?.children]).filter(v=>typeof v==='string').join(' ');signatures.push(h.portal.value.props.className);assert.match(text,/Демонстрація анімації · без оплати/);assert.match(text,/Платіж не виконується, підписка не активується/);assert.equal(h.module.exports.PURCHASE_PREVIEW_PARTICLES,24);assert.ok(h.module.exports.PURCHASE_PREVIEW_PARTICLES<=35);assert.equal(h.timers.size,2);assert.equal(h.continued,0);assert.equal(h.closed,0)
 const skip=all.find(n=>n.type==='button'&&String(n.props.className)==='spc-skip');skip.props.onClick();assert.equal(h.phaseCalls.at(-1),2);assert.equal(h.timers.size,0);h.cleanup()}
 assert.equal(new Set(signatures).size,3)
 assert.doesNotMatch(source,/fetch\(|supabase\.|checkout|paymentIntent|\.src\s*=|dangerouslySetInnerHTML/)
})
test('reduced motion enters a static ready state without timers and unknown plans fail to Start',()=>{
 const h=harness({reduced:true,plan:'__proto__'});assert.match(h.portal.value.props.className,/spc-start/);assert.equal(h.phaseCalls.at(-1),2);assert.equal(h.timers.size,0);h.cleanup()
 const css=readFileSync(new URL('../src/components/student/studentPurchaseCelebration.css',import.meta.url),'utf8');assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/\.spc-reduced \*/);assert.match(css,/@media\(max-width:600px\)/)
})

test('confirmed payment scenes describe verified payment while preview remains non-payment',()=>{
 const real=harness({confirmedPayment:true,plan:'max'});const collect=v=>typeof v==='string'?v:!v||typeof v!=='object'?'':Object.values(v.props||{}).filter(x=>typeof x!=='function').flatMap(x=>Array.isArray(x)?x:[x]).map(collect).join(' ');
 const text=collect(real.portal.value);assert.match(text,/Оплату підтверджено/);assert.match(text,/Строк доступу можна перевірити/);assert.doesNotMatch(text,/Демонстрація анімації · без оплати/);assert.equal(real.continued,0);real.cleanup();
})
