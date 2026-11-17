import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
function load(path,imports={},globals={}){const module={exports:{}};runInNewContext(ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Date,JSON,Set,Map,Number,Math,TextEncoder,Promise,...globals,require(name){assert.ok(name in imports,`Known dependency ${name}`);return imports[name]}});return module.exports}
const study=load('src/lib/maxTutorStudy.ts'),tutor=load('src/lib/maxTutor.ts',{'./maxTutorStudy.js':study}),workspace=load('src/lib/maxTutorQuizWorkspace.ts',{'./maxTutor':tutor})
function fixture(){const sample=tutor.createTutorDemo('own-roomy-quiz','quiz');return {...sample,id:sample.request.requestId,demo:false,createdAt:'2026-11-17T12:00:00Z',progress:tutor.emptyTutorProgress()}}

test('step subsets preserve order and fail closed on foreign or duplicated IDs instead of opening the whole plan test',()=>{
 const run=fixture(),[first,second]=run.bundle.questions
 assert.equal(workspace.tutorQuizWorkspaceQuestions(run.bundle).length,3)
 assert.deepEqual(Array.from(workspace.tutorQuizWorkspaceQuestions(run.bundle,[second.id,first.id]),q=>q.id),[second.id,first.id])
 for(const ids of [[],['foreign'],[first.id,first.id],[first.id,'foreign']])assert.equal(workspace.tutorQuizWorkspaceQuestions(run.bundle,ids).length,0)
})

test('checking selected answers is one idempotent update scoped to the requested questions and never submits blank answers',()=>{
 const run=fixture(),[first,second,third]=run.bundle.questions
 let progress=tutor.answerTutorQuestion(run.progress,run.bundle,first.id,0)
 progress=tutor.answerTutorQuestion(progress,run.bundle,second.id,0)
 const next=workspace.checkTutorQuizWorkspace(progress,run.bundle,[second.id,third.id])
 assert.deepEqual(Array.from(next.submitted),[second.id]);assert.equal(next.answers[first.id],0);assert.equal(next.answers[third.id],undefined)
 assert.equal(workspace.checkTutorQuizWorkspace(next,run.bundle,[second.id,third.id]),next,'already checked answers do not create extra grading updates')
 const summary=workspace.tutorQuizWorkspaceSummary(run.bundle,next,[second.id,third.id])
 assert.equal(summary.selected,1);assert.equal(summary.checked,1);assert.equal(summary.correct,0);assert.equal(summary.complete,false)
 assert.equal(tutor.answerTutorQuestion(next,run.bundle,second.id,2),next,'checked answers stay immutable')
})

function harness(extra={}){
 const instances=new Map(),effects=[],dom=new Map(),listeners=new Map(),raf=[];let current,dirty=false,tree,seen=new Set(),domSeen=new Set(),finishCount=0,updates=0,closeCount=0,fullscreenRequests=0,fullscreenExits=0,fullscreenReject=false
 const opener={isConnected:true,focus(){doc.activeElement=opener}},doc={activeElement:null,fullscreenElement:null,documentElement:{style:{overflow:"auto"}},addEventListener(name,fn){listeners.set(name,[...(listeners.get(name)||[]),fn])},removeEventListener(name,fn){listeners.set(name,(listeners.get(name)||[]).filter(value=>value!==fn))},async exitFullscreen(){fullscreenExits++;doc.fullscreenElement=null;(listeners.get('fullscreenchange')||[]).forEach(fn=>fn())}};doc.activeElement=opener
 const props={open:true,run:fixture(),enabled:true,onProgress(update){const next=update(props.run.progress);if(next!==props.run.progress){updates++;props.run={...props.run,progress:next};dirty=true}},onClose(){closeCount++;props.open=false;dirty=true},onFinish(){finishCount++},...extra}
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 const hooks={useState(initial){const instance=current,at=instance.cursor++;instance.cells[at]??={value:typeof initial==='function'?initial():initial};return [instance.cells[at].value,next=>{const value=typeof next==='function'?next(instance.cells[at].value):next;if(!Object.is(value,instance.cells[at].value)){instance.cells[at].value=value;dirty=true}}]},useRef(initial){const at=current.cursor++;return current.cells[at]??={current:initial}},useEffect(fn,deps){const instance=current,at=instance.cursor++;if(!instance.cells[at]||!same(instance.cells[at].deps,deps)){const previous=instance.cells[at];instance.cells[at]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();instance.cells[at].cleanup=fn()})}}}
 const jsx=(type,props,key)=>({type,props:props||{},key}),ui=load('src/components/student/MaxTutorQuizWorkspace.tsx',{react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),'../../lib/maxTutor':tutor,'../../lib/maxTutorQuizWorkspace':workspace,'./maxTutorQuizWorkspace.css':{}},{document:doc,requestAnimationFrame(fn){raf.push(fn)},matchMedia(){return {matches:true}}})
 function expand(node,path='root'){
  if(node==null||typeof node!=='object')return node
  if(Array.isArray(node))return node.map((item,index)=>expand(item,path+':'+(item?.key??index)))
  if(typeof node.type==='function'){const key=path+'/'+node.type.name+':'+(node.key??''),instance=instances.get(key)||{cells:[],cursor:0};instances.set(key,instance);seen.add(key);instance.cursor=0;const previous=current;current=instance;const result=node.type(node.props);current=previous;return expand(result,key)}
  domSeen.add(path);let element=dom.get(path)
  if(!element){element={type:node.type,props:node.props,path,open:false,isConnected:true,focus(){doc.activeElement=this},getClientRects(){return [{}]},showModal(){this.open=true},close(){this.open=false},scrollIntoView(){},scrollTo(){},querySelectorAll(selector){return [...dom.values()].filter(item=>item.path.startsWith(path+'/')&&!item.props.disabled&&(selector==='h2'?item.type==='h2':selector==='[data-quiz-autofocus]'?item.props['data-quiz-autofocus']!==undefined:['button','input','select'].includes(item.type)||item.props.tabIndex===0))},querySelector(selector){return this.querySelectorAll(selector)[0]||null},async requestFullscreen(){fullscreenRequests++;if(fullscreenReject)throw Error('denied');assert.notEqual(this.type,'dialog');doc.fullscreenElement=this;(listeners.get('fullscreenchange')||[]).forEach(fn=>fn())}};dom.set(path,element)}
  element.props=node.props
  if(typeof node.props.ref==='function')node.props.ref(element);else if(node.props.ref&&typeof node.props.ref==='object')node.props.ref.current=element
  return {...node,__domPath:path,props:{...node.props,children:expand(node.props.children,path+'/'+node.type)}}
 }
 function render(){for(let attempt=0;attempt<30;attempt++){dirty=false;seen=new Set();domSeen=new Set();tree=expand(jsx(ui.MaxTutorQuizWorkspace,props));for(const [key,instance]of instances)if(!seen.has(key)){instance.cells.forEach(cell=>cell?.cleanup?.());instances.delete(key)}for(const [path,element]of dom)if(!domSeen.has(path)){element.isConnected=false;if(typeof element.props.ref==='function')element.props.ref(null);dom.delete(path)}effects.splice(0).forEach(fn=>fn());raf.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Workspace hooks did not settle')}
 render();return {props,doc,opener,render,get tree(){return tree},all:predicate=>nodes(tree).filter(predicate),find:predicate=>nodes(tree).find(predicate),button(label){return nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node).includes(label)))},click(label){const button=this.button(label);assert.ok(button,`Button ${label}`);assert.equal(!!button.props.disabled,false);button.props.onClick();render()},choose(questionIndex,optionIndex){const group=this.all(node=>node.props?.role==='group'&&String(node.props['aria-label']||'').startsWith('Варіанти відповіді'))[questionIndex],button=nodes(group).filter(node=>node.type==='button')[optionIndex];assert.ok(button);assert.equal(!!button.props.disabled,false);button.props.onClick();render()},element(node){return dom.get(node.__domPath)},counts(){return {updates,closeCount,finishCount,fullscreenRequests,fullscreenExits}},rejectFullscreen(){fullscreenReject=true},async settle(){for(let index=0;index<4;index++){await Promise.resolve();render()}}}
}

test('the workspace defaults to all questions, checks selected answers together, and preserves unchecked drafts when closed and reopened',()=>{
 const h=harness(),questions=h.props.run.bundle.questions
 assert.equal(h.all(node=>node.props?.['data-quiz-question']).length,3);assert.equal(h.button('Усі запитання').props['aria-pressed'],true);assert.equal(h.counts().fullscreenRequests,0);assert.equal(h.doc.documentElement.style.overflow,"hidden")
 h.choose(0,0);h.choose(1,0);h.click('Перевірити обрані відповіді')
 assert.equal(h.props.run.progress.submitted.length,2);assert.ok(text(h.tree).includes(questions[0].explanation));assert.ok(text(h.tree).includes(questions[1].explanation))
 h.choose(2,1);h.click('Закрити вікно тесту');assert.equal(h.tree,null);assert.equal(h.doc.documentElement.style.overflow,"auto");assert.equal(h.props.run.progress.answers[questions[2].id],1);assert.equal(h.props.run.progress.submitted.includes(questions[2].id),false);assert.equal(h.counts().finishCount,0)
 h.props.open=true;h.render();assert.equal(h.all(node=>node.props?.['data-quiz-question']).length,3);assert.equal(h.all(node=>node.type==='button'&&node.props['aria-pressed']===true).length,4,'three saved selected answers plus all-questions view')
})

test('overview navigation and optional single-question view keep feedback until the student chooses another question',()=>{
 const h=harness(),[first,second]=h.props.run.bundle.questions
 h.click('По одному');assert.equal(h.all(node=>node.props?.['data-quiz-question']).length,1)
 h.choose(0,0);h.click('Перевірити відповідь');assert.ok(text(h.tree).includes(first.explanation));assert.equal(h.find(node=>node.type==='h2'&&text(node)===second.text),undefined)
 h.click('Запитання 2: без відповіді');assert.ok(h.find(node=>node.type==='h2'&&text(node)===second.text));h.click('Усі запитання');assert.equal(h.all(node=>node.props?.['data-quiz-question']).length,3)
})

test('Escape and the focus trap return to the launcher without checking or discarding an answer',()=>{
 const h=harness();h.choose(0,0)
 const modal=h.find(node=>node.type==='dialog'),controls=h.all(node=>node.type==='button'&&!node.props.disabled),first=h.element(controls[0]),last=h.element(controls.at(-1));let prevented=0
 h.doc.activeElement=last;modal.props.onKeyDown({key:'Tab',shiftKey:false,preventDefault(){prevented++}});assert.equal(h.doc.activeElement,first)
 h.doc.activeElement=first;modal.props.onKeyDown({key:'Tab',shiftKey:true,preventDefault(){prevented++}});assert.equal(h.doc.activeElement,last)
 modal.props.onKeyDown({key:'Escape',preventDefault(){prevented++}});h.render();assert.equal(prevented,3);assert.equal(h.tree,null);assert.equal(h.doc.activeElement,h.opener);assert.equal(h.props.run.progress.submitted.length,0);assert.equal(h.props.run.progress.answers[h.props.run.bundle.questions[0].id],0)
})

test('readonly practice and save errors stay visible without enabling mutation or losing plan-step scoping',()=>{
 const run=fixture(),id=run.bundle.questions[1].id,h=harness({run,questionIds:[id],enabled:false,saveState:{saving:false,error:'Тестова помилка збереження'}})
 assert.equal(h.all(node=>node.props?.['data-quiz-question']).length,1);assert.equal(h.find(node=>node.props?.['data-quiz-question']).props['data-quiz-question'],id);assert.ok(text(h.tree).includes('Тестова помилка збереження'))
 assert.equal(h.all(node=>node.props?.role==='group'&&String(node.props['aria-label']||'').startsWith('Варіанти відповіді')).every(group=>nodes(group).filter(node=>node.type==='button').every(button=>button.props.disabled)),true)
 assert.equal(h.button('Перевірити обрані відповіді').props.disabled,true);assert.equal(h.counts().updates,0)
})

test('native fullscreen is requested only by a click on the inner workspace, falls back safely, and closes only its own fullscreen element',async()=>{
 const h=harness();assert.equal(h.counts().fullscreenRequests,0)
 h.click('Відкрити тест на весь екран');await h.settle();assert.equal(h.counts().fullscreenRequests,1);assert.equal(h.doc.fullscreenElement?.props.className,'mqq-shell')
 h.click('Закрити вікно тесту');await h.settle();assert.equal(h.counts().fullscreenExits,1);assert.equal(h.doc.fullscreenElement,null)
 const rejected=harness();rejected.rejectFullscreen();rejected.click('Відкрити тест на весь екран');await rejected.settle();assert.ok(text(rejected.tree).includes('на всю вкладку'));assert.equal(rejected.all(node=>node.props?.['data-quiz-question']).length,3)
})

test('finished feedback derives from saved checked answers, and repeated summary clicks never grade or submit again',()=>{
 const run=fixture();run.progress=workspace.checkTutorQuizWorkspace({...run.progress,answers:Object.fromEntries(run.bundle.questions.map(question=>[question.id,question.correctIndex]))},run.bundle)
 const h=harness({run});assert.match(text(h.tree),/3\s+із\s+3\s+правильно/);h.click('Показати підсумок');h.click('Показати підсумок');assert.equal(h.counts().finishCount,1);assert.equal(h.counts().updates,0)
 const readonly=harness({run,enabled:false});readonly.click('Показати підсумок');assert.equal(readonly.counts().finishCount,0)
})
