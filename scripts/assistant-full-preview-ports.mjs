import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { createCloudConfirmedAssistantWrites } from '../server/assistant-v2/cloudWrites.ts'
import { createAuthenticatedAssistantChat } from '../server/assistant-v2/cloudChat.ts'
import { createAssistantCloudTools } from '../server/assistant-v2/cloudTools.ts'
import { createFictionalAssistantWriteFixture } from './assistant-full-fixture.mjs'
import { validateUploadContent, MAX_VALIDATED_UPLOAD_BYTES } from '../server/uploadContentValidation.ts'
import { calculateTeachingBreakdown } from '../src/lib/teachingGrading.ts'

/** Local-only fictional caller and journal adapters. The production HTTP,
 * inspection, forms, confirmation and tool orchestration are reused unchanged.
 * This module never discovers a key, calls a model on startup or uses Supabase. */
export async function createFullSyntheticAssistantPorts(options) {
  const { stateDirectory, identities, token, planner, taskModel } = options
  const now = options.now ?? Date.now, today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()))
  const nextDay = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10)
  const uid = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const numberMap = { 10:101, 11:102, 12:103, 20:301, 30:411, 39:201, 40:811, 41:812, 42:813, 43:816, 50:701, 51:702, 52:703, 60:601, 61:901, 62:902 }
  const id = n => uid(numberMap[n] ?? n + 1000), tomorrow = nextDay(today(), 1)
  const fixtures = new Map()
  for (const [role, identity] of Object.entries(identities)) fixtures.set(identity.id, await createFictionalAssistantWriteFixture({ id, userId: identity.id, headmanId: identities.representative.id, role: role === 'representative' ? 'headman' : role, credential: token(identity.id), now: now(), date: tomorrow }))
  const master = fixtures.get(identities.teacher.id), ids = master.ids, { GROUP, GROUP2, COURSE, LESSON, SEMSCHEDULE, SEM, QUESTION, ACTIVITY, ENTRY, MATERIAL } = ids
  const tables = master.state.tables
  for (const group of tables.study_groups) group.representative_id = identities.representative.id
  tables.study_group_members = [{ id:uid(911), group_id:GROUP, user_id:identities.student.id, status:'accepted' }, { id:uid(912), group_id:GROUP, user_id:identities.representative.id, status:'accepted' }]
  const baseLesson = tables.study_group_schedule[0], semesterFrom = today().slice(0, 7) + '-01', semesterUntil = nextDay(today(), 120)
  baseLesson.valid_from = semesterFrom; baseLesson.valid_until = semesterUntil
  tables.study_group_schedule.push({ ...structuredClone(baseLesson), id:uid(412), subject:'Економічна теорія', starts_at:'10:10', ends_at:'11:30', online_url:null, conference_id:'123 456 789', conference_access_code:'demo-123' }, { ...structuredClone(baseLesson), id:uid(413), group_id:GROUP2, starts_at:'13:00', ends_at:'14:20', location:'305' })
  const firstWeekday = new Date(tomorrow + 'T12:00:00Z').getUTCDay() || 7
  for (let weekday=1; weekday<=6; weekday++) if (weekday !== firstWeekday) {
    tables.study_group_schedule.push({ ...structuredClone(baseLesson), id:uid(420+weekday), weekday }, { ...structuredClone(baseLesson), id:uid(430+weekday), weekday, subject:'Економічна теорія', starts_at:'10:10', ends_at:'11:30' }, { ...structuredClone(baseLesson), id:uid(440+weekday), weekday, group_id:GROUP2, starts_at:'13:00', ends_at:'14:20' })
  }
  master.state.activity.max_points=10; master.state.activity.category='seminar'; master.state.entry.user_id=identities.student.id
  tables.teaching_grades.push({ id:uid(703), activity_id:ACTIVITY, entry_id:ENTRY, draft_score:9, draft_comment:'Гарна робота', published_score:9, published_comment:'Гарна робота', published_at:new Date(now()).toISOString(), version:1 })
  master.state.material.body='Похідна показує швидкість зміни функції. Для функції f(x)=x² похідна дорівнює 2x. Перевірте ідею на значеннях x=1 та x=2.'
  master.state.material.title='Конспект: похідна функції'; master.state.material.allow_download=false; master.state.material.created_by=identities.teacher.id
  master.state.material.targets=[{group_id:GROUP},{group_id:GROUP2}]
  tables.study_group_homework.push({ id:uid(501), group_id:GROUP, schedule_item_id:LESSON, lesson_date:tomorrow, lesson_topic:'Практична робота № 3', body:'Розв’язати вправи 1–4 і перевірити приклад із конспекту. Це вигадані дані.', due_at:null, url:null, resource_links:[], resource_link_labels:{}, attachments:[], created_by:identities.representative.id, updated_at:new Date(now()).toISOString() })
  tables.study_group_seminars.push({ id:SEM,group_id:GROUP,subject_id:uid(201),schedule_id:SEMSCHEDULE,lesson_date:tomorrow,starts_at:'11:20',ends_at:'12:40',title:'Похідна: питання до семінару',instructions:'Підготуйте коротке пояснення свого питання.',format:'questions',selection_deadline_at:new Date(now()+3*86400000).toISOString(),selection_version:1,resource_links:[],resource_attachments:[],created_by:identities.representative.id,updated_at:new Date(now()).toISOString() })
  tables.study_group_seminar_questions.push({id:QUESTION,seminar_id:SEM,body:'Що показує похідна?',primary_capacity:1,supplement_capacity:2,position:1})
  tables.study_group_seminar_schedule.push({...structuredClone(tables.study_group_seminar_schedule[0]),id:uid(814),starts_at:'13:00',ends_at:'14:20'})
  tables.study_group_seminars.push({...structuredClone(tables.study_group_seminars[0]),id:uid(815),schedule_id:uid(814),starts_at:'13:00',ends_at:'14:20',title:'Приклади застосування: команди',format:'teams'})
  tables.study_group_seminar_teams.push({id:uid(816),seminar_id:uid(815),name:'Команда 1',capacity:4,position:1})

  const statePath=path.join(stateDirectory,'synthetic-full-journal-v2.json')
  let stored={syntheticOnly:true,schema:2,drafts:[],business:null}
  try { const loaded=JSON.parse(await readFile(statePath,'utf8')); if(loaded.syntheticOnly===true&&loaded.schema===2&&Array.isArray(loaded.drafts)&&loaded.drafts.length<=500) stored=loaded } catch(error) { if(error?.code!=='ENOENT') throw Error('Synthetic preview state unavailable') }
  if(stored.business?.tables&&stored.business?.materials) {
    Object.assign(tables,stored.business.tables);master.state.materials=stored.business.materials;master.state.material=master.state.materials.find(row=>row.id===MATERIAL)??master.state.material;Object.assign(master.state.ai,stored.business.ai??{});if(stored.business.aiByMaterial)master.state.aiByMaterial=stored.business.aiByMaterial
    if(stored.business.activity)Object.assign(master.state.activity,stored.business.activity)
    if(stored.business.entry)Object.assign(master.state.entry,stored.business.entry)
  }
  for (const fixture of fixtures.values()) {
    fixture.state.tables=tables; fixture.state.materials=master.state.materials; fixture.state.material=master.state.material; fixture.state.ai=master.state.ai;fixture.state.aiByMaterial=master.state.aiByMaterial;fixture.state.activity=master.state.activity;fixture.state.entry=master.state.entry
    for(const group of fixture.state.groups){const saved=tables.teaching_course_groups.find(row=>row.group_id===group.group_id);if(saved){group.grading_version=saved.grading_version;group.grading_rules_override=saved.grading_rules_override}}
  }
  // Fixtures have separate immutable actors/rights, sharing only fictional rows.
  // Never switch one global caller identity around asynchronous operations.
  const failure=(code,status=400)=>{throw Object.assign(new Error(code),{code,status})}
  const identityOf=credential=>Object.entries(identities).find(([,identity])=>credential===token(identity.id))
  const verifySession=async credential=>{const match=identityOf(credential);return match?{userId:match[1].id,accountActive:true,emailConfirmed:true,expiresAt:new Date(now()+3600000).toISOString(),sessionId:'synthetic-preview-session'}:null}
  const owner=async credential=>{const session=await verifySession(credential);if(!session)failure('session_invalid',401);return session}
  const persist=async()=>{stored.business={tables,materials:master.state.materials,ai:master.state.ai,aiByMaterial:master.state.aiByMaterial,activity:master.state.activity,entry:master.state.entry};const temporary=statePath+'.pending';await writeFile(temporary,JSON.stringify(stored),'utf8');await rename(temporary,statePath)}
  let sequence=Promise.resolve()
  const atomic=operation=>{const result=sequence.then(operation);sequence=result.catch(()=>{});return result}
  const sameToken=(actual,expected)=>typeof actual==='string'&&/^[a-f0-9]{48}$/.test(actual)&&typeof expected==='string'&&/^[a-f0-9]{48}$/.test(expected)&&timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'))
  const journalOwner=(userId,draftId)=>{const row=stored.drafts.find(row=>row.userId===userId&&row.id===draftId);if(!row)failure('draft_not_found',404);return row}
  const bind=(row,revision,confirmationToken)=>{if(row.revision!==revision)failure('draft_changed',409);if(!sameToken(confirmationToken,row.confirmationToken))failure('invalid_binding',403)}
  const journal={mode:'supabase-service-journal',
    create:(userId,document)=>atomic(async()=>{if(stored.drafts.filter(row=>row.userId===userId&&row.status==='pending'&&Date.parse(row.expiresAt)>now()).length>=20)failure('draft_limit',429);const {id,...doc}=structuredClone(document),row={id,userId,revision:1,status:'pending',createdAt:new Date(now()).toISOString(),expiresAt:new Date(now()+900000).toISOString(),document:doc,confirmationToken:randomBytes(24).toString('hex')};stored.drafts.push(row);await persist();return structuredClone(row)}),
    get:async(userId,draftId)=>structuredClone(journalOwner(userId,draftId)),
    list:async(userId,limit=30)=>structuredClone(stored.drafts.filter(row=>row.userId===userId).slice(-limit).reverse()),
    replace:(userId,draftId,revision,confirmationToken,document)=>atomic(async()=>{const row=journalOwner(userId,draftId);bind(row,revision,confirmationToken);if(row.status!=='pending')failure('draft_unavailable',409);row.document=structuredClone(document);row.revision++;row.confirmationToken=randomBytes(24).toString('hex');await persist();return structuredClone(row)}),
    cancel:(userId,draftId,revision,confirmationToken)=>atomic(async()=>{const row=journalOwner(userId,draftId);bind(row,revision,confirmationToken);if(row.status!=='pending')failure('draft_unavailable',409);row.status='cancelled';await persist();return structuredClone(row)}),
    claim:(userId,draftId,revision,confirmationToken)=>atomic(async()=>{const row=journalOwner(userId,draftId);bind(row,revision,confirmationToken);if(row.status!=='pending')return{claimed:false,record:structuredClone(row)};if(Date.parse(row.expiresAt)<=now())failure('draft_expired',409);row.status='committing';row.claimToken=randomBytes(24).toString('hex');await persist();return{claimed:true,record:structuredClone(row),claimToken:row.claimToken}}),
    finish:(userId,draftId,claimToken,outcome,receipt)=>atomic(async()=>{const row=journalOwner(userId,draftId);if(row.status!=='committing'||!sameToken(claimToken,row.claimToken))failure('invalid_binding',403);row.status=outcome;if(receipt)row.receipt=structuredClone(receipt);delete row.claimToken;await persist();return structuredClone(row)}),
  }
  const writes=createCloudConfirmedAssistantWrites({verifySession,now,createCallerClient:session=>{const fixture=fixtures.get(session.userId);if(!fixture)failure('session_invalid',401);return fixture.client},journal})
  const catalog=async session=>{
    const teacher=session.userId===identities.teacher.id,representative=session.userId===identities.representative.id
    return{userId:session.userId,groups:[{id:GROUP,name:'ЕУБ-1 (демо)',program:'Економіка та управління бізнесом · вигадані дані',studyYear:1,learning:!teacher,permissions:representative?['schedule','homework','seminars']:[]},...(teacher?[{id:GROUP2,name:'ЕУБ-2 (демо)',program:'Економіка та управління бізнесом · вигадані дані',studyYear:1,learning:false,permissions:[]}]:[])],subjects:[{id:uid(201),groupId:GROUP,name:'Вища математика',kind:'study'},{id:uid(203),groupId:GROUP,name:'Вища математика',kind:'materials'},{id:uid(202),groupId:GROUP,name:'Економічна теорія',kind:'study'},...(teacher?[{id:uid(201),groupId:GROUP2,name:'Вища математика',kind:'study'}]:[])],courses:teacher?[{id:COURSE,name:'Вища математика · демо',groupIds:[GROUP,GROUP2],subjects:[{groupId:GROUP,subjectId:uid(201)},{groupId:GROUP2,subjectId:uid(201)}],permissions:['assignments','materials','grades','manage'],archived:false,teaching:true,teachingGroupIds:[GROUP,GROUP2]}]:[]}
  }
  const occurs=(row,day)=>{if(row.valid_from>day||row.valid_until<day||row.weekday!==(new Date(day+'T12:00:00Z').getUTCDay()||7)||row.excluded_dates?.includes(day))return false;if(!row.week_pattern||row.week_pattern==='every')return true;const week=Math.floor((Date.parse(day+'T12:00:00Z')-Date.parse(row.week_anchor_date+'T12:00:00Z'))/604800000);return (((week%2)+2)%2===0?'upper':'lower')===row.week_pattern}
  const read=async(credential,value)=>{
    const session=await owner(credential),access=await catalog(session),teacher=session.userId===identities.teacher.id,scope=value.scope??{},topic=value.topic
    const common=['organizer','community','news','opportunities','help'],allowed=[...common,...(teacher?['teaching','materials','gradebook']:['study','materials','results','seminars'])]
    if(!allowed.includes(topic)||scope.groupId&&!access.groups.some(g=>g.id===scope.groupId)||scope.courseId&&(!teacher||scope.courseId!==COURSE))failure('access_denied',403)
    const groupIds=scope.groupId?[scope.groupId]:access.groups.map(g=>g.id),from=scope.from??today(),to=scope.to??from
    if(Date.parse(to)-Date.parse(from)>31*86400000)failure('invalid_date_range')
    const subjectId=row=>row.subject==='Економічна теорія'?uid(202):uid(201)
    let records=[]
    if(['study','teaching'].includes(topic)){
      for(let day=from;day<=to;day=nextDay(day,1))for(const row of tables.study_group_schedule.filter(row=>groupIds.includes(row.group_id)&&occurs(row,day)&&(!teacher||row.subject==='Вища математика')&&(!scope.subjectId||subjectId(row)===scope.subjectId))){const hex=createHash('sha256').update(row.id+':'+day).digest('hex'),occurrenceId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;records.push({id:occurrenceId,scheduleId:row.id,kind:'lesson',groupId:row.group_id,subjectId:subjectId(row),title:row.subject,date:day,startsAt:row.starts_at.slice(0,5),endsAt:row.ends_at.slice(0,5),location:row.location,links:[row.online_url,row.online_url_secondary].filter(Boolean),conferenceId:row.conference_id,accessCode:row.conference_access_code,...(teacher?{courseId:COURSE}:{})})}
      if(!teacher)for(const row of tables.study_group_homework.filter(row=>groupIds.includes(row.group_id)&&row.lesson_date>=from&&row.lesson_date<=to)){const lesson=tables.study_group_schedule.find(lesson=>lesson.id===row.schedule_item_id);if(!lesson||!occurs(lesson,row.lesson_date)||scope.subjectId&&subjectId(lesson)!==scope.subjectId)continue;records.push({id:row.id,lessonId:row.schedule_item_id,kind:'homework',groupId:row.group_id,subjectId:subjectId(lesson),title:row.lesson_topic||'Домашнє завдання',body:row.body,date:row.lesson_date,dueAt:row.due_at??null})}
    }else if(topic==='materials'){for(const row of master.state.materials.filter(row=>(!scope.subjectId||scope.subjectId===uid(203))&&(teacher||row.targets?.some(target=>groupIds.includes(target.group_id))))){const permission=(await fixtures.get(session.userId).client.rpc('xelay_assistant_material_ai',{p_kind:'teaching',p_material_id:row.id})).data;records.push({id:row.id,kind:'material',groupId:row.targets?.find(target=>groupIds.includes(target.group_id))?.group_id??GROUP,subjectId:uid(203),title:row.title,body:row.body??'',allowAi:permission?.allowAi===true,allowDownload:row.allow_download!==false,fileName:row.attachments?.[0]?.name??'Текстовий матеріал'})}}
    else if(['results','gradebook'].includes(topic))records=tables.teaching_grades.filter(row=>teacher||master.state.entry.user_id===session.userId&&row.published_at).map(row=>({id:row.id,kind:'grade',groupId:GROUP,subjectId:uid(201),courseId:COURSE,title:master.state.activity.title,points:teacher?row.draft_score??row.published_score:row.published_score,maxPoints:master.state.activity.max_points,coefficient:tables.teaching_course_groups[0]?.grading_rules_override?.categories?.[0]?.coefficient??master.state.course.grading_rules.categories[0].coefficient,date:master.state.activity.activity_date,...(teacher?{studentName:master.state.entry.full_name}:{})}))
    else if(topic==='seminars')records=tables.study_group_seminars.filter(row=>groupIds.includes(row.group_id)).map(row=>({id:row.id,kind:'seminar',groupId:row.group_id,subjectId:row.subject_id,title:row.title,body:row.instructions,date:row.lesson_date,sourcePath:`/groups/${row.group_id}?tab=seminars`,status:row.selection_deadline_at>new Date(now()).toISOString()?'open':'closed'}))
    else if(topic==='organizer')records=tables.organizer_tasks.filter(row=>row.user_id===session.userId).map(row=>({id:row.id,kind:'task',title:row.title,body:row.notes,sourcePath:'/organizer',...(row.due_at?{dueAt:row.due_at}:{}),...(row.due_date?{date:row.due_date}:{}),status:row.completed?'completed':'pending'}))
    else if(topic==='community')records=[{id:uid(951),kind:'question',title:'Як готуватися до першої сесії?',body:'Вигаданий приклад запитання спільноти.',sourcePath:'/community',date:today()}]
    else if(topic==='news')records=[{id:uid(952),kind:'news',title:'Xelay 2.0: усе потрібне на головній',body:'Вигаданий приклад новини платформи.',sourcePath:'/news',date:today()}]
    else if(topic==='opportunities')records=[{id:uid(953),kind:'opportunity',title:'Демонстраційна студентська можливість',body:'Приклад картки; це не справжній набір або пропозиція роботи.',sourcePath:'/opportunities',date:today()}]
    else if(topic==='help')records=[{id:uid(954),kind:'help',title:'Як користуватися Xelay',body:'Оберіть потрібний блок у мануалі. Усі матеріали цього перегляду є вигаданими.',sourcePath:'/guides/'}]
    for(const record of records){
      record.groupId??='';record.subjectId??=''
      if(record.kind==='lesson'){const lesson=tables.study_group_schedule.find(row=>row.id===record.scheduleId);record.teacherName=lesson?.teacher_name??'';record.sourcePath=teacher?'/teaching':`/groups/${record.groupId}?tab=schedule&date=${record.date}`;record.subjectName=record.title}
      if(record.kind==='homework'){record.sourcePath=`/groups/${record.groupId}?tab=schedule&date=${record.date}`;record.published=true}
      if(record.kind==='material'){const permission=(await fixtures.get(session.userId).client.rpc('xelay_assistant_material_ai',{p_kind:'teaching',p_material_id:record.id})).data;record.materialId=record.id;record.materialSourceKind='teaching';record.rightsVersion=permission?.rightsVersion;record.sourcePath=teacher?'/teaching':`/groups/${record.groupId}?tab=materials`;record.published=true}
      if(record.kind==='grade'){record.sourcePath=teacher?'/teaching':`/groups/${GROUP}?tab=schedule&grades=own&gradeCourse=${COURSE}&date=${record.date || today()}`;record.subjectName=master.state.course.title;record.studentId=identities.student.id;record.activityId=ACTIVITY;record.category=master.state.activity.category;record.gradingRules=tables.teaching_course_groups[0]?.grading_rules_override??master.state.course.grading_rules;record.published=teacher?false:true}
      if(record.kind==='seminar'){
        const seminar=tables.study_group_seminars.find(row=>row.id===record.id),reservations=tables.study_group_seminar_reservations.filter(row=>row.seminar_id===record.id),mine=reservations.find(row=>row.user_id===session.userId)
        record.format=seminar.format;record.startsAt=seminar.starts_at;record.endsAt=seminar.ends_at;record.selectionVersion=seminar.selection_version;record.selectionDeadlineAt=seminar.selection_deadline_at;record.canEdit=session.userId===identities.representative.id;record.canReopen=record.canEdit&&Date.parse(seminar.selection_deadline_at)<=now()
        record.questions=tables.study_group_seminar_questions.filter(row=>row.seminar_id===record.id).map(row=>({id:row.id,body:row.body,position:row.position,primaryCapacity:row.primary_capacity,supplementCapacity:row.supplement_capacity??0,occupiedPrimary:reservations.filter(r=>r.question_id===row.id&&['primary','booking'].includes(r.role)).length,occupiedSupplement:reservations.filter(r=>r.question_id===row.id&&r.role==='supplement').length}))
        record.teams=tables.study_group_seminar_teams.filter(row=>row.seminar_id===record.id).map(row=>({id:row.id,name:row.name,capacity:row.capacity,occupied:reservations.filter(r=>r.team_id===row.id).length}))
        if(mine)record.myReservation={id:mine.id,role:mine.role,...(mine.question_id?{questionId:mine.question_id}:{}),...(mine.team_id?{teamId:mine.team_id}:{})}
      }
      if(record.kind==='task'){const task=tables.organizer_tasks.find(row=>row.id===record.id);record.completed=task.completed;record.space='personal';record.canEdit=true}
    }
    const limit=Math.min(100,Math.max(1,value.limit??30)),truncated=records.length>limit,visible=records.slice(0,limit)
    let gradeSummary
    if(topic==='results'){
      const grades=visible.filter(row=>row.kind==='grade'),rules=tables.teaching_course_groups[0]?.grading_rules_override??master.state.course.grading_rules,b=calculateTeachingBreakdown(rules,grades.map(row=>({category:row.category??'',score:row.points}))),max=Number.isFinite(b.maximum)?b.maximum:null
      gradeSummary=grades.length?[{groupId:GROUP,subjectId:uid(201),courseId:COURSE,title:master.state.course.title,workCount:grades.length,points:b.rawTotal,maxPoints:grades.reduce((sum,row)=>sum+row.maxPoints,0),weightedPoints:b.total,weightedMaxPoints:max,percentage:max?Math.round(b.total/max*10000)/100:null,formula:'Сума балів категорії × коефіцієнт → максимум категорії → округлення → загальний максимум',partial:truncated,categories:b.categories.map(row=>({...row,maximum:Number.isFinite(row.maximum)?row.maximum:1000000})),rounding:b.rounding}]:[]
    }
    return{userId:session.userId,audience:teacher?'teacher':'student',records:structuredClone(visible),truncated,readAt:new Date(now()).toISOString(),...(gradeSummary?{gradeSummary}:{})}
  }
  const materialContent=async(credential,value)=>{
    const session=await owner(credential),access=await catalog(session),row=master.state.materials.find(row=>row.id===value.materialId),scope=value.scope??{}
    if(!row||scope.groupId&&!access.groups.some(g=>g.id===scope.groupId)||scope.courseId&&scope.courseId!==COURSE||!access.groups.some(g=>row.targets?.some(target=>target.group_id===g.id))&&session.userId!==row.created_by)failure('access_denied',403)
    const permission=(await fixtures.get(session.userId).client.rpc('xelay_assistant_material_ai',{p_kind:'teaching',p_material_id:row.id})).data
    if(permission?.allowAi!==true)failure('material_ai_not_allowed',403)
    return{userId:session.userId,allowAi:true,title:row.title,text:row.body??'',rightsVersion:permission.rightsVersion,truncated:false,sources:[{title:row.title,path:'/teaching',version:String(row.version)}]}
  }
  const tools=createAssistantCloudTools({verifySession,catalog,read,prepare:writes.prepare.bind(writes),model:async(...args)=>{if(!taskModel)failure('model_not_connected',409);return taskModel(...args)},materialContent,assertMaterialRights:async(credential,value)=>materialContent(credential,value),now})
  const chat=planner?createAuthenticatedAssistantChat({verifySession,catalog,read,writes,planner,continuationSecret:randomBytes(32).toString('hex'),now}):undefined
  const uploadFixture=async(req,res,url,origin)=>{
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}
    const reply=(status,value)=>{res.writeHead(status,headers);res.end(JSON.stringify(value))}
    let bytes
    try{
      if(req.method!=='POST'||req.headers.origin!==origin||req.headers['content-encoding'])return reply(403,{error:'Локальний файл можна додати тільки з цієї тестової сторінки.'})
      const credential=typeof req.headers.authorization==='string'?req.headers.authorization.match(/^Bearer (\S+)$/)?.[1]:null,session=await owner(credential)
      const name=url.searchParams.get('name'),courseId=url.searchParams.get('courseId')
      if(session.userId!==identities.teacher.id||courseId!==COURSE||!name||!/^[^/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,240}$/.test(name))return reply(403,{error:'Оберіть свій демонстраційний предмет та звичайну назву файлу.'})
      const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length<1||length>MAX_VALIDATED_UPLOAD_BYTES)return reply(413,{error:'Для локального перегляду додайте файл до 50 МБ.'})
      const chunks=[];let total=0
      for await(const chunk of req){total+=chunk.length;if(total>MAX_VALIDATED_UPLOAD_BYTES)throw Error('too_large');chunks.push(chunk)}
      bytes=Buffer.concat(chunks);if(bytes.length!==length)return reply(422,{error:'Не вдалося отримати повний файл.'})
      const extension=name.split('.').pop().toLowerCase(),checked=await validateUploadContent(bytes,extension,req.headers['content-type']??'')
      const storage_path=`${COURSE}/${session.userId}/${randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5')}.${extension}`
      fixtures.get(session.userId).state.verifiedFiles.add(storage_path)
      return reply(200,{syntheticOnly:true,contentChecked:true,file:{storage_path,name,mime_type:checked.mime,size:checked.size}})
    }catch(error){return reply(422,{error:typeof error?.code==='string'&&error.code.startsWith('UPLOAD_')?error.message:'Файл не пройшов локальну перевірку. Робоче сховище не використовується.'})}
    finally{bytes?.fill(0)}
  }
  return{ports:{verifySession,catalog,read,writes,tools,...(chat?{chat:(credential,value,signal)=>chat.chat(credential,value,signal)}:{})},fixtures,ids,stored,persist,materialContent,uploadFixture}
}
