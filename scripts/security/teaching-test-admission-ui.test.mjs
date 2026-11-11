// Real component handlers, fictional accounts and repositories. No network or model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)
const nodes=node=>node==null||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const question=id=>({id,kind:'boolean',text:'Вигадане запитання '+id,points:1,time_limit_seconds:null,partial_credit:false,options:[{id:'true',text:'Так'},{id:'false',text:'Ні'}],buckets:[],answer:'true'})
const definition=patch=>({id:'test-one',course_id:'course-one',title:'Вигаданий тест',description:'Опис роботи',status:'published',opens_at:'2026-11-05T09:00:00Z',closes_at:'2026-11-06T18:00:00Z',duration_seconds:1200,max_points:20,category:'',journal_date:'2026-11-05',work_type:'Тест',allow_skip:true,allow_return:true,question_timer_policy:'continue',restrict_copy:true,bonus_percent:0,bonus_points:0,targets:[{group_id:'group-a',audience_mode:'all',subgroup_ids:[]},{group_id:'group-b',audience_mode:'all',subgroup_ids:[]}],questions:[question('q1')],question_count:1,version:4,has_attempts:false,results_finalized_at:null,review_revision:0,approved_revision:null,overrides:[],...patch})
const snapshot=()=>({course:{id:'course-one',title:'Вигаданий предмет',permissions:['assignments','grades'],grading_rules:{categories:[]}},groups:[{group_id:'group-a',group_name:'Група А',status:'accepted',permissions:['assignments','grades']},{group_id:'group-b',group_name:'Група Б',status:'accepted',permissions:['assignments','grades']}],entries:[{id:'entry-a',user_id:'student-one',group_id:'group-a',full_name:'Вигаданий студент',active:true},{id:'entry-b',user_id:'student-one',group_id:'group-b',full_name:'Вигаданий студент',active:true}]})
const override=patch=>({user_id:'student-one',group_id:'group-a',opens_at:null,closes_at:null,duration_seconds:null,excluded:false,exclusion_reason:'',...patch})
const detail=patch=>({test:definition(),attempts:[],attempt:null,server_now:'2026-11-05T10:00:00Z',...patch})
const qaOwner='approved-qa-owner',qaGroup='only-hidden-group'

function fixture(component,properties={},options={}){
  const cells=[],effects=[],calls=[],saved=[]
  let index=0,dirty=false,tree,mounted=true,current=structuredClone(options.detail||detail())
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]))
  const hooks={
    useState(initial){const i=index++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{if(!mounted)return;const value=typeof next==='function'?next(cells[i].value):next;if(!Object.is(value,cells[i].value)){cells[i].value=value;dirty=true}}]},
    useRef(initial){const i=index++;return cells[i]??={current:initial}},
    useCallback(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn};return cells[i].value},
    useEffect(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const old=cells[i];cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[i].cleanup=fn()})}},
  }
  const jsx=(type,props)=>({type,props:props||{}})
  const repository={detail:async()=>structuredClone(current),list:async()=>({tests:[structuredClone(current.test)],server_now:current.server_now}),mutate:async(action,payload)=>{calls.push({action,payload:plain(payload)});if(options.mutate)return options.mutate(action,payload);if(action==='save_override')current={...current,test:{...current.test,version:current.test.version+1,overrides:[payload.override]}};return structuredClone(current)}}
  const teaching={localDeadline:value=>String(value||'').slice(0,16),kyivDeadline:value=>value?new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?value:value+'Z').toISOString():null,teachingDate:value=>String(value||'')}
  const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>String(name)}),
    '../../lib/teaching':teaching,'../../lib/teachingTests':{teachingTestError:error=>String(error?.message||error)},
    '../../lib/studyGroupVisibility':{isStudyGroupListed:()=>true,TEACHING_QA_OWNER_ID:qaOwner,TEACHING_QA_GROUP_ID:qaGroup},
    '../../lib/teachingTestPractice':{clearTeachingTestPractice(){throw Error('Practice is forbidden in student admission test')},createTeachingTestPracticeRepository(){throw Error('Practice is forbidden in student admission test')}},
    './TeachingUI':{TeachingButton:'TeachingButton',TeachingEmpty:'TeachingEmpty',TeachingField:'TeachingField',TeachingModal:'TeachingModal',teachingInput:'input'},
    './TeachingAudienceFields':{TeachingAudienceFields:'TeachingAudienceFields'},'./TeachingGradingRulesEditor':{TeachingWorkTypeField:'TeachingWorkTypeField'},
    './TeachingQuestionEditor':{newTeachingQuestion:()=>question('new'),questionValidationMessage:()=>'',TeachingQuestionEditor:'TeachingQuestionEditor',TEST_QUESTION_LABELS:{}},
    './TeachingQuestionBank':{TeachingQuestionBank:'TeachingQuestionBank'},'./TeachingQuestionImportPanel':{TeachingQuestionImportPanel:'TeachingQuestionImportPanel'},'./TeachingRubrics':{TeachingRubricAssessment:'TeachingRubricAssessment'},
    './TeachingTestQuestionImages':{TeachingTestQuestionImages:'TeachingTestQuestionImages'},'./TeachingTestIntegritySettings':{TeachingTestIntegritySettings:'TeachingTestIntegritySettings'},
    './TeachingTestContent':{TeachingTestContent:'TeachingTestContent'},
    './useTeachingTestTabGuard':{useTeachingTestTabGuard:()=>({pendingCount:0,hasPending:()=>false})},
    './teaching-tests.css':{},'./teaching-assessment-phase1.css':{},
  }
  const file=component==='TeachingTestSession'?'TeachingTestRunner':component
  const source=read('src/components/teaching/'+file+'.tsx')+(component==='TeachingTestSession'?'\nexport { TeachingTestSession };':'')
  const module={exports:{}}
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  let timerId=0
  runInNewContext(code,{module,exports:module.exports,Date,Number,Map,Set,Promise,crypto:{randomUUID:()=> 'test-new'},document:{addEventListener(){},removeEventListener(){}},window:{setInterval:()=>++timerId,clearInterval(){},setTimeout:()=>++timerId,clearTimeout(){},addEventListener(){},removeEventListener(){}},require(name){assert.ok(name in imports,'Known import '+name);return imports[name]}})
  const props={test:current.test,initial:current.test,initialDetail:current,snapshot:snapshot(),repository,teachingRepository:{},userId:'teacher-one',groupId:'group-a',testId:current.test.id,onClose(){},onSaved:value=>saved.push(plain(value)),onRestart(){},...properties}
  const render=()=>{for(let pass=0;pass<30;pass++){index=0;dirty=false;tree=module.exports[component](props);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Unsettled component hooks')}
  render()
  return{props,calls,saved,render,get tree(){return tree},
    find(predicate){const node=nodes(tree).find(predicate);assert.ok(node,'Expected rendered element');return node},
    button(label){return this.find(node=>['button','TeachingButton'].includes(node.type)&&text(node).trim()===label)},
    field(label){return nodes(this.find(node=>node.type==='TeachingField'&&node.props.label===label)).find(node=>['input','textarea','select'].includes(node.type))},
    checkbox(label){return nodes(this.find(node=>node.type==='label'&&text(node).includes(label))).find(node=>node.type==='input')},
    change(label,value){this.field(label).props.onChange({target:{value}});render()},
    check(label,checked){this.checkbox(label).props.onChange({target:{checked}});render()},
    replace(patch){Object.assign(props,patch);render()},
    async settle(){for(let i=0;i<25;i++){await Promise.resolve();render()}},
    submit(){this.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});render()},
    unmount(){mounted=false;cells.forEach(cell=>cell?.cleanup?.())},
  }
}

test('existing test recipients are admitted by default; explicit deny and restore save only the selected student',async()=>{
  const f=fixture('TeachingTestOverrides');await f.settle()
  assert.match(text(f.tree),/За замовчуванням допущені всі/)
  const options=nodes(f.field('Студент')).filter(node=>node.type==='option'&&node.props.value)
  assert.equal(options.length,1,'one user in multiple groups has one admission decision')
  f.change('Студент','student-one:group-a')
  assert.equal(f.checkbox('Не допускати').props.checked,false)
  assert.equal(f.calls.length,0)
  f.check('Не допускати',true);f.change('Пояснення для студента','Потрібно завершити попередню роботу.')
  f.button('Зберегти допуск і час').props.onClick();await f.settle()
  assert.equal(f.calls[0].action,'save_override')
  assert.equal(f.calls[0].payload.expected_user_id,'teacher-one')
  assert.deepEqual(f.calls[0].payload.override,override({excluded:true,exclusion_reason:'Потрібно завершити попередню роботу.'}))
  f.check('Не допускати',false);f.button('Зберегти допуск і час').props.onClick();await f.settle()
  assert.equal(f.calls[1].payload.override.excluded,false)
  assert.equal(f.calls[1].payload.override.exclusion_reason,'')
  assert.equal(f.saved.length,2);f.unmount()
})

test('resetting time keeps the SAVED admission decision, never the unsaved checkbox or reason',async()=>{
  for(const excluded of [true,false]){
    const saved=override({excluded,exclusion_reason:excluded?'Збережена причина.':'',duration_seconds:1800,closes_at:'2026-11-07T18:00:00Z'})
    const f=fixture('TeachingTestOverrides',{}, {detail:detail({test:definition({overrides:[saved]})})});await f.settle();f.change('Студент','student-one:group-a')
    f.check('Не допускати',!excluded)
    if(!excluded)f.change('Пояснення для студента','Незбережена зміна.')
    f.button('Відновити загальний час').props.onClick();await f.settle()
    assert.deepEqual(f.calls[0].payload.override,override({excluded,exclusion_reason:saved.exclusion_reason}))
    assert.equal(f.checkbox('Не допускати').props.checked,excluded)
    assert.match(text(f.tree),/Рішення про допуск збережено/);f.unmount()
  }
})

test('closed tests and approved results explain why individual conditions are locked',async()=>{
  for(const [patch,expected] of [
    [{status:'closed'},/Приймання відповідей закрито викладачем/],
    [{results_finalized_at:'2026-11-06T18:00:00Z'},/Результати затверджено/],
  ]){
    const f=fixture('TeachingTestOverrides',{}, {detail:detail({test:definition(patch)})});await f.settle()
    assert.match(text(f.tree),expected)
    assert.doesNotMatch(text(f.tree),/Зберегти допуск і час|Оберіть студента/)
    assert.equal(f.calls.length,0);f.unmount()
  }
})

test('a started student can be selected for history but cannot change their started admission through another group',async()=>{
  const f=fixture('TeachingTestOverrides',{}, {detail:detail({test:definition({overrides:[override()]}),attempts:[{id:'started',user_id:'student-one',group_id:'group-b',status:'in_progress'}]})});await f.settle()
  const option=nodes(f.field('Студент')).find(node=>node.type==='option'&&node.props.value)
  assert.notEqual(option.props.disabled,true,'started students remain selectable for an explicit separate retake')
  for(const group of ['group-a','group-b']){
    f.change('Студент','student-one:'+group)
    f.button('Зберегти допуск і час').props.onClick();await f.settle()
  }
  assert.equal(f.calls.length,0)
  assert.match(text(f.tree),/уже почав тест/);f.unmount()
})

const completedRetakeSource = (patch = {}) => detail({test:definition({status:'closed',can_grant_retake:true,base_variant_title:'Основний набір',variants:[{id:'named-variant',title:'Інший набір',questions:[question('other')]}],...patch}),attempts:[{id:'old-attempt',user_id:'student-one',group_id:'group-a',status:'submitted',submitted_at:'2026-11-05T09:45:00Z',expires_at:'2026-11-05T10:00:00Z'}]})
const retakeGrant = (patch = {}) => ({id:'grant-one',child_test_id:'private-child',user_id:'student-one',group_id:'group-a',source_attempt_id:'old-attempt',attempt_id:null,retake_number:2,variant_choice:'random',opens_at:'2026-11-05T10:00:00Z',closes_at:'2026-11-06T10:00:00Z',duration_seconds:1200,created_at:'2026-11-05T10:00:00Z',status:'pending',...patch})

test('personal retake needs separate confirmation, preserves old work and sends a fixed or random choice only for that student',async()=>{
  for(const choice of ['random','base','named-variant']){
    const initial=completedRetakeSource()
    const f=fixture('TeachingTestOverrides',{}, {detail:initial,mutate:async(action,payload)=>detail({test:{...initial.test,version:5,retake_grants:[retakeGrant({variant_choice:payload.variant_choice})]},attempts:initial.attempts})})
    await f.settle();f.change('Студент','student-one:group-a')
    assert.equal(f.button('Зберегти допуск і час').props.disabled,true)
    assert.match(text(f.tree),/найкращий опублікований бал/)
    const offered=nodes(f.field('Варіант повторної спроби')).filter(node=>node.type==='option').map(node=>node.props.value)
    assert.deepEqual(offered,['random','base','named-variant'])
    f.change('Варіант повторної спроби',choice)
    f.change('Відкрити повторну спробу за Києвом','2026-11-05T10:00')
    f.change('Закрити повторну спробу за Києвом','2026-11-06T10:00')
    f.change('На повторну спробу, хвилин','30')
    f.button('Дозволити повторну спробу').props.onClick();await f.settle();assert.equal(f.calls.length,0)
    f.check('Дозволяю нову спробу',true)
    f.button('Дозволити повторну спробу').props.onClick();await f.settle()
    assert.equal(f.calls.length,1)
    assert.equal(f.calls[0].action,'grant_retake')
    assert.deepEqual(f.calls[0].payload,{id:'test-one',version:4,expected_user_id:'teacher-one',request_id:'test-new',user_id:'student-one',group_id:'group-a',source_attempt_id:'old-attempt',variant_choice:choice,opens_at:'2026-11-05T10:00:00.000Z',closes_at:'2026-11-06T10:00:00.000Z',duration_seconds:1800,confirm_retake:true})
    assert.equal(f.button('Дозволити повторну спробу').props.disabled,true,'a pending grant cannot be duplicated')
    assert.equal(f.checkbox('Дозволяю нову спробу').props.checked,false)
    assert.equal(f.saved[0].attempts[0].id,'old-attempt')
    assert.match(text(f.tree),/Попередні відповіді й бали збережено/)
    f.unmount()
  }
})

test('a student in two target groups receives the retake in their original attempt group ahead of an older override',async()=>{
  const initial={...completedRetakeSource({overrides:[override({group_id:'group-a'})]}),attempts:[{id:'original-group-b',user_id:'student-one',group_id:'group-b',status:'submitted',submitted_at:'2026-11-05T09:45:00Z',expires_at:'2026-11-05T10:00:00Z'}]}
  const f=fixture('TeachingTestOverrides',{}, {detail:initial});await f.settle()
  const offered=nodes(f.field('Студент')).filter(node=>node.type==='option'&&node.props.value)
  assert.deepEqual(offered.map(node=>node.props.value),['student-one:group-b'])
  f.change('Студент','student-one:group-b');f.check('Дозволяю нову спробу',true)
  f.button('Дозволити повторну спробу').props.onClick();await f.settle()
  assert.equal(f.calls[0].payload.group_id,'group-b')
  assert.equal(f.calls[0].payload.source_attempt_id,'original-group-b');f.unmount()
})

test('retake confirmation is cleared by a changed variant and captured old callbacks cannot grant it',async()=>{
  const f=fixture('TeachingTestOverrides',{}, {detail:completedRetakeSource()});await f.settle();f.change('Студент','student-one:group-a')
  f.check('Дозволяю нову спробу',true)
  const old=f.button('Дозволити повторну спробу').props.onClick
  f.change('Варіант повторної спроби','base')
  assert.equal(f.checkbox('Дозволяю нову спробу').props.checked,false)
  old();await f.settle();assert.equal(f.calls.length,0)
  f.unmount();old();await f.settle();assert.equal(f.calls.length,0)
})

test('unused expired or revoked permissions are not counted as completed attempts and do not block a fresh permission',async()=>{
  const initial=completedRetakeSource({retake_grants:[
    retakeGrant({id:'unused-expired',closes_at:'2026-11-05T09:59:00Z'}),
    retakeGrant({id:'unused-revoked',revoked_at:'2026-11-05T09:59:30Z'}),
  ]})
  const f=fixture('TeachingTestOverrides',{}, {detail:initial});await f.settle();f.change('Студент','student-one:group-a')
  assert.match(text(f.tree),/Повторна спроба №\s*2/)
  assert.doesNotMatch(text(f.tree),/Повторна спроба №\s*3/)
  assert.match(text(f.tree),/Час дозволу минув/)
  assert.match(text(f.tree),/Невикористаний дозвіл закрито/)
  f.check('Дозволяю нову спробу',true)
  assert.equal(f.button('Дозволити повторну спробу').props.disabled,false)
  f.button('Дозволити повторну спробу').props.onClick();await f.settle()
  assert.equal(f.calls[0].payload.source_attempt_id,'old-attempt');f.unmount()
})

test('named variants with reserved IDs remain distinct from random selection and the base variant',async()=>{
  for(const id of ['base','random']){
    const f=fixture('TeachingTestOverrides',{}, {detail:completedRetakeSource({variants:[{id:'base',title:'Авторський base',questions:[question('base-q')]},{id:'random',title:'Авторський random',questions:[question('random-q')]}]})})
    await f.settle();f.change('Студент','student-one:group-a')
    const offered=nodes(f.field('Варіант повторної спроби')).filter(node=>node.type==='option').map(node=>node.props.value)
    assert.deepEqual(offered,['random','base','variant:base','variant:random'])
    f.change('Варіант повторної спроби','variant:'+id);f.check('Дозволяю нову спробу',true)
    f.button('Дозволити повторну спробу').props.onClick();await f.settle()
    assert.equal(f.calls[0].payload.variant_choice,'variant:'+id);f.unmount()
  }
})

test('retake retry retains its request identity and blocks an active source or an unfinished grant',async()=>{
  let attempts=0
  const f=fixture('TeachingTestOverrides',{}, {detail:completedRetakeSource(),mutate:async()=>{if(++attempts===1)throw Error('Connection interrupted');return completedRetakeSource()}})
  await f.settle();f.change('Студент','student-one:group-a');f.check('Дозволяю нову спробу',true)
  f.button('Дозволити повторну спробу').props.onClick();await f.settle()
  f.button('Дозволити повторну спробу').props.onClick();await f.settle()
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].payload.request_id,f.calls[1].payload.request_id)
  f.unmount()
  for(const initial of [
    {...completedRetakeSource(),attempts:[{id:'active',user_id:'student-one',group_id:'group-a',status:'in_progress',expires_at:'2026-11-05T11:00:00Z'}]},
    completedRetakeSource({retake_grants:[retakeGrant()]}),
  ]){
    const locked=fixture('TeachingTestOverrides',{}, {detail:initial});await locked.settle();locked.change('Студент','student-one:group-a')
    assert.equal(locked.button('Дозволити повторну спробу').props.disabled,true)
    locked.check('Дозволяю нову спробу',true);locked.button('Дозволити повторну спробу').props.onClick();await locked.settle()
    assert.equal(locked.calls.length,0);locked.unmount()
  }
})

test('retake grants keep the latest completed attempt as their source and late responses cannot cross a teacher scope',async()=>{
  const source=completedRetakeSource({retake_grants:[retakeGrant({attempt_id:'second-attempt',status:'submitted',published_at:'2026-11-05T09:59:00Z'})]})
  const pending=deferred(),f=fixture('TeachingTestOverrides',{}, {detail:source,mutate:()=>pending.promise})
  await f.settle();f.change('Студент','student-one:group-a');f.check('Дозволяю нову спробу',true)
  f.button('Дозволити повторну спробу').props.onClick();await Promise.resolve()
  assert.equal(f.calls[0].payload.source_attempt_id,'second-attempt')
  f.replace({userId:'different-teacher'});pending.resolve(source);await f.settle()
  assert.equal(f.saved.length,0);f.unmount()
})

test('old admission callbacks and late saves cannot cross account or repository scopes',async()=>{
  for(const change of ['account','repository']){
    const f=fixture('TeachingTestOverrides');await f.settle();f.change('Студент','student-one:group-a')
    const old=f.button('Зберегти допуск і час').props.onClick
    f.replace(change==='account'?{userId:'new-teacher'}:{repository:{...f.props.repository}});await f.settle()
    old();await f.settle();assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);f.unmount()
    const pending=deferred(),late=fixture('TeachingTestOverrides',{}, {mutate:()=>pending.promise});await late.settle();late.change('Студент','student-one:group-a')
    late.button('Зберегти допуск і час').props.onClick();await Promise.resolve()
    late.replace(change==='account'?{userId:'new-teacher'}:{repository:{...late.props.repository}})
    pending.resolve(detail());await late.settle();assert.equal(late.calls.length,1);assert.equal(late.saved.length,0);late.unmount()
  }
})

test('an excluded student sees their admission explanation without Start, description or question content',async()=>{
  const denied=detail({test:definition({description:'PRIVATE_DESCRIPTION',questions:[{...question('q1'),text:'PRIVATE_QUESTION_BODY'}],my_admission:{allowed:false,reason:'Виконайте попередню роботу.'}})})
  const f=fixture('TeachingTestSession',{}, {detail:denied});await f.settle()
  assert.match(text(f.tree),/Викладач поки не допустив/)
  assert.match(text(f.tree),/Виконайте попередню роботу/)
  assert.doesNotMatch(text(f.tree),/PRIVATE_|Почати тест|готовий розпочати/)
  assert.equal(nodes(f.tree).some(node=>node.type==='QuestionAnswer'),false)
  assert.equal(f.calls.length,0);f.unmount()
})

test('builder keeps a 20-question pool and draw 3, with ordinary recipients admitted and explicit deny reversible',async()=>{
  const initial=definition({questions:Array.from({length:20},(_,index)=>question('q'+index)),question_count:20})
  const f=fixture('TeachingTestBuilder',{initial})
  f.change('Випадково видати запитань кожному студенту','3')
  assert.match(text(f.tree),/Кожен студент отримає\s+3\s+випадкових/)
  f.submit();await f.settle()
  assert.equal(f.calls[0].payload.questions.length,20)
  assert.equal(f.calls[0].payload.draw_count,3)
  assert.equal(f.calls[0].payload.question_count,3)
  assert.deepEqual(f.calls[0].payload.overrides,[])
  const options=nodes(f.field('Студент із вибраних груп')).filter(node=>node.type==='option'&&node.props.value)
  assert.equal(options.length,1)
  f.change('Студент із вибраних груп','student-one:group-a');f.button('Налаштувати студента').props.onClick();f.render()
  assert.equal(f.checkbox('Не допускати').props.checked,false)
  f.check('Не допускати',true);f.change('Пояснення для студента','Власна причина.');f.submit();await f.settle()
  assert.equal(f.calls[1].payload.overrides[0].excluded,true)
  f.check('Не допускати',false);f.submit();await f.settle()
  assert.equal(f.calls[2].payload.overrides[0].excluded,false)
  assert.equal(f.calls[2].payload.overrides[0].exclusion_reason,'');f.unmount()
})

test('builder stale account/repository callbacks and late responses never mutate or report a save for the new scope',async()=>{
  for(const change of ['account','repository']){
    const f=fixture('TeachingTestBuilder')
    const submit=f.find(node=>node.type==='form').props.onSubmit
    f.replace(change==='account'?{userId:'new-teacher'}:{repository:{...f.props.repository}})
    submit({preventDefault(){}});await f.settle();assert.equal(f.calls.length,0);assert.equal(f.saved.length,0);f.unmount()
    const pending=deferred(),late=fixture('TeachingTestBuilder',{}, {mutate:()=>pending.promise})
    late.submit();await Promise.resolve();late.replace(change==='account'?{userId:'new-teacher'}:{repository:{...late.props.repository}})
    pending.resolve(detail());await late.settle();assert.equal(late.calls.length,1);assert.equal(late.saved.length,0);late.unmount()
  }
})

test('only the approved actor and sole hidden group can opt into isolated QA from a draft',async()=>{
  const group={group_id:qaGroup,group_name:'ооо 1',status:'accepted',permissions:['assignments','grades']}
  const target={group_id:qaGroup,audience_mode:'all',subgroup_ids:[]}
  const qaDraft=definition({status:'draft',qa_can_enable:true,targets:[target]})
  const context={snapshot:{...snapshot(),groups:[group,...snapshot().groups]},groupId:qaGroup}
  for(const invalid of [
    {userId:'other-teacher'},
    {userId:qaOwner,initial:{...qaDraft,status:'published'}},
    {userId:qaOwner,initial:{...qaDraft,targets:[target,...definition().targets]}},
  ]){
    const f=fixture('TeachingTestBuilder',{...context,initial:qaDraft,...invalid})
    assert.doesNotMatch(text(f.tree),/Тестовий режим · власна спроба/)
    f.unmount()
  }
  const f=fixture('TeachingTestBuilder',{...context,initial:qaDraft,userId:qaOwner})
  f.check('Тестовий режим · власна спроба',true)
  assert.equal(f.button('Опублікувати').props.disabled,true)
  assert.equal(f.checkbox('ооо 1').props.disabled,true)
  assert.doesNotMatch(text(f.tree),/Категорія в журналі|Дата роботи в журналі/)
  f.submit();await f.settle()
  assert.equal(f.calls[0].payload.qa_own_attempt,true)
  assert.deepEqual(f.calls[0].payload.targets,[target])
  assert.equal(f.calls[0].payload.status,'draft')
  f.unmount()
})
