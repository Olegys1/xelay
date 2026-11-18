import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { opportunitiesFixture } from './helpers/opportunitiesFixture.mjs'

test('organization verification, school courses, applications and private conversations in PostgreSQL', {timeout:120000}, async t=>{
  const fx=await opportunitiesFixture();t.after(()=>fx.close());const {db,ids,rpc,load,asUser}=fx
  let company=fx.organization(),schoolId,itemId,applicationId
  const evidenceId=randomUUID(),evidence={id:evidenceId,ownerId:ids.company,path:`${ids.company}/company/${evidenceId}.pdf`,kind:'company',name:'synthetic-evidence.pdf',mime:'application/pdf',size:256}
  await db.query('insert into opportunities_files(id,owner_id,path,kind,data)values($1,$2,$3,$4,$5)',[evidenceId,ids.company,evidence.path,evidence.kind,JSON.stringify(evidence)])
  company.verificationFile=evidence
  await t.test('table RLS and grants deny direct reads and forged verification',async()=>{
    for(const table of ['opportunities_companies','opportunities_business_accounts','opportunities_applications','opportunities_resumes']){
      assert.equal((await db.query("select relrowsecurity from pg_class where oid=$1::regclass",[table])).rows[0].relrowsecurity,true)
      await assert.rejects(asUser(ids.student,'select * from '+table),e=>e.code==='42501')
    }
    const saved=await rpc(ids.company,{type:'company.save',company});company=saved.companies.find(c=>c.id===company.id)
    assert.equal(company.status,'draft');assert.equal(company.partner,false)
    for(const user of [ids.student,ids.stranger,ids.school])assert.equal((await asUser(user,'select xelay_opportunities_can_read_file($1) allowed',[evidence.path])).rows[0].allowed,false)
    for(const user of [ids.company,ids.admin])assert.equal((await asUser(user,'select xelay_opportunities_can_read_file($1) allowed',[evidence.path])).rows[0].allowed,true)
    assert.equal((await asUser(ids.company,'select xelay_opportunities_file_unreferenced($1) allowed',[evidence.path])).rows[0].allowed,false)
    await assert.rejects(rpc(ids.student,{type:'company.save',company:{...fx.organization(),ownerId:ids.student}}),/FORBIDDEN/)
    await assert.rejects(rpc(ids.school,{type:'company.save',company:{...fx.organization(),ownerId:ids.school}}),/FORBIDDEN/)
    assert.equal((await load(ids.student)).companies.some(c=>c.id===company.id),false)
    await assert.rejects(rpc(ids.company,{type:'company.review',id:company.id,expectedRevision:company.revision,status:'approved',note:''}),/FORBIDDEN/)
    const draft=fx.offer(company.id)
    await rpc(ids.company,{type:'opportunity.save',opportunity:draft})
    await assert.rejects(rpc(ids.company,{type:'opportunity.submit',id:draft.id}),/VERIFICATION_REQUIRED/)
  })
  await t.test('representative evidence is required and only moderator can approve current revision',async()=>{
    const stale={...company};const saved=await rpc(ids.company,{type:'company.save',company:{...company,verificationNote:''}});company=saved.companies.find(c=>c.id===company.id)
    await assert.rejects(rpc(ids.company,{type:'company.submit',id:company.id}),/INVALID_INPUT/)
    await assert.rejects(rpc(ids.company,{type:'company.save',company:stale}),/STALE/)
    let state=await rpc(ids.company,{type:'company.save',company:{...company,verificationNote:'Synthetic authorized representative.'}});company=state.companies.find(c=>c.id===company.id)
    state=await rpc(ids.company,{type:'company.submit',id:company.id});company=state.companies.find(c=>c.id===company.id)
    await assert.rejects(rpc(ids.company,{type:'company.save',company}),/INVALID_INPUT/)
    await assert.rejects(rpc(ids.admin,{type:'company.review',id:company.id,expectedRevision:company.revision-1,status:'approved',note:''}),/STALE/)
    await rpc(ids.admin,{type:'company.review',id:company.id,expectedRevision:company.revision,status:'approved',note:'Checked'})
    const publicCompany=(await load(ids.student)).companies.find(c=>c.id===company.id)
    for(const key of ['legalName','registrationCode','contactEmail','verificationNote'])assert.equal(publicCompany[key],'')
    assert.equal(publicCompany.verificationFile,null)
  })
  await t.test('school has a separate workspace and cannot enumerate employer resumes',async()=>{
    schoolId=await fx.approveOrganization('school')
    assert.equal((await load(ids.school)).actor.role,'school')
    await assert.rejects(rpc(ids.school,{type:'opportunity.save',opportunity:fx.offer(schoolId,'job')}),/INVALID_INPUT/)
    await assert.rejects(rpc(ids.company,{type:'opportunity.save',opportunity:fx.offer(company.id,'course')}),/INVALID_INPUT/)
    const resume={id:randomUUID(),ownerId:ids.student,fullName:'Synthetic student',headline:'Private learning profile',about:'PRIVATE_ABOUT',education:'PRIVATE_EDUCATION',skills:['SQL'],languages:'English',experience:'PRIVATE_EXPERIENCE',projects:'PRIVATE_PROJECT',city:'Kyiv',format:'remote',availability:'Weekends',salary:'Negotiable',portfolioUrl:'',contact:'PRIVATE_CONTACT',seeking:['job'],visibility:'employers',file:null,version:1,updatedAt:new Date().toISOString()}
    await rpc(ids.student,{type:'resume.save',resume})
    assert.equal((await load(ids.school)).candidateResumes.length,0)
    assert.equal((await load(ids.company)).candidateResumes.length,1)
    const draft=fx.offer(schoolId,'course');itemId=draft.id
    await rpc(ids.school,{type:'opportunity.save',opportunity:{...draft,syllabus:''}})
    await assert.rejects(rpc(ids.school,{type:'opportunity.submit',id:itemId}),/INVALID_INPUT/)
    const fresh=(await load(ids.school)).opportunities.find(o=>o.id===itemId)
    await fx.publish(ids.school,{...fresh,syllabus:'Topic 1\nTopic 2'})
    const item=(await load(ids.student)).opportunities.find(o=>o.id===itemId)
    assert.equal(item.syllabus,'Topic 1\nTopic 2');assert.equal(item.instructors,'Synthetic instructor')
  })
  await t.test('course application sends only chosen contact, name and message; reload and idempotency',async()=>{
    const apply={type:'application.submit',opportunityId:itemId,message:'Please tell me about the course',contact:'chosen@example.test',consent:true}
    await assert.rejects(rpc(ids.student,{...apply,consent:false}),/CONSENT_REQUIRED/)
    const result=await rpc(ids.student,apply);applicationId=result.applications[0].id
    await assert.rejects(rpc(ids.student,apply),/ALREADY_APPLIED/)
    const saved=(await load(ids.school)).applications[0]
    assert.equal(saved.resumeShared,false);assert.equal(saved.contact,apply.contact)
    assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_/)
    const withoutResume=await rpc(ids.stranger,apply)
    assert.equal(withoutResume.applications.length,1,'School application does not require a CV')
    assert.equal((await load(ids.company)).applications.length,0)
    assert.equal((await load(ids.admin)).applications.length,0)
  })
  await t.test('only applicant and organization may message or change stages; history survives withdrawal',async()=>{
    for(const user of [ids.company,ids.admin,ids.stranger])await assert.rejects(rpc(user,{type:'application.message',id:applicationId,body:'Forged'}),/FORBIDDEN/)
    await rpc(ids.school,{type:'application.message',id:applicationId,body:'The course begins next Monday.'})
    await rpc(ids.student,{type:'application.message',id:applicationId,body:'Thank you, I will join.'})
    await rpc(ids.school,{type:'application.status',id:applicationId,status:'invited'})
    assert.equal((await load(ids.student)).applications[0].messages.length,2)
    await rpc(ids.student,{type:'application.status',id:applicationId,status:'withdrawn'})
    const saved=(await load(ids.school)).applications.find(a=>a.id===applicationId)
    assert.equal(saved.messages.length,2);assert.equal(saved.contact,'');assert.equal(saved.resumeSnapshot.contact,'')
    await assert.rejects(rpc(ids.school,{type:'application.message',id:applicationId,body:'Too late'}),/CLOSED/)
    await assert.rejects(rpc(ids.school,{type:'application.status',id:applicationId,status:'invited'}),/INVALID_INPUT/)
  })
  await t.test('company cannot steal another listing; stale edits fail and closing preserves applications',async()=>{
    const item=(await load(ids.school)).opportunities.find(o=>o.id===itemId)
    await assert.rejects(rpc(ids.company,{type:'opportunity.save',opportunity:{...item,companyId:company.id,kind:'job'}}),/FORBIDDEN/)
    await assert.rejects(rpc(ids.school,{type:'opportunity.save',opportunity:{...item,revision:item.revision-1}}),/STALE/)
    await rpc(ids.school,{type:'opportunity.review',id:itemId,expectedRevision:item.revision,status:'closed',note:''})
    assert.equal((await load(ids.school)).applications.length,2)
    await assert.rejects(rpc(ids.editor,{type:'application.submit',opportunityId:itemId,message:'Late',contact:'late@example.test',consent:true}),/NOT_FOUND|CLOSED/)
  })
  await t.test('school signup is still gated and creates no student profile or approval',async()=>{
    const id=randomUUID(),meta={registration_kind:'company',organization_kind:'school',xelay_registration_version:'company-1',full_name:'Synthetic Representative',company_name:'Synthetic School',company_terms_version:'opportunities-v1'}
    await db.exec(`update opportunities_settings set data=data||'{"enabled":false}'`)
    await assert.rejects(db.query('insert into auth.users(id,email,raw_user_meta_data)values($1,$2,$3)',[id,'new@example.test',JSON.stringify(meta)]),/DEVELOPMENT/)
    await db.exec(`update opportunities_settings set data=data||'{"enabled":true}'`)
    await db.query('insert into auth.users(id,email,raw_user_meta_data)values($1,$2,$3)',[id,'new@example.test',JSON.stringify(meta)])
    assert.equal((await load(id)).actor.role,'school')
    assert.equal((await db.query('select count(*)::int n from profiles where id=$1',[id])).rows[0].n,0)
    assert.equal((await db.query("select count(*)::int n from opportunities_companies where owner_id=$1 and status='approved'",[id])).rows[0].n,0)
    await db.query("update auth.users set raw_user_meta_data=raw_user_meta_data||'{\"role\":\"ADMIN\",\"verified\":true}' where id=$1",[id])
    assert.equal((await load(id)).actor.role,'school')
  })
})
