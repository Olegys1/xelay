// Actual component callbacks with synthetic rows; no Supabase or network imports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=await readFile(new URL('../../src/components/AdminStudyGroupIdentityReviews.tsx',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}})
assert.equal((compiled.diagnostics||[]).length,0)
const actor='synthetic-admin'
const row={id:'review',status:'pending',requestId:'application',groupId:null,course:1,academicYear:2026,level:'bachelor',resolutionReason:null,createdAt:'2026-10-29T00:00:00Z',kind:'creation',groupName:'ЕУБ-1',specialty:'Синтетична ОП',unit:'Факультет',university:'КНУ',message:'Потрібно уточнити курс',applicant:{id:'headman',name:'Тестова староста',username:'synthetic.headman'},collisionGroups:[
  {id:'unknown',name:'ЕУБ-1',representative:'Інша староста',cohort:null,level:null,unchanged:true},
  {id:'known',name:'ЕУБ-1',representative:'Відомий набір',cohort:2025,level:'bachelor',unchanged:true},
  {id:'stale',name:'ЕУБ-1',representative:'Змінені дані',cohort:null,level:null,unchanged:false},
]}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
function nodes(node){if(!node||typeof node!=='object')return[];return Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]}
function text(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node||typeof node!=='object')return'';return Array.isArray(node)?node.map(text).join(''):text(node.props?.children)}
function fixture(t,{items=[row],total=items.length,auth}={}){
  const cells=[],effects=[],reads=[],writes=[],readRequests=[],writeRequests=[]
  let at=0,dirty=false,tree,currentAdmin=true,props={actor,isCurrent:()=>currentAdmin},authState=auth||{authUser:{id:actor},xelayUser:{id:actor,isPlatformAdmin:true},isLoading:false}
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]))
  const react={useId:()=> 'test-identity',
    useState(initial){const index=at++;cells[index]||={value:typeof initial==='function'?initial():initial};return[cells[index].value,next=>{const value=typeof next==='function'?next(cells[index].value):next;if(!Object.is(value,cells[index].value)){cells[index].value=value;dirty=true}}]},
    useRef(initial){const index=at++;cells[index]||={current:initial};return cells[index]},
    useEffect(callback,deps){const index=at++;if(!cells[index]||!equal(cells[index].deps,deps)){const prior=cells[index];cells[index]={deps};effects.push(()=>{prior?.cleanup?.();cells[index].cleanup=callback()})}},
  }
  const modules={react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},
    'lucide-react':new Proxy({},{get:()=>()=>null}), '../context/AuthContext':{useAuth:()=>authState},'../lib/studyYearProgression':{currentAcademicYear:()=>2026},
    './CommunityChatPrimitives':{chatInput:'input',chatButton:'button',chatPrimary:'primary'},
    '../lib/studyGroupCourse':{loadAdminGroupIdentityReviews(...args){reads.push(args);const request=deferred();readRequests.push(request);return request.promise},resolveGroupIdentityReview(...args){writes.push(args);const request=deferred();writeRequests.push(request);return request.promise}},
  }
  const module={exports:{}}
  runInNewContext(compiled.outputText,{module,exports:module.exports,Error,AbortController,require(name){assert.ok(name in modules,'No live import: '+name);return modules[name]}})
  const render=()=>{for(let n=0;n<25;n++){at=0;dirty=false;tree=module.exports.AdminStudyGroupIdentityReviewQueue(props);effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Render loop')}
  const find=(type,predicate=()=>true)=>nodes(render()).find(node=>node.type===type&&predicate(node.props))
  const button=label=>{const node=find('button',props=>text(props.children).trim().startsWith(label));assert.ok(node,'Button '+label);return node.props}
  const field=(label,type='select')=>{const node=nodes(render()).find(node=>node.type==='label'&&text(node.props.children).startsWith(label));assert.ok(node,'Label '+label);const control=nodes(node).find(node=>node.type===type);assert.ok(control,'Control '+label);return control.props}
  const choose=(label,value)=>{field(label).onChange({target:{value}});render()}
  const settle=async()=>{for(let n=0;n<6;n++)await Promise.resolve();render()}
  render();t.after(()=>cells.forEach(cell=>cell?.cleanup?.()))
  return{reads,writes,readRequests,writeRequests,button,field,choose,find,settle,get tree(){return render()},get text(){return text(render())},
    async ready(){readRequests[0].resolve({items,total});await settle()},open(){button('Перевірити звернення').onClick();render()},
    reason(value='Перевірено підтвердження старости'){field('Пояснення рішення','textarea').onChange({target:{value}});render()},
    ack(){find('input',x=>x.type==='checkbox').props.onChange({target:{checked:true}});render()},
    submit(){const form=find('form');assert.ok(form);const result=form.props.onSubmit({preventDefault(){}});render();return result},
    gate(next){authState=next;at=0;return module.exports.AdminStudyGroupIdentityReviews()},
    leave(){currentAdmin=false;cells.forEach(cell=>cell?.cleanup?.())},
  }
}

test('same-account platform administrator gate hides loading, signed-out, changed and ordinary profiles',t=>{
  const fx=fixture(t)
  for(const auth of [{authUser:null,xelayUser:{id:actor,isPlatformAdmin:true}},{authUser:{id:'new'},xelayUser:{id:actor,isPlatformAdmin:true}},{authUser:{id:actor},xelayUser:{id:actor,isPlatformAdmin:false}},{authUser:{id:actor},xelayUser:{id:actor,isPlatformAdmin:true},isLoading:true}])assert.equal(fx.gate(auth),null)
})
test('bounded status pagination resets old decision state and sends only one scoped read',async t=>{
  const fx=fixture(t,{total:45});assert.equal(fx.reads.length,1);assert.deepEqual(fx.reads[0].slice(0,3),[actor,'pending',0]);await fx.ready();fx.open()
  fx.choose('Рішення','close');fx.reason();fx.ack();fx.button('Наступні').onClick();fx.tree
  assert.equal(fx.reads.length,2);assert.deepEqual(fx.reads[1].slice(0,3),[actor,'pending',20]);assert.equal(fx.find('form'),undefined)
  fx.readRequests[1].resolve({items:[],total:0});await fx.settle();assert.equal(fx.reads.length,3);assert.equal(fx.reads[2][2],0)
})
test('no action, collision, course, degree or acknowledgement is chosen for an administrator',async t=>{
  const fx=fixture(t);await fx.ready();fx.open();assert.equal(fx.field('Рішення').value,'');assert.equal(fx.button('Зберегти рішення').disabled,true)
  fx.choose('Рішення','confirm_identity');assert.equal(fx.field('Існуюча група для перевірки').value,'');assert.equal(fx.field('Підтверджений курс').value,'');assert.equal(fx.field('Рівень освіти').value,'')
  const options=nodes(fx.tree).filter(node=>node.type==='option');assert.equal(options.find(x=>x.props.value==='known').props.disabled,true);assert.equal(options.find(x=>x.props.value==='stale').props.disabled,true)
  fx.choose('Існуюча група для перевірки','known');fx.choose('Підтверджений курс','1');fx.choose('Рівень освіти','bachelor');fx.reason();fx.ack();await fx.submit();assert.equal(fx.writes.length,0)
})
test('explicit valid confirmation runs once, waits for server acknowledgement, and reloads before another decision',async t=>{
  const fx=fixture(t);await fx.ready();fx.open();fx.choose('Рішення','confirm_identity');fx.choose('Існуюча група для перевірки','unknown');fx.choose('Підтверджений курс','2');fx.choose('Рівень освіти','master');fx.reason()
  assert.equal(fx.button('Зберегти рішення').disabled,true);fx.ack();const first=fx.submit();fx.submit();assert.equal(fx.writes.length,1)
  assert.equal(fx.writes[0][2],'confirm_identity');assert.equal(fx.writes[0][4],'unknown');assert.deepEqual(JSON.parse(JSON.stringify(fx.writes[0][5])),{course:2,level:'master',academicYear:2026})
  assert.doesNotMatch(fx.text,/Рішення збережено/);assert.equal(fx.button('Зберегти рішення').disabled,true)
  fx.writeRequests[0].resolve({id:row.id,status:'resolved',groupId:'unknown'});await first;await fx.settle();assert.match(fx.text,/Рішення збережено/);assert.equal(fx.reads.length,2);assert.equal(fx.find('form'),undefined)
})
test('own cases are close-only even if a stale callback attempts to select another action',async t=>{
  const fx=fixture(t,{items:[{...row,applicant:{...row.applicant,id:actor}}]});await fx.ready();fx.open();assert.match(fx.text,/інший адміністратор/)
  const options=nodes(fx.tree).filter(x=>x.type==='option').map(x=>x.props.value);assert.equal(options.includes('confirm_identity'),false);assert.equal(options.includes('distinct'),false)
  fx.choose('Рішення','distinct');fx.choose('Існуюча група для перевірки','unknown');fx.reason();fx.ack();await fx.submit();assert.equal(fx.writes.length,0)
  fx.choose('Рішення','close');fx.reason();fx.ack();const pending=fx.submit();assert.equal(fx.writes[0][2],'close');assert.equal(fx.writes[0][4],null);assert.equal(fx.writes[0][5],null)
  fx.writeRequests[0].resolve({status:'closed'});await pending
})
test('distinction uses captured application identity and never offers it for an existing group correction case',async t=>{
  const fx=fixture(t);await fx.ready();fx.open();fx.choose('Рішення','distinct');fx.choose('Існуюча група для перевірки','unknown');fx.reason();fx.ack();assert.match(fx.text,/Нову групу створить сам староста/)
  const pending=fx.submit();assert.deepEqual(JSON.parse(JSON.stringify(fx.writes[0][5])),{course:1,level:'bachelor',academicYear:2026});fx.writeRequests[0].resolve({status:'resolved'});await pending
  const group=fixture(t,{items:[{...row,kind:'group',requestId:null,groupId:'unknown'}]});await group.ready();group.open();assert.equal(nodes(group.tree).some(x=>x.type==='option'&&x.props.value==='distinct'),false)
})
test('failed or uncertain mutation drops stale records, shows no success and requires a fresh list',async t=>{
  const fx=fixture(t);await fx.ready();fx.open();fx.choose('Рішення','close');fx.reason();fx.ack();const pending=fx.submit();fx.writeRequests[0].reject(new Error('Група або заявка вже змінилася.'))
  await pending;await fx.settle();assert.match(fx.text,/оновіть список/);assert.doesNotMatch(fx.text,/Рішення збережено/);assert.equal(fx.find('form'),undefined)
  fx.button('Повторити перевірку').onClick();fx.tree;assert.equal(fx.reads.length,2)
})
test('MFA load failure exposes no retained group records and offers manual retry without polling',async t=>{
  const fx=fixture(t);fx.readRequests[0].reject(new Error('Підтвердьте двоетапний вхід адміністратора.'));await fx.settle()
  assert.match(fx.text,/двоетапний вхід/);assert.doesNotMatch(fx.text,/Синтетична ОП/);assert.equal(fx.reads.length,1)
  fx.button('Повторити перевірку').onClick();fx.tree;assert.equal(fx.reads.length,2)
})
test('late responses after admin exit are aborted and cannot expose records or claim a saved decision',async t=>{
  const fx=fixture(t);fx.leave();assert.equal(fx.reads[0][3].aborted,true);fx.readRequests[0].resolve({items:[row],total:1});await fx.settle();assert.doesNotMatch(fx.text,/Синтетична ОП/)
  const writing=fixture(t);await writing.ready();writing.open();writing.choose('Рішення','close');writing.reason();writing.ack();const pending=writing.submit();writing.leave();assert.equal(writing.writes[0][6].aborted,true);writing.writeRequests[0].resolve({status:'closed'});await pending;await writing.settle();assert.doesNotMatch(writing.text,/Рішення збережено/)
})
