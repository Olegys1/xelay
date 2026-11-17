import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import postcss from 'postcss'

const root=new URL('../',import.meta.url),scope={userId:'coach-student',sessionId:'coach-session'},other={userId:'other-student',sessionId:'other-session'}
const compile=(file,suffix='')=>ts.transpileModule(readFileSync(new URL(file,root),'utf8')+suffix,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const library={exports:{}}
vm.runInNewContext(compile('src/lib/maxTutorCoach.ts'),{module:library,exports:library.exports,Date,Math,JSON,Number,Set,Map})
const c=library.exports,plain=value=>JSON.parse(JSON.stringify(value)),sameDeps=(a,b)=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
const all=(node,result=[])=>{if(Array.isArray(node))for(const child of node)all(child,result);else if(node&&typeof node==='object'&&node.props){result.push(node);all(node.props.children,result)}return result}

/** Runs the actual mounted Coach hooks, reducer, owner store and portal output.
 * DOM/event/timer boundaries are synthetic; no requests or real accounts exist. */
function harness(options={}){
 const storage=options.storage||new Map(),states=[],refs=[],effects=[],handlers=new Map(),timers=new Map(),dom=new Map(),observations=[],actions=[]
 let cursor=0,dirty=false,queued=[],tree,timerId=0,id=0,unmounted=false
 const eventTarget=prefix=>({addEventListener(name,listener){const key=prefix+name,set=handlers.get(key)||new Set();set.add(listener);handlers.set(key,set)},removeEventListener(name,listener){handlers.get(prefix+name)?.delete(listener)}})
 const document={...eventTarget('document:'),visibilityState:'visible',body:{type:'BODY'},activeElement:null}
 const window={...eventTarget('window:'),innerWidth:options.width||1440,innerHeight:options.height||900,visualViewport:options.viewport?{...eventTarget('viewport:'),...options.viewport}:undefined}
 const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}
 if(!storage.has(c.coachStorageKey(options.scope||scope))&&options.enabled){let state=c.setCoachEnabled(c.createCoachState(options.scope||scope),true);if(options.hint)state=c.reduceCoachEvent(state,{type:'ready',runId:'own-run',mode:'quiz'});storage.set(c.coachStorageKey(options.scope||scope),c.storeCoachState(state))}
 const hooks={
  useState(initial){const at=cursor++;if(!(at in states))states[at]=typeof initial==='function'?initial():initial;return[states[at],value=>{const next=typeof value==='function'?value(states[at]):value;if(!Object.is(next,states[at])){states[at]=next;dirty=true}}]},
  useRef(initial){const at=cursor++;return refs[at]||(refs[at]={current:initial})},
  useEffect(effect,deps){const at=cursor++,prior=effects[at];if(!sameDeps(prior?.deps,deps))queued.push(()=>{prior?.cleanup?.();effects[at]={deps,cleanup:effect()}})},
  useId(){const at=cursor++;return refs[at]||(refs[at]='coach-popup-'+(++id))},
 }
 hooks.useLayoutEffect=hooks.useEffect
 const host=node=>{const key=node.props.id||node.props['aria-label']||node.props.className||node.type;if(!dom.has(key)){const element={key,isConnected:true,focus(){if([...element.ancestors||[]].some(node=>node.style?.visibility==='hidden'))return;document.activeElement=element},getBoundingClientRect:()=>options.rect||{left:16,right:232,top:738,bottom:790},contains(target){return target===element||target?.ancestors?.has(element)},closest:()=>null};dom.set(key,element)}const element=dom.get(key);element.style=node.props.style||{};return element}
 const jsx=(type,props,key)=>{const node={type,key,props:props||{}};if(typeof type==='string'&&props?.ref&&typeof props.ref==='object')props.ref.current=host(node);return node}
 class ResizeObserver{constructor(callback){this.callback=callback;observations.push(this)}observe(element){this.element=element}disconnect(){this.disconnected=true}}
 const module={exports:{}}
 vm.runInNewContext(compile('src/components/student/MaxTutorCoach.tsx','\nexport {ScopedMaxTutorCoach}'),{module,exports:module.exports,window,document,localStorage,Date,Math,Number,Set,Map,ResizeObserver,setInterval(callback,delay){const key=++timerId;timers.set(key,{callback,delay});return key},clearInterval:key=>timers.delete(key),require(name){
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'};if(name==='react-dom')return{createPortal:(children,container)=>({type:'PORTAL',props:{children,container}})}
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});if(name==='../../lib/maxTutorCoach')return c;if(name.endsWith('.css'))return{};throw Error('Unexpected Coach dependency '+name)
 }})
 const props={scope:options.scope||scope,currentBlock:'assistant',onAction:action=>actions.push(action),portalPanels:options.footer!==false,visible:true}
 const attach=(node,ancestors=new Set())=>{if(Array.isArray(node)){for(const child of node)attach(child,ancestors);return}if(!node?.props)return;const element=host(node);element.ancestors=new Set(ancestors);const next=new Set(ancestors);next.add(element);attach(node.props.children,next)}
 const render=()=>{let count=0;do{dirty=false;cursor=0;queued=[];tree=module.exports.ScopedMaxTutorCoach(props);attach(tree);for(const effect of queued)effect();if(++count>30)throw Error('Coach render loop')}while(dirty);return tree}
 render()
 return{props,storage,actions,timers,observations,window,document,render,get tree(){return tree},nodes:()=>all(tree),button:label=>all(tree).find(node=>node.type==='button'&&node.props['aria-label']===label),classNode:className=>all(tree).find(node=>node.props.className?.split(' ').includes(className)),portals:()=>all(tree).filter(node=>node.type==='PORTAL'),dom:label=>dom.get(label),listeners:name=>handlers.get(name)?.size||0,emit(name,event={}){for(const listener of [...handlers.get(name)||[]])listener(event);if(dirty)render()},click(label){const button=this.button(label);assert.ok(button,'Button '+label);button.props.onClick();render()},unmount(){unmounted=true;for(const effect of effects)effect?.cleanup?.();for(const element of dom.values())element.isConnected=false},get unmounted(){return unmounted},publicWrapper:module.exports.MaxTutorCoach}
}

const launcher='Налаштувати помічника поруч',close='Закрити налаштування помічника'

test('legacy floating Coach keeps panels inline and its existing close and action paths',()=>{
 const h=harness({footer:false,enabled:true,hint:true});assert.equal(h.portals().length,0);assert.equal(h.tree.props.className,'mtc');assert.ok(h.classNode('mtc-card'));assert.equal(h.document.activeElement,null)
 h.click(launcher);assert.ok(h.classNode('mtc-settings'));assert.equal(h.portals().length,0);assert.equal(h.document.activeElement,null)
 h.click(close);assert.ok(h.classNode('mtc-card'));h.classNode('mtc-primary').props.onClick();h.render();assert.deepEqual(h.actions,['quiz']);h.unmount()
})

test('footer settings use one body portal beside the rail, move focus and restore it when closed',()=>{
 const h=harness();assert.equal(h.portals().length,0);assert.match(h.tree.props.className,/mtc--footer/)
 h.click(launcher);assert.equal(h.portals().length,1);assert.equal(h.portals()[0].props.container,h.document.body)
 const popup=h.classNode('mtc-footer-popup');assert.equal(popup.props.style.left,244);assert.equal(popup.props.style.width,350);assert.equal(popup.props.style.top,790);assert.equal(popup.props.style.maxHeight,550)
 assert.equal(h.button(launcher).props['aria-controls'],popup.props.id);assert.equal(h.document.activeElement,h.dom(close));assert.equal(h.listeners('document:keydown'),1)
 h.click(close);assert.equal(h.portals().length,0);assert.equal(h.document.activeElement,h.dom(launcher));assert.equal(h.listeners('document:pointerdown'),0);assert.equal(h.listeners('window:resize'),0)
 h.unmount();assert.ok(h.observations.every(observer=>observer.disconnected))
})

test('mobile viewport and virtual keyboard constrain the popup; Escape and outside clicks release listeners',()=>{
 const h=harness({width:390,height:844,viewport:{width:390,height:380,offsetTop:120,offsetLeft:0},rect:{left:16,right:290,top:335,bottom:379}});h.click(launcher)
 const style=h.classNode('mtc-footer-popup').props.style;assert.equal(style.left,12);assert.equal(style.width,350);assert.ok(style.top<=488);assert.ok(style.top-style.maxHeight>=132)
 let prevented=0;h.emit('document:keydown',{key:'Escape',target:h.dom(close),preventDefault(){prevented++}});assert.equal(prevented,1);assert.equal(h.portals().length,0);assert.equal(h.document.activeElement,h.dom(launcher));assert.equal(h.listeners('viewport:resize'),0)
 h.click(launcher);h.emit('document:pointerdown',{target:h.dom(close)});assert.equal(h.portals().length,1,'Inside click keeps panel open')
 h.emit('document:pointerdown',{target:{}});assert.equal(h.portals().length,0);assert.equal(h.listeners('document:keydown'),0);h.unmount()
})

test('automatic hints do not steal focus; opening a modal elsewhere retains its own Escape handling',()=>{
 const h=harness({enabled:true,hint:true});const outside={id:'other-input'};h.document.activeElement=outside;assert.equal(h.portals().length,1);assert.equal(h.document.activeElement,outside)
 h.emit('document:keydown',{key:'Escape',target:{closest:()=>({getAttribute:()=>true})},preventDefault(){throw Error('Coach must not consume a modal Escape')}});assert.equal(h.portals().length,1)
 h.classNode('mtc-primary').props.onClick();h.render();assert.deepEqual(h.actions,['quiz']);assert.equal(h.portals().length,0);assert.equal(h.document.activeElement,h.dom(launcher));h.unmount()
})

test('hiding the mounted footer closes its UI but preserves owner preferences, events and one reminder timer',()=>{
 const h=harness({enabled:true,hint:true}),key=c.coachStorageKey(scope);assert.equal(h.listeners('window:'+c.MAX_TUTOR_COACH_EVENT),1);assert.equal(h.timers.size,1)
 const saved=JSON.parse(h.storage.get(key));h.props.visible=false;h.render();assert.equal(h.tree,null);assert.equal(h.portals().length,0);assert.equal(h.listeners('document:keydown'),0);assert.equal(h.listeners('window:resize'),0)
 assert.equal(JSON.parse(h.storage.get(key)).enabled,true);assert.deepEqual(JSON.parse(h.storage.get(key)).messages,saved.messages);assert.equal(h.timers.size,1)
 h.emit('window:'+c.MAX_TUTOR_COACH_EVENT,{detail:{scope,event:{type:'ready',runId:'second-run',mode:'cards'}}});assert.equal(h.tree,null);assert.equal(JSON.parse(h.storage.get(key)).messages.length,saved.messages.length+1)
 h.props.visible=true;h.render();assert.equal(h.portals().length,0,'Hidden hints stay collapsed when other tools were active');assert.equal(h.timers.size,1);assert.equal(h.listeners('window:'+c.MAX_TUTOR_COACH_EVENT),1)
 h.click('Розгорнути підказки');assert.equal(h.portals().length,1);h.unmount();assert.equal(h.timers.size,0);assert.equal(h.listeners('window:'+c.MAX_TUTOR_COACH_EVENT),0);assert.equal(h.listeners('window:pagehide'),0)
})

test('owner/session isolation survives footer portals and stale hidden actions cannot launch work',()=>{
 const h=harness({enabled:true,hint:true}),key=c.coachStorageKey(scope),before=h.storage.get(key),oldAction=h.classNode('mtc-primary').props.onClick
 h.emit('window:'+c.MAX_TUTOR_COACH_EVENT,{detail:{scope:other,event:{type:'ready',runId:'foreign-run',mode:'cards'}}});assert.equal(h.storage.get(key),before)
 h.props.visible=false;h.render();oldAction();h.render();assert.deepEqual(h.actions,[])
 const first=h.publicWrapper({scope,currentBlock:'assistant',onAction(){}}),replacement=h.publicWrapper({scope:other,currentBlock:'assistant',onAction(){}});assert.notEqual(first.key,replacement.key);assert.notEqual(first.props.scope.userId,replacement.props.scope.userId);assert.equal(h.publicWrapper({scope:{...scope,secret:'forged'},currentBlock:'assistant',onAction(){}}),null)
 h.unmount();const next=harness({scope:other,storage:h.storage});assert.equal(next.portals().length,0);assert.equal(JSON.parse(next.storage.get(c.coachStorageKey(other))).enabled,false);next.unmount()
})

test('footer layout cannot recreate a containing block or fixed corner dock; body panels retain reduced motion',()=>{
 const css=postcss.parse(readFileSync(new URL('src/components/student/maxTutorCoach.css',root),'utf8')),footer={},popup={}
 css.walkRules(rule=>{if(rule.selector==='.mtc.mtc--footer')rule.walkDecls(declaration=>{footer[declaration.prop]=declaration.value});if(rule.selector==='.mtc.mtc-footer-popup')rule.walkDecls(declaration=>{popup[declaration.prop]=declaration.value})})
 assert.equal(footer.position,'static');assert.equal(footer.contain,'style');assert.equal(footer['max-width'],'none');assert.equal(popup.position,'fixed');assert.equal(popup.contain,'style');assert.equal(popup.right,'auto');assert.equal(popup.bottom,'auto')
 assert.match(css.toString(),/@media\(prefers-reduced-motion:reduce\).*\.mtc \*/s)
})

test('footer Escape and dismiss close the full hint stack without deleting preserved pending hints',()=>{
 const h=harness({enabled:true,hint:true}),key=c.coachStorageKey(scope),initial=JSON.parse(h.storage.get(key)).messages.length;assert.ok(initial>1)
 h.classNode('mtc-card').props.onKeyDown({key:'Escape',stopPropagation(){}});h.render();assert.equal(h.portals().length,0);assert.equal(JSON.parse(h.storage.get(key)).messages.length,initial);assert.equal(h.document.activeElement,h.dom(launcher))
 h.click('Розгорнути підказки');h.click('Закрити цю підказку');assert.equal(h.portals().length,0);assert.equal(JSON.parse(h.storage.get(key)).messages.length,initial-1)
 h.click('Розгорнути підказки');h.click('Нагадати про цю підказку через десять хвилин');assert.equal(h.portals().length,0);assert.equal(JSON.parse(h.storage.get(key)).reminders.length,1);h.unmount()
})
