import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function compile(source, imports) {
  const module={exports:{}}
  runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,URL,Date,Intl,require(name){assert.ok(name in imports,'Known synthetic dependency '+name);return imports[name]}})
  return module.exports
}
function harness(path, name, props, overrides={}) {
  const cells=[],effects=[];let cursor=0,dirty=false,tree
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
  const hooks={
    useState(initial){const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next;dirty=true}]},
    useRef(initial){const i=cursor++;return cells[i]??={current:initial}},
    useCallback(fn,deps){const i=cursor++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:fn};return cells[i].value},
    useEffect(fn,deps){const i=cursor++;if(!cells[i]||!same(cells[i].deps,deps)){const previous=cells[i];cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[i].cleanup=fn()})}},
  }
  const jsx=(type,props,key)=>({type,props:props||{},key})
  const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),
    '../../lib/seminars':{kyivToday:()=> '2026-11-16'},'../../lib/teaching':{teachingDate:value=>value,teachingError:error=>error.message},
    './TeachingUI':{TeachingButton:'TeachingButton',TeachingField:'TeachingField',teachingInput:'input'},
    '../schedule/ScheduleAdditionalLinksFields':{ScheduleAdditionalLinksFields:'AdditionalLinks'},'../schedule/ScheduleConferenceAccessFields':{ScheduleConferenceAccessFields:'ConferenceFields'},...overrides}
  const component=compile(read(path),imports)[name]
  const render=()=>{for(let i=0;i<20;i++){dirty=false;cursor=0;tree=component(props);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Hooks did not settle')}
  render()
  return {props,render,get tree(){return tree},find:predicate=>nodes(tree).find(predicate),button:label=>nodes(tree).find(node=>['TeachingButton','button'].includes(node.type)&&text(node).includes(label)),async settle(){for(let i=0;i<15;i++){await Promise.resolve();render()}},unmount(){cells.forEach(cell=>cell?.cleanup?.())}}
}
const lesson={id:'canonical-slot',course_id:'exact-course',group_id:'exact-group',subject_name:'Менеджмент',lesson_date:'2026-11-23',starts_at:'09:40:00',ends_at:'11:00:00',source:'timetable',assigned_to_me:true,can_edit_schedule:true,schedule_updated_at:'2026-11-16T10:00:00Z',online_url:'https://meet.example.test/old',online_links_extra:[],conference_id:'123',conference_access_code:'0001'}
const editor=(repository,patch={})=>harness('src/components/teaching/TeachingScheduleEditor.tsx','TeachingScheduleEditor',{lesson,repository,userId:'captured-teacher',disabled:false,onSaved:async()=>{},...patch})
const event={preventDefault(){}}

test('editor requires explicit server capability; saves one exact canonical link write and retains conference fields',async()=>{
  const saved=[],refreshes=[],pending=deferred()
  const repository={saveScheduleLinks:(...args)=>{saved.push(args);return pending.promise},requestScheduleChange(){throw Error('No proposal for link edits')}}
  for(const patch of [{can_edit_schedule:false},{schedule_updated_at:undefined},{source:'seminar'}]){const hidden=editor(repository,{lesson:{...lesson,...patch}});assert.equal(hidden.tree,null);hidden.unmount()}
  const h=editor(repository,{onSaved:async()=>{refreshes.push(true)}})
  h.button('Змінити посилання').props.onClick();h.render()
  const input=h.find(node=>node.type==='input'&&node.props.type==='url');input.props.onChange({target:{value:'https://meet.example.test/new'}});h.render()
  const form=h.find(node=>node.type==='form');const first=form.props.onSubmit(event);form.props.onSubmit(event);h.render()
  assert.equal(saved.length,1);assert.equal(saved[0][0],lesson);assert.equal(saved[0][2],'captured-teacher')
  assert.equal(saved[0][1].online_url,'https://meet.example.test/new');assert.equal(saved[0][1].conference_access_code,'0001')
  assert.equal(h.find(node=>node.type==='fieldset').props.disabled,true)
  pending.resolve({saved:true});await first;await h.settle()
  assert.equal(refreshes.length,1);assert.match(text(h.tree),/Посилання оновлено в розкладі групи/);assert.equal(h.find(node=>node.type==='form'),undefined)
  h.unmount()
})

test('date/cancellation sends an occurrence proposal; pending and past lessons cannot request another change',async()=>{
  const calls=[];const repository={saveScheduleLinks(){throw Error('Never change canonical schedule directly')},requestScheduleChange:async(...args)=>{calls.push(args);return{id:'request',status:'pending'}}}
  const h=editor(repository)
  h.button('Перенести або скасувати').props.onClick();h.render()
  h.find(node=>node.type==='select').props.onChange({target:{value:'cancel'}});h.render()
  h.find(node=>node.type==='textarea').props.onChange({target:{value:'Офіційне перенесення заходу'}});h.render()
  assert.match(text(h.tree),/після погодження/);assert.match(text(h.tree),/оцінки залишаться/)
  await h.find(node=>node.type==='form').props.onSubmit(event);await h.settle()
  assert.equal(calls.length,1);assert.deepEqual(plain(calls[0]),[lesson,{kind:'cancel',reason:'Офіційне перенесення заходу'},'captured-teacher'])
  assert.match(text(h.tree),/До підтвердження.*розклад не зміниться/)
  h.unmount()
  for(const patch of [{schedule_change_status:'pending'},{lesson_date:'2026-11-15'}]){const blocked=editor(repository,{lesson:{...lesson,...patch}});assert.equal(blocked.button('Перенести або скасувати').props.disabled,true);blocked.unmount()}
})

test('save failures preserve typed content; late success after account unmount cannot refresh or expose a prior scope',async()=>{
  const pending=deferred(),refreshes=[]
  const repository={saveScheduleLinks:()=>pending.promise,requestScheduleChange:async()=>({})}
  const h=editor(repository,{onSaved:async()=>refreshes.push(true)});h.button('Змінити посилання').props.onClick();h.render()
  const submission=h.find(node=>node.type==='form').props.onSubmit(event);h.unmount();pending.resolve({saved:true});await submission
  assert.equal(refreshes.length,0)
  const failed=editor({...repository,saveScheduleLinks:async()=>{throw Error('TEACHING_SCHEDULE_CONFLICT')}})
  failed.button('Змінити посилання').props.onClick();failed.render();failed.find(node=>node.type==='input'&&node.props.type==='url').props.onChange({target:{value:'https://meet.example.test/keep-local'}});failed.render()
  await failed.find(node=>node.type==='form').props.onSubmit(event);await failed.settle()
  assert.match(text(failed.tree),/TEACHING_SCHEDULE_CONFLICT/);assert.equal(failed.find(node=>node.type==='input'&&node.props.type==='url').props.value,'https://meet.example.test/keep-local')
  failed.unmount()
})

const pendingRequest={id:'request-one',schedule_id:'canonical-slot',course_id:'exact-course',course_title:'Менеджмент',teacher_name:'Synthetic teacher',subject:'Менеджмент',lesson_date:'2026-11-23',original_start:'09:40:00',original_end:'11:00:00',change_kind:'move',proposed_date:'2026-11-24',proposed_start:'11:20:00',proposed_end:'12:40:00',reason:'Synthetic reason',status:'pending',created_at:'2026-11-16T10:00:00Z'}
test('group review passes captured actor, serializes approval and refreshes timetable only for an approved request',async()=>{
  for(const status of ['approved','rejected','stale']){
    const calls=[],changed=[],pending=deferred();let loaded=0
    const h=harness('src/components/schedule/ScheduleTeacherRequests.tsx','ScheduleTeacherRequests',{groupId:'exact-group',currentUserId:'group-deputy',onChanged:async()=>changed.push(true)},{'../../lib/teachingSchedule':{listTeachingScheduleRequests:async group=>{assert.equal(group,'exact-group');return{requests:loaded++ ? [] : [pendingRequest]}},reviewTeachingScheduleRequest:(...args)=>{calls.push(args);return pending.promise}}})
    await h.settle();assert.match(text(h.tree),/Synthetic teacher/)
    const button=h.button(status==='rejected'?'Відхилити':'Погодити зміну');const first=button.props.onClick();button.props.onClick();h.render();assert.equal(calls.length,1);assert.deepEqual(calls[0],['request-one',status!=='rejected','group-deputy'])
    pending.resolve({status});await first;await h.settle();assert.equal(changed.length,status==='approved'?1:0);assert.doesNotMatch(text(h.tree),/Synthetic teacher/)
    h.unmount()
  }
})

test('safe links normalization rejects active content, credentials and controls while preserving extra links and access codes',()=>{
  const links=compile(read('src/lib/studyGroupLinks.ts'),{})
  const api=compile(read('src/lib/teachingSchedule.ts'),{'./supabase':{supabase:{}},'./studyGroupLinks':links})
  const base={online_url:' https://meet.example.test/main ',online_url_secondary:null,online_url_label:' Пара ',online_url_secondary_label:null,online_links_extra:[{url:'https://meet.example.test/backup',label:' Резерв '}],conference_id:' 123 456 ',conference_access_code:' 000067 '}
  const normalized=api.normalizeTeachingScheduleLinks(base);assert.equal(normalized.online_url,'https://meet.example.test/main');assert.equal(normalized.online_url_label,'Пара');assert.equal(normalized.conference_access_code,'000067');assert.equal(normalized.online_links_extra[0].label,'Резерв')
  for(const online_url of ['javascript:alert(1)','data:text/html,<script>x</script>','https://name:password@example.test','https://example.test/\u202Ehidden'])assert.throws(()=>api.normalizeTeachingScheduleLinks({...base,online_url}),/Посилання|посилання/)
  assert.throws(()=>api.normalizeTeachingScheduleLinks({...base,online_url_label:'x'.repeat(81)}),/80/)
})

test('changing the account during teacher save ignores late completion and invalidates the captured old form',async()=>{
  const pending=deferred(),saved=[],refreshes=[]
  const h=editor({saveScheduleLinks:(...args)=>{saved.push(args);return pending.promise},requestScheduleChange:async()=>({})},{onSaved:async()=>refreshes.push(true)})
  h.button('Змінити посилання').props.onClick();h.render();const oldForm=h.find(node=>node.type==='form').props.onSubmit
  const writing=oldForm(event)
  h.props.userId='replacement-teacher';h.render();pending.resolve({saved:true});await writing;await h.settle()
  assert.equal(refreshes.length,0);assert.doesNotMatch(text(h.tree),/Посилання оновлено/)
  await oldForm(event);assert.equal(saved.length,1)
  h.unmount()
})

test('a pending group review cannot install old-account results or refresh the new group',async()=>{
  const pending=deferred(),changes=[],calls=[]
  const h=harness('src/components/schedule/ScheduleTeacherRequests.tsx','ScheduleTeacherRequests',{groupId:'first-group',currentUserId:'first-deputy',onChanged:async()=>changes.push(true)},{'../../lib/teachingSchedule':{listTeachingScheduleRequests:async group=>({requests:group==='first-group'?[pendingRequest]:[]}),reviewTeachingScheduleRequest:(...args)=>{calls.push(args);return pending.promise}}})
  await h.settle();const oldApprove=h.button('Погодити зміну').props.onClick;const writing=oldApprove()
  h.props.currentUserId='replacement-deputy';h.props.groupId='replacement-group';h.render();await h.settle()
  pending.resolve({status:'approved'});await writing;await h.settle()
  assert.equal(changes.length,0);assert.doesNotMatch(text(h.tree),/Зміну погоджено|Synthetic teacher/)
  await oldApprove();assert.equal(calls.length,1)
  h.unmount()
})
