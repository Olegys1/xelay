import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const stateModule={exports:{}}
runInNewContext(compile(read('src/lib/teachingTestReviewState.ts')),{module:stateModule,exports:stateModule.exports,Date,Number})
const {teachingReviewReadyAt,teachingReviewServerNow,teachingReviewActiveAttempts}=stateModule.exports
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>node==null||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const base=()=>({test:{id:'test-one',version:1,title:'Вигаданий тест',status:'published',can_edit:true,can_review:true,can_close:true,opens_at:'2026-11-05T09:00:00Z',closes_at:'2026-11-05T11:00:00Z',results_ready_at:'2026-11-05T11:00:00Z',max_points:10,review_revision:0,approved_revision:null,results_finalized_at:null,journal_date:'2026-11-05',work_type:'Тест',questions:[],overrides:[]},server_now:'2026-11-05T10:00:00Z',attempts:[{id:'attempt-one',status:'submitted',questions:[],question_results:[],score:7,auto_score:7,elapsed_seconds:60,answers:{},version:1,expires_at:'2026-11-05T10:20:00Z'}]})
function fixture(initial=base()){
  let now=Date.parse(initial.server_now),data=structuredClone(initial),index=0,dirty=false,tree,mounted=true
  const cells=[],effects=[],timers=[],calls=[]
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]))
  const hooks={
    useState(initial){const i=index++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{if(!mounted)return;const value=typeof next==='function'?next(cells[i].value):next;if(!Object.is(value,cells[i].value)){cells[i].value=value;dirty=true}}]},
    useRef(initial){const i=index++;return cells[i]??={current:initial}},
    useCallback(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn};return cells[i].value},
    useEffect(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const old=cells[i];cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[i].cleanup=fn()})}},
  }
  class ClockDate extends Date{static now(){return now}}
  const jsx=(type,props)=>({type,props:props||{}})
  const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>String(name)}),
    '../../lib/teaching':{teachingDate:value=>String(value)},'../../lib/teachingTests':{teachingTestError:error=>String(error?.message||error)},
    '../../lib/teachingTestReviewState':stateModule.exports,'./TeachingTestBuilder':{TeachingTestBuilder:'TeachingTestBuilder',TEST_QUESTION_LABELS:{}},
    './TeachingUI':{TeachingButton:'TeachingButton',TeachingEmpty:'TeachingEmpty',TeachingField:'TeachingField',TeachingModal:'TeachingModal'},
    './TeachingQuestionBank':{TeachingQuestionBank:'TeachingQuestionBank'},'./TeachingRubrics':{TeachingRubricAssessment:'TeachingRubricAssessment'},
    '../../lib/teachingRubrics':{teachingRubricScore:()=>null},'./TeachingTestOverrides':{TeachingTestOverrides:'TeachingTestOverrides'},'./TeachingTestRunner':{TeachingTestRunner:'TeachingTestRunner'},
    './TeachingTestAccessCode':{TeachingTestAccessCodeDialog:'TeachingTestAccessCodeDialog'},'./TeachingTestQuestionImages':{TeachingTestQuestionImages:'TeachingTestQuestionImages'},
    './teaching-tests.css':{},'./teaching-test-review.css':{},
  }
  const module={exports:{}}
  runInNewContext(compile(read('src/components/teaching/TeachingTests.tsx')+'\nexport { TeachingTestReview };'),{module,exports:module.exports,Date:ClockDate,Number,Map,Set,window:{setInterval:fn=>{timers.push(fn);return timers.length},clearInterval(){}},require(name){assert.ok(name in imports,'Known import '+name);return imports[name]}})
  const props={test:data.test,userId:'owner',readonly:false,onClose(){},onChanged:async()=>{},repository:{detail:async()=>structuredClone(data),mutate:async(action,payload)=>{calls.push({action,payload});data={...data,test:{...data.test,status:action==='close_test'?'closed':data.test.status,closed_early_at:action==='close_test'?new ClockDate(now).toISOString():data.test.closed_early_at,version:data.test.version+1}};return structuredClone(data)}}}
  const render=()=>{for(let n=0;n<25;n++){index=0;dirty=false;tree=module.exports.TeachingTestReview(props);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Unsettled hooks')}
  render()
  return{props,calls,get tree(){return tree},render,button(label){const found=nodes(tree).find(node=>node.type==='TeachingButton'&&text(node).trim()===label);assert.ok(found,'Button '+label);return found},checkbox(label){const found=nodes(tree).find(node=>node.type==='label'&&text(node).includes(label));assert.ok(found,'Checkbox '+label);return nodes(found).find(node=>node.type==='input')},async settle(){for(let i=0;i<20;i++){await Promise.resolve();render()}},advance(ms){now+=ms;timers.forEach(fn=>fn());render()},unmount(){mounted=false;cells.forEach(cell=>cell?.cleanup?.())}}
}

test('review readiness includes the last individual extension and advances from the received server clock',()=>{
  const data=base();data.test.overrides=[{closes_at:'2026-11-06T14:00:00Z'}]
  assert.equal(teachingReviewReadyAt(data.test),Date.parse('2026-11-06T14:00:00Z'))
  assert.equal(teachingReviewServerNow(data.server_now,1000,4600),Date.parse(data.server_now)+3600)
  assert.equal(teachingReviewActiveAttempts([{status:'in_progress',expires_at:'2026-11-05T10:01:00Z'}],Date.parse(data.server_now)),1)
  data.test.closed_early_at='2026-11-05T10:00:00Z';assert.equal(teachingReviewReadyAt(data.test),Date.parse(data.server_now))
})

test('disabled approval explains the deadline and becomes available as the server clock advances',async()=>{
  const f=fixture();await f.settle()
  assert.equal(f.checkbox('Я перевірив результати').props.disabled,true)
  assert.match(text(f.tree),/Чому підтвердження поки недоступне/)
  assert.match(text(f.tree),/індивідуальні терміни/)
  f.advance(3600001)
  assert.equal(f.checkbox('Я перевірив результати').props.disabled,false)
  assert.equal(f.checkbox('Я перевірив результати').props.checked,false)
  f.unmount()
})

test('owner early closure needs a separate current confirmation and never approves or transfers grades',async()=>{
  const f=fixture();await f.settle()
  f.button('Завершити приймання робіт раніше').props.onClick();f.render()
  const captured=f.button('Закрити доступ і перейти до перевірки').props.onClick
  captured();await f.settle();assert.equal(f.calls.length,0)
  f.checkbox('Підтверджую закриття доступу').props.onChange({target:{checked:true}});f.render()
  const confirmed=f.button('Закрити доступ і перейти до перевірки').props.onClick
  f.checkbox('Підтверджую закриття доступу').props.onChange({target:{checked:false}});f.render()
  confirmed();await f.settle();assert.equal(f.calls.length,0,'an old callback does not keep consent after unchecking')
  f.checkbox('Підтверджую закриття доступу').props.onChange({target:{checked:true}});f.render()
  f.button('Закрити доступ і перейти до перевірки').props.onClick();await f.settle()
  assert.deepEqual(f.calls.map(call=>call.action),['close_test'])
  assert.equal(f.calls[0].payload.confirm_close_all,true)
  assert.equal(f.checkbox('Я перевірив результати').props.checked,false)
  assert.equal(f.checkbox('Підтверджую перенесення').props.disabled,true)
  f.unmount()
})

test('live attempts and missing owner permission cannot use the close action, even through direct handlers',async()=>{
  const data=base();data.attempts.push({...data.attempts[0],id:'active',status:'in_progress',expires_at:'2026-11-05T10:20:00Z'})
  const f=fixture(data);await f.settle();f.button('Завершити приймання робіт раніше').props.onClick();f.render()
  assert.equal(f.checkbox('Підтверджую закриття доступу').props.disabled,true)
  f.checkbox('Підтверджую закриття доступу').props.onChange({target:{checked:true}});f.render()
  f.button('Закрити доступ і перейти до перевірки').props.onClick();await f.settle();assert.equal(f.calls.length,0);f.unmount()
  data.test.can_close=false
  const noOwner=fixture(data);await noOwner.settle()
  assert.equal(nodes(noOwner.tree).some(node=>node.type==='TeachingButton'&&text(node)==='Завершити приймання робіт раніше'),false);noOwner.unmount()
})
