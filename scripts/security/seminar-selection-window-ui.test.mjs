import test from 'node:test'
import assert from 'node:assert/strict'
import { createSelectionUI, seminarFixture, nodes, text, plain, GROUP, USER, SEMINAR, QUESTION, TEAM, SCHEDULE, PAST_DATE, NOW, OPEN_UNTIL } from './seminar-selection-window-ui-harness.mjs'

// Actual React handler/time/API regression checks on synthetic data. SQL/RLS,
// concurrency and provider failure behavior are verified in separate suites.
const hasName=(f,name)=>nodes(f.tree).some(node=>node.props?.name===name)
const byText=(f,value)=>f.find(node=>node.type==='button'&&text(node).trim()===value)
const submitNode=f=>f.find(node=>node.type==='form')
const change=(f,node,value)=>{node.props.onChange({target:{value}});f.run.render()}
const reservation=(role='primary',target=QUESTION,user=USER)=>({id:'reservation-existing',seminar_id:SEMINAR,user_id:user,role,question_id:role==='team'?null:target,team_id:role==='team'?target:null})
const openData=(format='questions')=>seminarFixture({format,selection_deadline_at:OPEN_UNTIL})
const opening=f=>f.clickName(`seminar-selection-open-${SEMINAR}`)
const enterDeadline=f=>f.changeName('seminar-selection-deadline','2026-10-31T18:00')

test('only a seminar manager can reopen; resource permission alone grants no selection rights',async()=>{
  const manager=await createSelectionUI()
  assert.ok(hasName(manager,`seminar-selection-open-${SEMINAR}`))
  assert.equal(hasName(manager,`seminar-selection-close-${SEMINAR}`),false)
  for(const permissions of [{canEdit:false},{canEdit:false,canManageResources:true},{canEdit:false,canParticipate:false}]){
    const f=await createSelectionUI(permissions)
    assert.equal(nodes(f.tree).some(node=>(node.props?.name||'').startsWith('seminar-selection-')),false)
    assert.deepEqual(f.calls,[])
  }
})

test('archive remount removes write permissions, reopen pin and all new action controls',async()=>{
  const f=await createSelectionUI({data:openData('teams'),props:{archiveReadOnly:true}})
  for(const key of ['canEdit','canParticipate','canManageResources','canModerateComments'])assert.equal(f.entry.props[key],false)
  assert.equal(nodes(f.tree).some(node=>/^(seminar-selection-|seminar-create-team-|reopened-seminar-)/.test(node.props?.name||'')),false)
  assert.ok(text(f.tree).includes('Початкова команда'))
  assert.deepEqual(f.calls,[])
})

test('reopen sends original seminar identity and captured version with Kyiv future time; existing content is preserved',async()=>{
  const data=seminarFixture();data.reservations=[reservation()]
  const before=plain(data),f=await createSelectionUI({data})
  opening(f);enterDeadline(f);f.submit();await f.flush()
  assert.deepEqual(f.calls,[{name:'xelay_set_seminar_selection_deadline',args:{p_group_id:GROUP,p_seminar_id:SEMINAR,p_deadline:OPEN_UNTIL,p_expected_version:3}}])
  assert.equal(f.data.seminars[0].lesson_date,PAST_DATE)
  for(const key of ['questions','teams','reservations','schedule'])assert.deepEqual(f.data[key],before[key])
  assert.ok(text(f.tree).includes('Вибір відкрито до'))
  assert.ok(nodes(f.tree).some(node=>node.props?.['aria-label']==='Редагувати завдання'))
  assert.equal(nodes(f.tree).some(node=>node.type==='form'),false)
})

for(const local of ['2026-10-30T13:00','2026-02-31T18:00','not-a-date'])test(`invalid or elapsed Kyiv deadline is rejected before RPC: ${local}`,async()=>{
  const f=await createSelectionUI();opening(f);f.changeName('seminar-selection-deadline',local);f.submit();await f.flush()
  assert.deepEqual(f.calls,[])
  assert.equal(f.byName('seminar-selection-deadline').props.value,local)
  assert.ok(f.notices.some(item=>item.tone==='warning'))
})

test('closing selection uses null with current version and preserves historical selections',async()=>{
  const data=openData();data.reservations=[reservation()];const before=plain(data)
  const f=await createSelectionUI({data});f.clickName(`seminar-selection-close-${SEMINAR}`);f.submit();await f.flush()
  assert.deepEqual(f.calls,[{name:'xelay_set_seminar_selection_deadline',args:{p_group_id:GROUP,p_seminar_id:SEMINAR,p_deadline:null,p_expected_version:3}}])
  assert.ok(text(f.tree).includes('Вибір завершено'))
  for(const key of ['questions','teams','reservations'])assert.deepEqual(f.data[key],before[key])
  assert.equal(f.data.seminars[0].lesson_date,PAST_DATE)
})

test('stale version leaves deadline draft intact and never silently retries with a fresh version',async()=>{
  const f=await createSelectionUI({failure:{code:'PT409',message:'SEMINAR_SELECTION_CONFLICT'}})
  opening(f);enterDeadline(f);f.submit();await f.flush()
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.p_expected_version,3)
  assert.equal(f.byName('seminar-selection-deadline').props.value,'2026-10-31T18:00')
  assert.equal(f.notices.at(-1).tone,'error')
  assert.equal(f.data.seminars[0].selection_version,3)
})

test('captured submit cannot mutate after manager permission is revoked',async()=>{
  const f=await createSelectionUI();opening(f);enterDeadline(f);const form=submitNode(f)
  f.update({canEdit:false});form.props.onSubmit({preventDefault(){}});await f.flush()
  assert.deepEqual(f.calls,[])
  assert.equal(hasName(f,'seminar-selection-deadline'),false)
})

test('captured submit cannot cross to another account or group',async()=>{
  for(const patch of [{currentUserId:'88888888-8888-4888-8888-888888888888'},{groupId:'99999999-9999-4999-8999-999999999999'}]){
    const f=await createSelectionUI();opening(f);enterDeadline(f);const form=submitNode(f)
    f.update(patch);form.props.onSubmit({preventDefault(){}});await f.flush()
    assert.deepEqual(f.calls,[]);assert.equal(hasName(f,'seminar-selection-deadline'),false)
  }
})

test('in-flight result does not show old account success after account replacement or unmount',async()=>{
  for(const unmount of [false,true]){
    const f=await createSelectionUI({deferRpc:true});opening(f);enterDeadline(f);f.submit();await f.flush()
    assert.equal(f.calls.length,1)
    if(unmount)f.unmount();else f.update({currentUserId:'88888888-8888-4888-8888-888888888888'})
    f.release();await f.flush()
    assert.equal(f.notices.some(item=>item.tone==='success'),false)
  }
})

test('past seminar can be selected while override is open and auto-locks at effective deadline',async()=>{
  const data=openData('booking'),f=await createSelectionUI({data,canEdit:false})
  const open=byText(f,'Забронювати питання');assert.equal(open.props.disabled,false)
  assert.equal(f.actual.seminarHasStarted(data.seminars[0]),true,'Actual chronology stays in the past')
  assert.equal(f.actual.seminarSelectionIsClosed(data.seminars[0]),false)
  f.advance(Date.parse(OPEN_UNTIL)-NOW+101)
  assert.equal(byText(f,'Вибір завершено').props.disabled,true)
  assert.equal(hasName(f,`reopened-seminar-${SEMINAR}`),false)
  open.props.onClick();await f.flush()
  assert.deepEqual(f.calls,[],'Old captured booking callback rechecks current effective deadline')
})

test('own existing selection can be cancelled in an open past seminar; expired confirmation is blocked',async()=>{
  for(const expire of [false,true]){
    const data=openData();data.reservations=[reservation()]
    const f=await createSelectionUI({data,canEdit:false})
    byText(f,'Скасувати вибір').props.onClick();f.run.render()
    const dialog=f.find(node=>typeof node.type==='function'&&node.props?.title==='Скасувати свій вибір?')
    const confirm=nodes(dialog).find(node=>node.type==='button'&&text(node).trim()==='Скасувати вибір')
    assert.ok(confirm)
    if(expire)f.advance(Date.parse(OPEN_UNTIL)-NOW+101)
    confirm.props.onClick();await f.flush()
    if(expire){assert.deepEqual(f.calls,[]);assert.deepEqual(f.data.reservations,data.reservations)}
    else assert.deepEqual(f.calls,[{name:'xelay_cancel_seminar_reservation',args:{p_seminar_id:SEMINAR}}])
  }
})

test('pin navigates to the original date, subject and existing card without recreating a seminar',async()=>{
  const f=await createSelectionUI({data:openData(),props:{selectedDate:'2026-10-30'},canEdit:false})
  assert.equal(nodes(f.tree).some(node=>node.props?.id===`study-seminar-${SEMINAR}`),false)
  const all=nodes(f.tree),pin=all.findIndex(node=>node.props?.['aria-label']==='Знову відкритий вибір')
  const calendar=all.findIndex(node=>node.props?.['aria-label']==='Тиждень семінарів')
  assert.ok(pin>=0);if(calendar>=0)assert.ok(pin<calendar)
  f.clickName(`reopened-seminar-${SEMINAR}`);assert.deepEqual(f.navigation,[PAST_DATE])
  f.update({selectedDate:PAST_DATE});await f.flush();f.animationFrames()
  assert.ok(f.focus.some(([kind,id])=>kind==='scroll'&&id===`study-seminar-${SEMINAR}`))
  assert.deepEqual(f.calls,[]);assert.equal(f.data.seminars.length,1)
})

test('editing reopened old-date seminar retains question IDs and save payload on the original date',async()=>{
  const data=openData(),f=await createSelectionUI({data})
  f.find(node=>node.props?.['aria-label']==='Редагувати завдання').props.onClick();f.run.render()
  change(f,f.find(node=>node.type==='input'&&node.props?.placeholder==='Наприклад, попит і пропозиція'),'Оновлена назва')
  f.submit();await f.flush()
  const saved=f.calls.find(item=>item.name==='xelay_save_seminar_with_resources')
  assert.ok(saved);assert.equal(saved.args.p_seminar_id,SEMINAR);assert.equal(saved.args.p_lesson_date,PAST_DATE);assert.equal(saved.args.p_schedule_id,SCHEDULE)
  assert.equal(saved.args.p_questions[0].id,QUESTION);assert.equal(saved.args.p_title,'Оновлена назва')
  assert.deepEqual(saved.args.p_teams,[])
})

test('editor retains content but refuses saving after the reopened deadline expires',async()=>{
  const f=await createSelectionUI({data:openData()})
  f.find(node=>node.props?.['aria-label']==='Редагувати завдання').props.onClick();f.run.render()
  change(f,f.find(node=>node.type==='textarea'&&node.props?.placeholder==='Що підготувати до заняття та які критерії виконання'),'Збережена чернетка')
  f.advance(Date.parse(OPEN_UNTIL)-NOW+101);f.submit();await f.flush()
  assert.deepEqual(f.calls,[])
  assert.equal(f.find(node=>node.type==='textarea'&&node.props?.placeholder==='Що підготувати до заняття та які критерії виконання').props.value,'Збережена чернетка')
})

test('historical aggregate occupancy fills booking capacity without exposing prior users',async()=>{
  const data=openData('booking');data.selection_occupancy=[{seminar_id:SEMINAR,question_id:QUESTION,team_id:null,role:'booking',count:2}]
  const f=await createSelectionUI({data,canEdit:false})
  assert.equal(byText(f,'Усі місця зайняті').props.disabled,true)
  assert.match(text(f.tree).replace(/\s+/g,' '),/Зайнятих місць із попередніх записів: 2\s*\./)
  assert.equal(nodes(f.tree).some(node=>node.type==='Participant'),false)
  assert.equal(text(f.tree).includes('Питання ще можна забронювати.'),false)
})

test('aggregate occupancy is a floor; a smaller aggregate cannot free visible occupied capacity',async()=>{
  const data=openData('teams');data.teams[0].capacity=1;data.reservations=[reservation('team',TEAM,'other-current-user')]
  data.selection_occupancy=[{seminar_id:SEMINAR,question_id:null,team_id:TEAM,role:'team',count:0}]
  const f=await createSelectionUI({data,canEdit:false})
  assert.equal(byText(f,'Команда заповнена').props.disabled,true)
})

test('team editor cannot remove an occupied historical team or shrink below anonymous count',async()=>{
  const data=openData('teams');data.teams.push({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',seminar_id:SEMINAR,position:2,name:'Друга команда',capacity:5})
  data.selection_occupancy=[{seminar_id:SEMINAR,question_id:null,team_id:data.teams[1].id,role:'team',count:3}]
  const f=await createSelectionUI({data});f.find(node=>node.props?.['aria-label']==='Редагувати завдання').props.onClick();f.run.render()
  const numbers=()=>nodes(f.tree).filter(node=>node.type==='input'&&node.props?.type==='number')
  change(f,numbers()[0],1);assert.equal(numbers()[0].props.value,2)
  assert.equal(numbers()[2].props.min,3)
  assert.equal(numbers()[2].props.disabled,true,'Occupied past capacity is visibly read-only')
  change(f,numbers()[2],2);f.submit();await f.flush()
  assert.deepEqual(f.calls,[])
  assert.equal(numbers()[2].props.value,2,'Invalid draft is retained for correction, not silently rewritten')
})

test('occupied past rows are visibly immutable; future and unoccupied rows retain editing',async()=>{
  const freeId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  for(const format of ['questions','teams'])for(const past of [true,false]){
    const date=past?PAST_DATE:'2026-11-04'
    const data=seminarFixture({format,lesson_date:date,selection_deadline_at:past?OPEN_UNTIL:null})
    const occupiedId=format==='teams'?TEAM:QUESTION
    if(format==='teams')data.teams.push({id:freeId,seminar_id:SEMINAR,position:2,name:'Вільна команда',capacity:5})
    else data.questions.push({id:freeId,seminar_id:SEMINAR,position:2,body:'Вільне питання',primary_capacity:2,supplement_capacity:3})
    data.selection_occupancy=[{seminar_id:SEMINAR,question_id:format==='teams'?null:QUESTION,team_id:format==='teams'?TEAM:null,role:format==='teams'?'team':'primary',count:1}]
    const f=await createSelectionUI({data,props:{selectedDate:date}})
    f.find(node=>node.props?.['aria-label']==='Редагувати завдання').props.onClick();f.run.render()
    for(const [id,expected] of [[occupiedId,past],[freeId,false]]){
      const row=f.find(node=>node.type==='div'&&node.key===id)
      const fields=nodes(row).filter(node=>node.type==='input'||node.type==='textarea')
      assert.ok(fields.length>=2)
      for(const field of fields)assert.equal(Boolean(field.props.disabled),expected,`${format} ${past?'past':'future'} ${id}`)
    }
    const instructions=f.find(node=>node.type==='textarea'&&node.props?.placeholder==='Що підготувати до заняття та які критерії виконання')
    assert.equal(instructions.props.disabled,false)
    if(past)assert.match(text(f.tree).replace(/\s+/g,' '),/Можна редагувати загальні умови та незайняті рядки/)
  }
})

test('delete confirmation explains that existing selections cannot be deleted',async()=>{
  const f=await createSelectionUI({data:openData()})
  f.find(node=>node.props?.['aria-label']==='Видалити завдання').props.onClick();f.run.render()
  const dialog=f.find(node=>typeof node.type==='function'&&node.props?.title==='Видалити зі семінарів?')
  const content=text(dialog).replace(/\s+/g,' ')
  assert.match(content,/лише за відсутності вибору учасників/)
  assert.match(content,/Наявні бронювання видаляти не можна/)
  assert.doesNotMatch(content,/бронювання цього завдання також буде видалено/)
  assert.deepEqual(f.calls,[])
})

test('student can create and immediately join a team without receiving manager editing rights',async()=>{
  const f=await createSelectionUI({data:openData('teams'),canEdit:false})
  assert.equal(nodes(f.tree).some(node=>node.props?.['aria-label']==='Редагувати завдання'),false)
  f.clickName(`seminar-create-team-${SEMINAR}`);f.changeName('seminar-new-team-name',' Нова команда ');f.changeName('seminar-new-team-capacity','4');f.submit();await f.flush()
  assert.equal(f.calls.length,1);const saved=f.calls[0];assert.equal(saved.name,'xelay_create_seminar_team')
  assert.equal(saved.args.p_name,'Нова команда');assert.equal(saved.args.p_capacity,4);assert.equal(saved.args.p_seminar_id,SEMINAR)
  assert.ok(f.data.reservations.some(item=>item.user_id===USER&&item.team_id===saved.args.p_team_id))
  assert.equal(hasName(f,`seminar-create-team-${SEMINAR}`),false)
  assert.ok(text(f.tree).includes('Ваша команда')||text(f.tree).includes('Скасувати вибір'))
})

test('uncertain team creation response retains values and retries the same team UUID',async()=>{
  const f=await createSelectionUI({data:openData('teams'),canEdit:false,failure:{message:'Synthetic response lost'}})
  f.clickName(`seminar-create-team-${SEMINAR}`);f.changeName('seminar-new-team-name','Повторна спроба');f.submit();await f.flush()
  assert.equal(f.byName('seminar-new-team-name').props.value,'Повторна спроба')
  const first=f.calls[0].args.p_team_id;f.setFailure(null);f.submit();await f.flush()
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.p_team_id,first)
  assert.equal(f.data.teams.filter(item=>item.id===first).length,1)
})

test('team creation stays unavailable for closed seminars, nonparticipants and existing reservations',async()=>{
  const reserved=openData('teams');reserved.reservations=[reservation('team',TEAM)]
  for(const options of [{data:seminarFixture({format:'teams'})},{data:openData('teams'),canParticipate:false},{data:reserved}]){
    const f=await createSelectionUI({...options,canEdit:false})
    assert.equal(hasName(f,`seminar-create-team-${SEMINAR}`),false);assert.deepEqual(f.calls,[])
  }
})

test('team creation captured submit rechecks participation and deadline without dropping draft fields',async()=>{
  for(const revoke of [true,false]){
    const f=await createSelectionUI({data:openData('teams'),canEdit:false});f.clickName(`seminar-create-team-${SEMINAR}`);f.changeName('seminar-new-team-name','Не втратити')
    const form=submitNode(f)
    if(revoke)f.update({canParticipate:false});else f.advance(Date.parse(OPEN_UNTIL)-NOW+101)
    form.props.onSubmit({preventDefault(){}});await f.flush();assert.deepEqual(f.calls,[])
    if(!revoke)assert.equal(f.byName('seminar-new-team-name').props.value,'Не втратити')
  }
})
