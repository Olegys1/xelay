// Execute real publication handlers with fictional accounts and no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX}}).outputText
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const buttonText = node => text(node).trim().replace(/\s+/g,' ').replace(/\(\s+/g,'(').replace(/\s+\)/g,')')
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const question = {id:'q1',kind:'boolean',text:'Вигадане запитання',points:1,time_limit_seconds:null,partial_credit:false,options:[{id:'a',text:'Так'},{id:'b',text:'Ні'}],buckets:[],answer:'a'}
const definition = patch => ({id:'test',course_id:'course',title:'Вигаданий тест',description:'',status:'published',opens_at:'2026-11-14T11:10:00Z',closes_at:'2026-11-14T12:30:00Z',duration_seconds:1800,max_points:20,category:'',journal_date:'2026-11-14',work_type:'Тест',allow_skip:true,allow_return:true,question_timer_policy:'continue',restrict_copy:true,bonus_percent:0,bonus_points:0,targets:[{group_id:'g',audience_mode:'all',subgroup_ids:[]}],questions:[question],question_count:1,version:4,has_attempts:true,results_finalized_at:null,review_revision:0,approved_revision:null,can_republish:true,...patch})
const candidate = (id, started, patch={}) => ({user_id:'u-'+id,group_id:'g',student_name:'Вигаданий '+id,source_attempt_id:id,started_at:'2026-11-14T'+started+'Z',expires_at:'2026-11-14T11:30:00Z',status:'submitted',eligible:true,reason:null,...patch})
const candidates = [candidate('early','11:10:00'),candidate('boundary','11:25:00'),candidate('later','11:26:00'),candidate('active','11:12:00',{status:'in_progress',eligible:false,reason:'active'}),candidate('pending','11:15:00',{eligible:false,reason:'pending_retake'})]
const response = patch => ({test:definition({publication_draft:{version:2,base_version:4,saved_at:'2026-11-14T11:35:00Z',definition:definition(),change_kind:'settings'}}),attempt:null,attempts:[],republish_candidates:structuredClone(candidates),server_now:'2026-11-14T11:35:00Z',...patch})
const helperModule = {exports:{}}
runInNewContext(compile(read('src/lib/teachingTestPublication.ts')), {module:helperModule,exports:helperModule.exports,structuredClone,Date,Set,Map})
const helpers = helperModule.exports

function fixture(options={}) {
  const cells=[],effects=[],calls=[],saved=[]
  let index=0,dirty=false,tree,mounted=true,current=options.detail||response(),uuid=0
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]))
  const hooks={
    useState(initial){const i=index++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{if(!mounted)return;const value=typeof next==='function'?next(cells[i].value):next;if(!Object.is(value,cells[i].value)){cells[i].value=value;dirty=true}}]},
    useRef(initial){const i=index++;return cells[i]??={current:initial}},
    useEffect(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const old=cells[i];cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[i].cleanup=fn()})}},
  }
  const jsx=(type,props)=>({type,props:props||{}})
  const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,name)=>String(name)}),
    '../../lib/teaching':{teachingDate:value=>value,kyivDeadline:value=>{try{return new Date(value+'+02:00').toISOString()}catch{return null}}},
    '../../lib/teachingTests':{teachingTestError:failure=>String(failure?.message||failure)},
    '../../lib/teachingTestPublication':helpers,'./TeachingTestBuilder':{TeachingTestBuilder:'TeachingTestBuilder'},
    './TeachingUI':{TeachingButton:'TeachingButton',TeachingField:'TeachingField',TeachingModal:'TeachingModal',teachingInput:'input'},
    './teaching-test-publication.css':{},
  }
  const repository={detail:async()=>structuredClone(current),mutate:async(action,payload)=>{calls.push({action,payload:plain(payload)});return options.mutate?options.mutate(action,payload,calls.length):response({test:definition({publication_draft:null}),republish_result:{created_retakes:1}})}}
  const module={exports:{}}
  runInNewContext(compile(read('src/components/teaching/TeachingPublishedTestEditor.tsx')),{module,exports:module.exports,structuredClone,Date,Number,Set,Map,Promise,crypto:{randomUUID:()=>`request-${++uuid}`},require(name){assert.ok(name in imports,'Known import '+name);return imports[name]}})
  const props={test:current.test,snapshot:{course:{id:'course'},groups:[{group_id:'g',group_name:'Група А'}]},repository,teachingRepository:{},userId:'teacher',onClose(){},onSaved:value=>saved.push(value)}
  const render=()=>{for(let pass=0;pass<30;pass++){index=0;dirty=false;tree=module.exports.TeachingPublishedTestEditor(props);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Hooks did not settle')}
  render()
  return{calls,saved,props,render,get tree(){return tree},
    find(predicate){const found=nodes(tree).find(predicate);assert.ok(found,'Rendered node must exist');return found},
    button(label){return this.find(node=>node.type==='TeachingButton'&&buttonText(node)===label)},
    checkbox(label){return nodes(this.find(node=>node.type==='label'&&text(node).includes(label))).find(node=>node.type==='input')},
    check(label,checked=true){this.checkbox(label).props.onChange({target:{checked}});render()},
    change(label,value){const field=nodes(this.find(node=>node.type==='TeachingField'&&node.props.label===label)).find(node=>['input','select'].includes(node.type));field.props.onChange({target:{value}});render()},
    setCurrent(value){current=value},
    async settle(){for(let i=0;i<30;i++){await Promise.resolve();render()}},
    replace(value){Object.assign(props,value);render()},
    unmount(){mounted=false;cells.forEach(cell=>cell?.cleanup?.())},
  }
}

test('publication defaults to keeping attempts and requires separate confirmation',async()=>{
  const f=fixture();await f.settle()
  assert.equal(f.checkbox('Залишити всі поточні спроби').props.checked,true)
  assert.equal(f.button('Опублікувати зміни').props.disabled,true)
  f.button('Опублікувати зміни').props.onClick();await f.settle();assert.equal(f.calls.length,0)
  f.check('Перевірив зміни');f.button('Опублікувати зміни').props.onClick();await f.settle()
  assert.equal(f.calls[0].payload.reset_policy,'keep');assert.equal(f.calls[0].payload.extend_active_attempts,false)
  assert.deepEqual(f.calls[0].payload.selected_attempt_ids,[]);assert.equal(f.saved.length,1);f.unmount()
})

test('13:25 cutoff excludes its boundary and later starts; active and pending work is never selected',async()=>{
  const f=fixture();await f.settle();f.check('Обрати, кому');f.change('Почали до, за Києвом','2026-11-14T13:25')
  assert.match(text(f.tree),/Вигаданий early/);assert.doesNotMatch(text(f.tree),/Вигаданий boundary|Вигаданий later/)
  assert.equal(f.checkbox('Вигаданий active').props.disabled,true);assert.equal(f.checkbox('Вигаданий pending').props.disabled,true)
  f.button('Обрати завершені за фільтром (1)').props.onClick();f.render();f.check('Перевірив зміни')
  f.button('Опублікувати зміни').props.onClick();await f.settle()
  assert.deepEqual(f.calls[0].payload.selected_attempt_ids,['early']);f.unmount()
})

test('changing filters clears both hidden selections and their confirmation',async()=>{
  const f=fixture();await f.settle();f.check('Обрати, кому');f.button('Обрати завершені за фільтром (3)').props.onClick();f.render();f.check('Перевірив зміни')
  f.change('Почали до, за Києвом','2026-11-14T13:25')
  assert.equal(f.checkbox('Вигаданий early').props.checked,false);assert.equal(f.checkbox('Перевірив зміни').props.checked,false)
  f.check('Перевірив зміни');assert.equal(f.button('Опублікувати зміни').props.disabled,true)
  f.button('Опублікувати зміни').props.onClick();await f.settle();assert.equal(f.calls.length,0);f.unmount()
})

test('network retry repeats the same publication receipt instead of granting twice',async()=>{
  const f=fixture({mutate:async(action,payload,count)=>{if(count===1)throw Error('Temporary network failure');return response()}})
  await f.settle();f.check('Дозволити нову спробу всім');f.check('Перевірив зміни')
  f.button('Опублікувати зміни').props.onClick();await f.settle()
  assert.equal(f.saved.length,0);assert.match(text(f.tree),/Temporary network failure/)
  f.button('Опублікувати зміни').props.onClick();await f.settle()
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].payload.request_id,f.calls[1].payload.request_id)
  assert.equal(f.calls[0].payload.reset_policy,'all_completed');assert.deepEqual(f.calls[0].payload.selected_attempt_ids,[])
  assert.equal(f.saved.length,1)
  f.unmount()
})

test('a structural draft cannot silently inherit the active-clock checkbox from a settings draft',async()=>{
  const f=fixture();await f.settle();f.check('Застосувати продовження часу',true)
  const next=response();next.test.publication_draft.change_kind='definition'
  f.setCurrent(next);f.button('Оновити спроби й чернетку').props.onClick();await f.settle()
  assert.doesNotMatch(text(f.tree),/Застосувати продовження часу/)
  f.check('Перевірив зміни');f.button('Опублікувати зміни').props.onClick();await f.settle()
  assert.equal(f.calls[0].payload.extend_active_attempts,false);f.unmount()
})

test('authoring uses the private draft action, not the live save_test endpoint',async()=>{
  const start=response({test:definition({publication_draft:null})})
  const f=fixture({detail:start,mutate:async()=>response()});await f.settle()
  assert.equal(f.tree.type,'TeachingTestBuilder');assert.equal(f.tree.props.publicationDraft,true)
  const edited=definition({title:'Уточнена назва',can_review:true,retake_grants:[{user_id:'never-copy'}]})
  await f.tree.props.onSaveDefinition(edited)
  assert.equal(f.calls[0].action,'save_published_draft');assert.equal(f.calls[0].payload.id,'test')
  assert.equal(f.calls[0].payload.expected_user_id,'teacher');assert.equal(f.calls[0].payload.draft_version,0)
  assert.equal(f.calls[0].payload.definition.title,'Уточнена назва')
  assert.equal(f.calls[0].payload.definition.retake_grants,undefined);assert.equal(start.test.title,'Вигаданий тест')
  f.unmount()
})

test('switching accounts while publication is pending cannot deliver the old result into the new account',async()=>{
  let finish
  const pending=new Promise(resolve=>{finish=resolve})
  const f=fixture({mutate:async()=>pending});await f.settle();f.check('Перевірив зміни')
  f.button('Опублікувати зміни').props.onClick();await f.settle()
  f.replace({userId:'another-teacher'});await f.settle();finish(response());await f.settle()
  assert.equal(f.saved.length,0);f.unmount()
})

test('draft payload strips other students and receipt metadata, including nested old drafts',()=>{
  const source=definition({retake_grants:[{user_id:'private'}],publication_draft:{definition:{secret:'not authored'}},previous_revisions:[{id:'old'}],can_review:true})
  const safe=plain(helpers.teachingTestPublicationDefinition(source))
  assert.equal(safe.retake_grants,undefined);assert.equal(safe.publication_draft,undefined);assert.equal(safe.previous_revisions,undefined);assert.equal(safe.can_review,undefined)
  safe.questions[0].text='changed';assert.equal(source.questions[0].text,'Вигадане запитання')
})

test('stale or in-progress attempt identifiers cannot become selected reset recipients',()=>{
  assert.throws(()=>helpers.teachingPublicationSelectedAttempts(candidates,new Set(['active'])),/Склад спроб змінився/)
  assert.throws(()=>helpers.teachingPublicationSelectedAttempts(candidates,new Set(['missing'])),/Склад спроб змінився/)
  assert.deepEqual(plain(helpers.teachingPublicationSelectedAttempts(candidates,new Set(['later','early']))),['early','later'])
})

test('permission denial hides edit and publication controls',async()=>{
  const f=fixture({detail:response({test:definition({can_republish:false})})});await f.settle()
  assert.match(text(f.tree),/недоступна цьому акаунту/);assert.doesNotMatch(text(f.tree),/Опублікувати зміни|Що зробити зі спробами/)
  assert.equal(f.calls.length,0);f.unmount()
})
