// Exercise the actual stateful course card and presentational form with synthetic RPCs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=await readFile(new URL('../../src/components/StudyGroupCourseCard.tsx',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}})
assert.equal((compiled.diagnostics||[]).length,0)
const status=(groupId,extra={})=>({groupId,academicYear:2026,cohortStartYear:null,level:null,course:null,archived:false,outsideCurrentPeriod:false,confirmed:false,needsConfirmation:true,...extra})
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function nodes(node){if(!node||typeof node!=='object')return[];return Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node||typeof node!=='object')return'';return Array.isArray(node)?node.map(text).join(''):text(node.props?.children)}
function fixture(t,overrides={}){
  const cells=[],effects=[],calls=[],pending=[],ready=[],created=[];let at=0,dirty=false,tree,uuid=0,unmounted=false
  let props={actorId:'actor-a',applicationId:'application-a',groupName:'МА-2',onReady:value=>ready.push(value),onCreated:id=>created.push(id),...overrides}
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]))
  const react={useState(initial){const index=at++;cells[index]||={value:typeof initial==='function'?initial():initial};return[cells[index].value,next=>{const value=typeof next==='function'?next(cells[index].value):next;if(!Object.is(value,cells[index].value)){cells[index].value=value;dirty=true}}]},useRef(initial){const index=at++;cells[index]||={current:initial};return cells[index]},useEffect(callback,deps){const index=at++;if(!cells[index]||!equal(cells[index].deps,deps)){const prior=cells[index];cells[index]={deps};effects.push(()=>{prior?.cleanup?.();cells[index].cleanup=callback()})}}}
  const rpc=name=>(...args)=>{calls.push({name,args});const request=deferred();pending.push(request);return request.promise}
  const modules={react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},'lucide-react':new Proxy({},{get:()=>()=>null}),
    '../lib/studyYearProgression':{currentAcademicYear:()=>2026},'../lib/studyGroupCourse':{confirmGroupCourse:rpc('confirm'),createStudyGroupWithCourse:rpc('create'),loadGroupCourse:rpc('load'),requestGroupIdentityReview:rpc('review'),groupCourseNeedsReview:failure=>/збігаються|відрізняються/.test(failure.message)},
  }
  const module={exports:{}}
  runInNewContext(compiled.outputText,{module,exports:module.exports,Error,AbortController,Map,crypto:{randomUUID:()=>`synthetic-command-${++uuid}`},require(name){assert.ok(name in modules,'No live dependency '+name);return modules[name]}})
  const render=()=>{for(let n=0;n<25;n++){at=0;dirty=false;tree=module.exports.StudyGroupCourseCard(props);if(tree?.type===module.exports.GroupCourseCard)tree=module.exports.GroupCourseCard(tree.props);effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Render loop')}
  const find=(type,predicate=()=>true)=>nodes(render()).find(x=>x.type===type&&predicate(x.props))
  const button=label=>{const node=find('button',p=>text(p.children).trim()===label);assert.ok(node,'Missing button '+label);return node.props}
  const settle=async()=>{for(let n=0;n<8;n++)await Promise.resolve();render()}
  render();t.after(()=>{if(!unmounted)cells.forEach(cell=>cell?.cleanup?.())})
  return{calls,pending,ready,created,button,find,settle,get text(){return text(render())},get tree(){return render()},
    async loaded(value){pending.at(-1).resolve(value);await settle()},
    choose(label,value){const node=find('select',p=>p['aria-label']===label);assert.ok(node);node.props.onChange({target:{value}});render()},
    fill(course='1',level='bachelor'){this.choose('Поточний курс',course);this.choose('Рівень навчання',level)},
    ack(value=true){const node=find('input',p=>p.type==='checkbox');assert.ok(node);node.props.onChange({target:{checked:value}});render()},
    submit(){const form=find('form');assert.ok(form);form.props.onSubmit({preventDefault(){}});render()},
    update(next){props={...props,...next};render()},
    leave(){unmounted=true;cells.forEach(cell=>cell?.cleanup?.())},
  }
}

test('unknown group creation never infers course or degree from group number and requires acknowledgement',t=>{
  const fx=fixture(t);assert.equal(fx.calls.length,0);assert.equal(fx.find('select',p=>p['aria-label']==='Поточний курс').props.value,'');assert.equal(fx.find('select',p=>p['aria-label']==='Рівень навчання').props.value,'')
  fx.submit();assert.equal(fx.calls.length,0);fx.fill();fx.submit();assert.equal(fx.calls.length,0);assert.equal(fx.button('Створити безкоштовно').disabled,true)
  fx.ack();assert.equal(fx.button('Створити безкоштовно').disabled,false);fx.choose('Поточний курс','2');assert.equal(fx.find('input',p=>p.type==='checkbox').props.checked,false)
})
test('known approval anchors prefill the actual course and degree without checking acknowledgement',t=>{
  const fx=fixture(t,{initialCohort:2025,initialLevel:'master'});assert.equal(fx.find('select',p=>p['aria-label']==='Поточний курс').props.value,2);assert.equal(fx.find('select',p=>p['aria-label']==='Рівень навчання').props.value,'master');assert.equal(fx.find('input',p=>p.type==='checkbox').props.checked,false)
})
test('same payload retry reuses its command UUID, changed payload gets another and double click makes one request',async t=>{
  const fx=fixture(t);fx.fill();fx.ack();fx.submit();fx.submit();assert.equal(fx.calls.length,1);const first=fx.calls[0].args[3]
  fx.pending[0].reject(new Error('Не вдалося перевірити результат.'));await fx.settle();fx.submit();assert.equal(fx.calls.length,2);assert.equal(fx.calls[1].args[3],first)
  fx.pending[1].reject(new Error('Не вдалося перевірити результат.'));await fx.settle();fx.choose('Поточний курс','2');fx.ack();fx.submit();assert.notEqual(fx.calls[2].args[3],first)
})
test('successful creation invokes navigation callback only after returned ID acknowledgement',async t=>{
  const fx=fixture(t);fx.fill();fx.ack();fx.submit();assert.deepEqual(fx.created,[]);fx.pending[0].resolve('returned-own-group');await fx.settle();assert.deepEqual(fx.created,['returned-own-group'])
})
test('existing unknown group loads blank fields, confirms once and enables owner controls after acknowledgement',async t=>{
  const fx=fixture(t,{groupId:'group-a',applicationId:undefined});assert.match(fx.text,/Перевіряємо курс/);assert.deepEqual(fx.ready,[false]);await fx.loaded(status('group-a'));assert.equal(fx.find('select',p=>p['aria-label']==='Поточний курс').props.value,'')
  fx.fill('3','bachelor');fx.ack();fx.submit();assert.equal(fx.calls[1].name,'confirm');assert.deepEqual(fx.ready,[false,false]);fx.pending[1].resolve({replayed:false});await fx.settle();assert.equal(fx.find('form'),undefined);assert.equal(fx.ready.at(-1),true)
})
test('known identity mismatch offers private review without changing the anchored group',async t=>{
  const fx=fixture(t,{groupId:'group-a',applicationId:undefined});await fx.loaded(status('group-a',{cohortStartYear:2025,course:2,level:'bachelor'}));fx.choose('Поточний курс','1');fx.ack();fx.submit()
  fx.pending[1].reject(new Error('Дані відрізняються від підтвердженого набору.'));await fx.settle();assert.equal(fx.button('Передати на перевірку').disabled,false);fx.button('Передати на перевірку').onClick();fx.tree;assert.equal(fx.calls[2].name,'review')
  fx.pending[2].resolve({id:'case'});await fx.settle();assert.match(fx.text,/Звернення передано/);const count=fx.calls.length;fx.submit();assert.equal(fx.calls.length,count);assert.equal(fx.button('Підтвердити курс').disabled,true)
})
test('archived groups show the past-period explanation without a fake course or confirmation form',async t=>{
  const fx=fixture(t,{groupId:'archive',applicationId:undefined});await fx.loaded(status('archive',{cohortStartYear:2010,course:null,level:'bachelor',archived:true,outsideCurrentPeriod:true,needsConfirmation:false}));assert.match(fx.text,/поза поточним періодом/);assert.doesNotMatch(fx.text,/1 курс|16 курс|null курс/);assert.equal(fx.find('form'),undefined);assert.equal(fx.ready.at(-1),true)
})
test('load failure cannot unlock owner controls or render a writable guessed identity',async t=>{
  const fx=fixture(t,{groupId:'group-a',applicationId:undefined});fx.pending[0].reject(new Error('Не вдалося перевірити дані групи.'));await fx.settle();assert.equal(fx.find('form'),undefined);assert.equal(fx.ready.includes(true),false);assert.match(fx.text,/Оновіть сторінку/)
})
test('group and account changes abort old reads, clear old status and disregard their late result',async t=>{
  const fx=fixture(t,{groupId:'group-a',applicationId:undefined});fx.update({actorId:'actor-b',groupId:'group-b'});assert.equal(fx.calls[0].args[2].aborted,true);fx.pending[0].resolve(status('group-a',{cohortStartYear:2025,course:2,level:'bachelor',confirmed:true,needsConfirmation:false}));await fx.settle();assert.match(fx.text,/Перевіряємо курс/);assert.equal(fx.ready.includes(true),false)
  fx.pending[1].resolve(status('group-b'));await fx.settle();assert.equal(fx.find('select',p=>p['aria-label']==='Поточний курс').props.value,'')
})
test('changed application aborts old creation, clears choices and prevents old finally from unlocking a newer request',async t=>{
  const fx=fixture(t);fx.fill();fx.ack();fx.submit();fx.update({actorId:'actor-b',applicationId:'application-b'});assert.equal(fx.calls[0].args[4].aborted,true);assert.equal(fx.find('select',p=>p['aria-label']==='Поточний курс').props.value,'')
  fx.fill('2','master');fx.ack();fx.submit();assert.equal(fx.calls.length,2);fx.pending[0].resolve('old-group');await fx.settle();assert.deepEqual(fx.created,[]);fx.submit();assert.equal(fx.calls.length,2);assert.equal(fx.button('Створити безкоштовно').disabled,true)
  fx.pending[1].resolve('new-group');await fx.settle();assert.deepEqual(fx.created,['new-group'])
})
test('unmount aborts mutation and prevents late ready or navigation callback',async t=>{
  const fx=fixture(t);fx.fill();fx.ack();fx.submit();fx.leave();assert.equal(fx.calls[0].args[4].aborted,true);fx.pending[0].resolve('old-group');await fx.settle();assert.deepEqual(fx.created,[])
})
