import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
function load(path,imports={},globals={}){const module={exports:{}};runInNewContext(ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,Date,JSON,Set,Map,Number,Math,TextEncoder,...globals,require(name){assert.ok(name in imports,`Known dependency ${name}`);return imports[name]}});return module.exports}
const study=load('src/lib/maxTutorStudy.ts'),tutor=load('src/lib/maxTutor.ts',{'./maxTutorStudy.js':study}),plan=load('src/lib/maxTutorPlan.ts')
function fixture(){const sample=tutor.createTutorDemo('own-plan-practice','plan');return {...sample,demo:false,id:sample.request.requestId,createdAt:'2026-11-17T10:00:00Z',bundle:{...sample.bundle,plan:sample.bundle.plan.map((step,index)=>({...step,questionIds:[sample.bundle.questions[index].id]}))},progress:tutor.emptyTutorProgress()}}

test('each plan step resolves only its own questions and completion requires both checked practice and tasks',()=>{
 const run=fixture(),first=run.bundle.plan[0],second=run.bundle.plan[1],q=run.bundle.questions[0]
 let state=plan.tutorPlanStep(run.bundle,run.progress,first.id)
 assert.equal(state.questions.length,1);assert.equal(state.questions[0].id,q.id);assert.equal(state.complete,false);assert.equal(state.checked,0)
 run.progress={...run.progress,answers:{[q.id]:0},doneTasks:first.tasks.map((_,at)=>`${first.id}:${at}`)}
 assert.equal(plan.tutorPlanStep(run.bundle,run.progress,first.id).complete,false,'an unsubmitted selection is never counted as a checked result')
 run.progress=tutor.submitTutorQuestion(run.progress,run.bundle,q.id)
 state=plan.tutorPlanStep(run.bundle,run.progress,first.id)
 assert.equal(state.complete,true);assert.equal(state.correct,1);assert.equal(state.practiceComplete,true);assert.equal(plan.tutorPlanResumeStep(run.bundle,run.progress),second.id)
 assert.equal(plan.tutorPlanStep(run.bundle,run.progress,second.id).checked,0)
 assert.equal(plan.tutorPlanStep(run.bundle,run.progress,'foreign-step').questions.length,0)
 const reordered={...run.bundle,plan:[{...first,questionIds:[run.bundle.questions[1].id,q.id]}]}
 assert.deepEqual(Array.from(plan.tutorPlanStep(reordered,run.progress,first.id).questions,item=>item.id),[run.bundle.questions[1].id,q.id],'step references define the practice order')
})

test('plan step answers and references survive the actual owner-scoped state roundtrip, and another owner cannot hydrate them',()=>{
 const run=fixture(),q=run.bundle.questions[0],scope={mode:'live',userId:'owner-a',sessionId:'session-a'}
 run.progress=tutor.submitTutorQuestion(tutor.answerTutorQuestion(run.progress,run.bundle,q.id,0),run.bundle,q.id)
 const raw=tutor.storeScopedTutorState({version:1,runs:[run],activeRunId:run.id},scope),restored=tutor.parseScopedTutorState(raw,scope)
 assert.equal(restored.runs.length,1);assert.equal(restored.runs[0].bundle.plan[0].questionIds[0],q.id);assert.equal(restored.runs[0].progress.answers[q.id],0);assert.equal(plan.tutorPlanStep(restored.runs[0].bundle,restored.runs[0].progress,run.bundle.plan[0].id).checked,1)
 assert.equal(tutor.parseScopedTutorState(raw,{...scope,userId:'owner-b'}).runs.length,0)
 const legacy={...run.bundle,plan:run.bundle.plan.map(({questionIds,...step})=>step)}
 assert.equal(tutor.validateTutorBundle(legacy,run.request).plan.length,3);assert.equal(plan.tutorPlanStep(legacy,run.progress,legacy.plan[0].id).questions.length,0,'legacy plans keep tasks without invented tests')
})

test('a topic-only five-step exam plan keeps three separate questions per step and resumes the next unfinished step after reload',()=>{
 const sample=fixture(),request=tutor.validateTutorRequest({requestId:'own-five-topic-plan',mode:'plan',prompt:'Склади план на п’ять тем з попиту та пропозиції.',sources:[]})
 const questions=Array.from({length:15},(_,index)=>({...sample.bundle.questions[0],id:'topic-q-'+index,text:'Перевірка теми '+(Math.floor(index/3)+1)+' · '+(index%3+1),sourceId:''}))
 const bundle=tutor.validateTutorBundle({...sample.bundle,questions,cards:[],math:null,citations:[],plan:Array.from({length:5},(_,index)=>({id:'topic-'+index,label:'Тема '+(index+1),minutes:20,tasks:['Розібрати тему','Пояснити власними словами'],questionIds:questions.slice(index*3,index*3+3).map(question=>question.id)}))},request)
 let progress=tutor.emptyTutorProgress(bundle)
 for(const question of questions.slice(0,3))progress=tutor.submitTutorQuestion(tutor.answerTutorQuestion(progress,bundle,question.id,question.correctIndex),bundle,question.id)
 progress={...progress,doneTasks:['topic-0:0','topic-0:1']}
 const scope={mode:'live',userId:'five-topic-owner',sessionId:'five-topic-session'},run={id:request.requestId,request,bundle,progress,demo:false,createdAt:'2026-11-17T11:00:00Z'}
 const restored=tutor.parseScopedTutorState(tutor.storeScopedTutorState({version:1,runs:[run],activeRunId:run.id},scope),scope).runs[0]
 assert.equal(restored.bundle.plan.length,5);assert.equal(restored.bundle.questions.length,15);assert.equal(plan.tutorPlanResumeStep(restored.bundle,restored.progress),'topic-1')
 assert.equal(plan.tutorPlanStep(restored.bundle,restored.progress,'topic-0').correct,3)
 for(const block of restored.bundle.plan.slice(1)){const result=plan.tutorPlanStep(restored.bundle,restored.progress,block.id);assert.equal(result.questions.length,3);assert.equal(result.checked,0);assert.equal(result.complete,false)}
})

function harness(run=fixture(),extra={}){
 let cursor=0,dirty=false,tree;const cells=[],effects=[],props={run,enabled:true,onProgress(update){props.run={...props.run,progress:update(props.run.progress)};dirty=true},...extra}
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
 const hooks={useState(initial){const at=cursor++;cells[at]??={value:typeof initial==='function'?initial():initial};return [cells[at].value,next=>{const value=typeof next==='function'?next(cells[at].value):next;if(!Object.is(value,cells[at].value)){cells[at].value=value;dirty=true}}]},useRef(initial){return cells[cursor++]??={current:initial}},useEffect(fn,deps){const at=cursor++;if(!cells[at]||!same(cells[at].deps,deps)){cells[at]={deps};effects.push(fn)}}}
 const jsx=(type,props)=>({type,props:props||{}}),ui=load('src/components/student/MaxTutorPlanActivity.tsx',{react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>String(name)}),'../../lib/maxTutor':tutor,'../../lib/maxTutorPlan':plan,'./maxTutorPlanActivity.css':{}},{requestAnimationFrame(fn){fn()}})
 function render(){for(let index=0;index<20;index++){dirty=false;cursor=0;tree=ui.MaxTutorPlanActivity(props);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('UI did not settle')}
 render();return {props,render,get tree(){return tree},find:predicate=>nodes(tree).find(predicate),button:label=>nodes(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node).includes(label))),all:predicate=>nodes(tree).filter(predicate),click(label){const button=this.button(label);assert.ok(button,`Button ${label}`);assert.equal(!!button.props.disabled,false);button.props.onClick();render()}}
}

test('a student opens a step test, checks an answer, gets feedback, moves to another step and returns to preserved result',()=>{
 const h=harness(),first=h.props.run.bundle.plan[0],q=h.props.run.bundle.questions[0]
 assert.ok(h.button('Почати тест кроку'));h.click('Почати тест кроку')
 assert.ok(text(h.tree).includes(q.text));assert.equal(h.button('Перевірити відповідь').props.disabled,true)
 h.all(node=>node.type==='button'&&node.props['aria-pressed']!==undefined).find(node=>text(node).includes(q.options[0])).props.onClick();h.render();h.click('Перевірити відповідь')
 assert.ok(text(h.tree).includes(q.explanation));assert.match(text(h.tree),/1\s+із\s+1\s+правильно/);assert.equal(h.props.run.progress.submitted.length,1)
 h.click('Наступний крок');assert.ok(text(h.tree).includes(h.props.run.bundle.plan[1].label));h.click(first.label)
 assert.ok(text(h.tree).includes(q.explanation));assert.equal(h.props.run.progress.answers[q.id],0)
 const restored=harness({...h.props.run,progress:JSON.parse(JSON.stringify(h.props.run.progress))});assert.ok(text(restored.tree).includes(q.explanation))
})

test('opening a step from the preparation view targets that exact step and readonly mode cannot change answers',()=>{
 const run=fixture(),second=run.bundle.plan[1],h=harness(run,{activeStepId:second.id,selectionRevision:'open-1',enabled:false})
 assert.equal(h.all(node=>node.type==='button'&&node.props['aria-pressed']===true).length,1);assert.ok(text(h.all(node=>node.type==='button'&&node.props['aria-pressed']===true)[0]).includes(second.label))
 h.click('Почати тест кроку');assert.ok(h.all(node=>node.type==='button'&&node.props['aria-pressed']===false&&String(node.props.className||'').includes('selected')===false).filter(node=>node.props.disabled).length>0)
 assert.equal(h.all(node=>node.type==='input').every(node=>node.props.disabled),true)
 h.props.activeStepId=run.bundle.plan[2].id;h.props.selectionRevision='open-2';h.render();assert.ok(text(h.all(node=>node.type==='button'&&node.props['aria-pressed']===true)[0]).includes(run.bundle.plan[2].label))
 assert.equal(Object.keys(h.props.run.progress.answers).length,0)
})

test('checking an answer keeps its explanation visible until Next, including in a step with multiple questions',()=>{
 const run=fixture(),[first,second]=run.bundle.questions
 run.bundle.plan=run.bundle.plan.slice(0,2).map((block,index)=>({...block,questionIds:index===0?[first.id,second.id]:[run.bundle.questions[2].id]}))
 const h=harness(run);h.click('Почати тест кроку')
 const choose=(question,index)=>{h.all(node=>node.type==='button'&&node.props['aria-pressed']!==undefined).find(node=>text(node).includes(question.options[index])).props.onClick();h.render();h.click('Перевірити відповідь')}
 choose(first,0);assert.ok(text(h.tree).includes(first.explanation));assert.equal(h.find(node=>node.type==='h5'&&text(node).includes(second.text)),undefined)
 h.click('Далі');assert.ok(h.find(node=>node.type==='h5'&&text(node).includes(second.text)));choose(second,0)
 assert.ok(text(h.tree).includes(second.explanation));assert.match(text(h.tree),/1\s+із\s+2\s+правильно/)
 const restored=harness({...h.props.run,progress:JSON.parse(JSON.stringify(h.props.run.progress))});assert.equal(restored.props.run.progress.submitted.length,2);assert.equal(plan.tutorPlanStep(restored.props.run.bundle,restored.props.run.progress,run.bundle.plan[0].id).correct,1)
})
