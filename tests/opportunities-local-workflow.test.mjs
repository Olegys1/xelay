import test from 'node:test'
import assert from 'node:assert/strict'
import { teacherModuleLoader } from './helpers/loadTeacherModule.mjs'

test('local organization preview follows the same moderation and consent lifecycle', async t => {
  const entries=new Map(), localStorage={getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,String(v)),removeItem:k=>entries.delete(k)}
  const load=teacherModuleLoader({localStorage,crypto:globalThis.crypto})
  const {createLocalOpportunitiesRepository:repo}=load('src/lib/opportunities/localRepository.ts')
  const {newOrganization,newOrganizationOffer}=load('src/lib/opportunities/organizations.ts')
  const school=repo('school',false,true), admin=repo('admin'),student=repo('student'),company=repo('company')
  const identity=(await school.load()).actor
  let org=newOrganization(identity.id,'school',{name:'Школа тестування',contactName:'Тестовий представник',contactEmail:'school@example.test',description:'Навчаємо працювати з даними та будувати звіти.',website:'https://example.test',legalName:'Тестова організація',registrationCode:'12345678',verificationNote:'Тестове підтвердження представника школи.'})
  await t.test('draft persists across reload but is hidden from students',async()=>{
    const saved=await school.execute({type:'company.save',company:org});org=saved.companies.find(c=>c.id===org.id)
    assert.equal((await repo('school',false,true).load()).companies.find(c=>c.id===org.id).name,org.name)
    assert.equal((await student.load()).companies.some(c=>c.id===org.id),false)
    await assert.rejects(school.execute({type:'company.review',id:org.id,expectedRevision:org.revision,status:'approved',note:''}),/адміністратору/)
  })
  await t.test('moderator accepts current application; private evidence is not public',async()=>{
    const pending=await school.execute({type:'company.submit',id:org.id});org=pending.companies.find(c=>c.id===org.id)
    await assert.rejects(school.execute({type:'company.save',company:org}),/перевірки/)
    await admin.execute({type:'company.review',id:org.id,expectedRevision:org.revision,status:'approved',note:''})
    org=(await school.load()).companies.find(c=>c.id===org.id)
    assert.equal(org.status,'approved')
    const publicOrg=(await student.load()).companies.find(c=>c.id===org.id)
    assert.equal(publicOrg.verificationNote,'');assert.equal(publicOrg.registrationCode,'')
    assert.equal((await school.load()).candidateResumes.length,0)
  })
  let course=newOrganizationOffer(org),applicationId
  course={...course,title:'Аналітика для початківців',summary:'Навчання на практичних прикладах.',description:'Практика з таблицями, аналіз даних та фінальний звіт.',compensation:'Безкоштовно',employment:'4 тижні',syllabus:'Таблиці, діаграми, звіти',instructors:'Тестовий викладач',schedule:'Вівторок, 18:00'}
  await t.test('course approval is required, stale and pending edits are denied',async()=>{
    let saved=await school.execute({type:'opportunity.save',opportunity:course});course=saved.opportunities.find(o=>o.id===course.id)
    assert.equal((await student.load()).opportunities.some(o=>o.id===course.id),false)
    const pending=await school.execute({type:'opportunity.submit',id:course.id});const latest=pending.opportunities.find(o=>o.id===course.id)
    await assert.rejects(school.execute({type:'opportunity.save',opportunity:course}),/змінився/)
    await assert.rejects(school.execute({type:'opportunity.save',opportunity:latest}),/перевірку/)
    await admin.execute({type:'opportunity.review',id:course.id,expectedRevision:latest.revision,status:'approved',note:''})
    course=(await student.load()).opportunities.find(o=>o.id===course.id);assert.equal(course.syllabus,'Таблиці, діаграми, звіти')
  })
  await t.test('course inquiry omits CV and requires explicit consent; duplicate is denied',async()=>{
    const command={type:'application.submit',opportunityId:course.id,contact:'student@example.test',message:'Підкажіть про програму',consent:true}
    await assert.rejects(student.execute({...command,consent:false}),/Підтвердь/)
    const saved=await student.execute(command);const app=saved.applications.find(a=>a.opportunityId===course.id);applicationId=app.id
    assert.equal(app.resumeShared,false);assert.equal(app.resumeSnapshot.education,'');assert.equal(app.resumeSnapshot.file,null)
    await assert.rejects(student.execute(command),/уже існує/)
    assert.equal((await admin.load()).applications.length,0)
  })
  await t.test('messages survive reload and are private to both participants',async()=>{
    await school.execute({type:'application.message',id:applicationId,body:'Вітаємо! Починаємо у вівторок.'})
    await student.execute({type:'application.message',id:applicationId,body:'Дякую, буду!'})
    const loaded=(await repo('school',false,true).load()).applications.find(a=>a.id===applicationId)
    assert.equal(loaded.messages.length,2)
    await assert.rejects(company.execute({type:'application.message',id:applicationId,body:'Чужий текст'}),/доступу/)
    await assert.rejects(admin.execute({type:'application.message',id:applicationId,body:'Чужий текст'}),/доступу/)
  })
  await t.test('withdrawal and closing preserve history while stopping new activity',async()=>{
    await student.execute({type:'application.status',id:applicationId,status:'withdrawn'})
    const app=(await school.load()).applications.find(a=>a.id===applicationId);assert.equal(app.messages.length,2);assert.equal(app.contact,'')
    await assert.rejects(school.execute({type:'application.message',id:applicationId,body:'Після завершення'}),/завершено/)
    const current=(await school.load()).opportunities.find(o=>o.id===course.id)
    await school.execute({type:'opportunity.review',id:course.id,expectedRevision:current.revision,status:'closed',note:''})
    assert.equal((await student.load()).opportunities.find(o=>o.id===course.id).title,course.title)
  })
})
