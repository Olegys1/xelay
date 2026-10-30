// Executes the current component and real time/API adapters. The data loader,
// Realtime, RPC and resource Storage are explicit synthetic boundaries, not an
// authorization proof. No provider SDK, environment file, browser or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
export const GROUP = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'
export const SEMINAR = '33333333-3333-4333-8333-333333333333'
export const SUBJECT = '44444444-4444-4444-8444-444444444444'
export const SCHEDULE = '55555555-5555-4555-8555-555555555555'
export const QUESTION = '66666666-6666-4666-8666-666666666666'
export const TEAM = '77777777-7777-4777-8777-777777777777'
export const PAST_DATE = '2026-10-28'
export const NOW = Date.parse('2026-10-30T12:00:00Z')
export const OPEN_UNTIL = '2026-10-31T16:00:00.000Z'
export const plain = value => JSON.parse(JSON.stringify(value))
export const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
export const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
export function seminarFixture(overrides = {}) {
  const seminar = { id: SEMINAR, group_id: GROUP, subject_id: SUBJECT, schedule_id: SCHEDULE,
    lesson_date: PAST_DATE, starts_at: '08:00', ends_at: '09:20', title: 'Збережений семінар', instructions: 'Умови залишаються',
    format: 'questions', created_by: USER, resource_links: [], resource_attachments: [], selection_deadline_at: null, selection_version: 3, ...overrides }
  const schedule = { id: SCHEDULE, group_id: GROUP, subject_id: SUBJECT, weekday: 3, starts_at: '08:00', ends_at: '09:20', valid_from: '2026-09-01', valid_until: '2027-01-31', created_by: USER }
  return { supplement_capacity: 3, subjects: [{ id: SUBJECT, group_id: GROUP, name: 'Економіка', created_by: USER }], schedule: [schedule], seminars: [seminar],
    questions: [{ id: QUESTION, seminar_id: SEMINAR, position: 1, body: 'Початкове питання', primary_capacity: 2, supplement_capacity: 3 }],
    teams: [{ id: TEAM, seminar_id: SEMINAR, position: 1, name: 'Початкова команда', capacity: 5 }], reservations: [], profiles: {}, streaks: {}, subjectStreaks: {},
    reopened_seminars: seminar.selection_deadline_at ? [seminar] : [], reopened_schedule: [schedule], selection_occupancy: [] }
}

function runtime() {
  const cells = [], effects = []
  let index = 0, dirty = false, component, props, tree
  const same = (a,b) => a && b && a.length === b.length && a.every((value,i) => Object.is(value,b[i]))
  const hooks = {
    useState(initial) { const i=index++; if (!cells[i]) { const cell={value:typeof initial==='function'?initial():initial};cell.set=next=>{const value=typeof next==='function'?next(cell.value):next;if(!Object.is(value,cell.value)){cell.value=value;dirty=true}};cells[i]=cell }return [cells[i].value,cells[i].set] },
    useRef(initial) { const i=index++;return cells[i]??={current:initial} },
    useCallback(callback,deps) { const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,callback};return cells[i].callback },
    useMemo(callback,deps) { const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:callback()};return cells[i].value },
    useEffect(callback,deps) { const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const previous=cells[i];cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[i].cleanup=callback()})} },
  }
  const render=()=>{for(let pass=0;pass<30;pass++){index=0;dirty=false;tree=component(props);effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Synthetic hooks did not settle')}
  return { hooks, render, start(fn,initial){component=fn;props=initial;return render()}, update(patch){props={...props,...patch};return render()},
    get tree(){return tree}, get props(){return props}, async flush(){for(let pass=0;pass<12;pass++){await Promise.resolve();render()}},unmount(){for(const cell of cells)cell?.cleanup?.()} }
}

export async function createSelectionUI(options = {}) {
  const run=runtime(), calls=[], notices=[], timers=new Map(), frames=new Map(), focus=[], navigation=[], unexpected=[]
  let now=NOW, sequence=0, data=plain(options.data || seminarFixture(options.seminar)), failure=options.failure || null, paused=null
  class ClockDate extends Date { constructor(...args){super(...(args.length?args:[now]))}static now(){return now} }
  const jsx=(type,props,key)=>({type,props:props||{},key})
  const noopComponent = name => name
  const chain={on(){return chain},subscribe(){return chain}}
  const supabase={channel:()=>chain,removeChannel:async()=>{},async rpc(name,args){
    calls.push({name,args:plain(args)})
    if(options.deferRpc)await new Promise(resolve=>{paused=resolve})
    if(failure)return {data:null,error:failure}
    if(name==='xelay_set_seminar_selection_deadline'){
      const seminar=data.seminars.find(item=>item.id===args.p_seminar_id)
      assert.ok(seminar,'Synthetic RPC target exists');assert.equal(args.p_group_id,GROUP)
      const result={seminar_id:seminar.id,selection_deadline_at:args.p_deadline??new ClockDate().toISOString(),selection_version:args.p_expected_version+1}
      data={...data,seminars:data.seminars.map(item=>item.id===seminar.id?{...item,...result}:item)}
      data.reopened_seminars=data.seminars.filter(item=>item.selection_deadline_at&&Date.parse(item.selection_deadline_at)>now)
      return {data:result,error:null}
    }
    if(name==='xelay_create_seminar_team'){
      const team={id:args.p_team_id,seminar_id:args.p_seminar_id,name:args.p_name,capacity:args.p_capacity,position:data.teams.length+1}
      if(!data.teams.some(item=>item.id===team.id))data.teams.push(team)
      if(!data.reservations.some(item=>item.team_id===team.id&&item.user_id===USER))data.reservations.push({id:randomUUID(),seminar_id:SEMINAR,user_id:USER,role:'team',question_id:null,team_id:team.id})
      return {data:team,error:null}
    }
    if(name==='xelay_save_seminar_with_resources')return {data:{id:SEMINAR},error:null}
    if(['xelay_reserve_seminar','xelay_cancel_seminar_reservation'].includes(name))return {data:true,error:null}
    unexpected.push(name);throw Error('Unexpected synthetic RPC '+name)
  }}
  const resources={cleanupPendingSeminarFiles:async()=>true,removeSeminarFiles:async paths=>{assert.deepEqual(paths,[])},
    uploadSeminarFiles:async(_g,_u,files)=>{assert.equal(files.length,0);return []},updateSeminarResources:()=>{throw Error('Not under test')},
    validateSeminarResources:(links,files,attachments)=>{assert.equal(files.length,0);return {links,attachments}},seminarResourceError:error=>error?.message||String(error),
    getSeminarLinks:value=>value||[],getSeminarAttachments:value=>value||[]}
  const window={addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:true})}
  const document={hidden:false,addEventListener(){},removeEventListener(){},getElementById:id=>({focus:()=>focus.push(['focus',id]),scrollIntoView:()=>focus.push(['scroll',id])})}
  const globals={Date:ClockDate,Intl,Map,Set,Promise,Error,TypeError,RangeError,Number,window,document,crypto:{randomUUID},
    setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id)}
  function evaluate(source,imports){const exports={};const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    new Function('exports','require',...Object.keys(globals),code)(exports,name=>{assert.ok(Object.hasOwn(imports,name),'Explicit current import '+name);return imports[name]},...Object.values(globals));return exports}
  const times=evaluate(read('src/lib/scheduleCopyTimes.ts'),{})
  const timetable=evaluate(read('src/lib/studyGroupTimetable.ts'),{'./supabase':{supabase},'./scheduleCopyTimes':times})
  const subjects=evaluate(read('src/lib/scheduleSubjects.ts'),{})
  const actual=evaluate(read('src/lib/seminars.ts'),{'./supabase':{supabase},'./profiles':{getPublicProfiles:()=>{throw Error('Loader boundary must be explicit')}},'./seminarResources':resources,'./studyGroupTimetable':timetable,'./scheduleSubjects':subjects})
  const model={...actual,loadSeminars:async(groupId,date)=>{
    assert.equal(groupId,run.props.groupId)
    return {...plain(data),seminars:plain(data.seminars.filter(item=>item.lesson_date===date)),questions:plain(data.questions),teams:plain(data.teams),reservations:plain(data.reservations)}
  }}
  const components={}
  for(const [module,names] of Object.entries({'./SeminarResources':['SeminarResourceFields','SeminarResourceList'],'./SeminarComments':['SeminarComments'],'./ShareStudyAssignment':['ShareStudyAssignment'],'./AddToOrganizer':['AddToOrganizer'],'./StudyGroupLongTermTasks':['LongTermTaskList'],'./SeminarAiDraft':['SeminarAiDraft']}))components[module]=Object.fromEntries(names.map(name=>[name,noopComponent(name)]))
  const module=evaluate(read('src/components/GroupSeminars.tsx')+'\nexport { GroupSeminarsWorkspace };',{
    react:run.hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'@tanstack/react-router':{Link:'Link'},'lucide-react':new Proxy({}, {get:(_target,key)=>String(key)}),
    '../lib/supabase':{supabase},'../context/ToastContext':{useToast:()=>({notify:item=>notices.push(item)})},'../lib/seminarResources':resources,'../lib/seminars':model,...components})
  const initial={groupId:GROUP,currentUserId:USER,selectedDate:PAST_DATE,canEdit:options.canEdit??true,canParticipate:options.canParticipate??true,
    canManageResources:options.canManageResources??false,onDateChange:date=>navigation.push(date),...options.props}
  const entry=module.GroupSeminars(initial)
  run.start(entry.type,entry.props);await run.flush()
  const find=predicate=>{const node=nodes(run.tree).find(predicate);assert.ok(node,'Current source element must exist');return node}
  return {calls,notices,focus,navigation,unexpected,actual,entry,run,
    get tree(){return run.tree},get data(){return data},find,
    byName:name=>find(node=>node.props?.name===name),
    clickName(name){const node=find(node=>node.props?.name===name);assert.equal(Boolean(node.props.disabled),false);node.props.onClick();run.render()},
    changeName(name,value){find(node=>node.props?.name===name).props.onChange({target:{value}});run.render()},
    submit(){const node=find(node=>node.type==='form');node.props.onSubmit({preventDefault(){}});run.render()},
    update:patch=>run.update(patch),flush:()=>run.flush(),unmount:()=>run.unmount(),
    setFailure(value){failure=value},release(){paused?.()},setData(next){data=plain(next)},
    advance(ms){now+=ms;const ready=[...timers].filter(([,timer])=>timer.delay<=ms);for(const [id,timer] of ready){timers.delete(id);timer.fn()}run.render()},
    animationFrames(){for(const [id,fn] of [...frames]){frames.delete(id);fn()}run.render()},
  }
}
