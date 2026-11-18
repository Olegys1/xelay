import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { opportunitiesFixture } from './helpers/opportunitiesFixture.mjs'
import { createAccountBootstrapReader } from '../src/lib/authAccountBootstrap.ts'
import { emptyResume } from '../src/lib/opportunities/types.ts'
import { createAuthReadScope } from '../src/lib/authBootstrap.ts'

test('production business registration has a separate canonical identity without student or admin grants', {timeout:120000}, async t => {
  const fx = await opportunitiesFixture({ release: true }); t.after(() => fx.close())
  const { db, ids, asUser, rpc, load } = fx
  for (const kind of ['company', 'school']) await t.test(kind + ' signup, confirmation and repeat login', async () => {
    const id = randomUUID()
    await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,null,$3)', [id,kind+'-signup@example.test',JSON.stringify({xelay_registration_version:'company-1',registration_kind:'company',organization_kind:kind,full_name:'Synthetic Representative',company_name:'Synthetic '+kind,company_terms_version:'opportunities-v1',role:'ADMIN',verified:true})])
    assert.equal((await asUser(id,'select xelay_my_business_identity() data')).rows[0].data,null)
    await assert.rejects(asUser(id,'select xelay_google_registration_status()'),/AUTH_REQUIRED/)
    await assert.rejects(load(id),/AUTH_REQUIRED/)
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[id])
    assert.equal((await asUser(id,'select xelay_google_registration_status() data')).rows[0].data.required,false)
    for (let attempt=0; attempt<2; attempt++) {
      const bootstrap=(await asUser(id,'select xelay_my_account_bootstrap() data')).rows[0].data
      assert.equal(bootstrap.business.userId,id); assert.equal(bootstrap.business.kind,kind)
      assert.equal(bootstrap.profile.data,null); assert.equal(bootstrap.roles,undefined)
      assert.equal((await load(id)).actor.role,kind)
    }
    await db.query("update auth.users set raw_user_meta_data=raw_user_meta_data||'{\"organization_kind\":\"company\",\"role\":\"ADMIN\"}' where id=$1",[id])
    assert.equal((await asUser(id,'select xelay_my_business_identity() data')).rows[0].data.kind,kind)
    await assert.rejects(rpc(id,{type:'settings.save',settings:{enabled:true}}),/FORBIDDEN/)
    await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[id])
    assert.equal((await asUser(id,'select xelay_my_business_identity() data')).rows[0].data,null)
    await assert.rejects(asUser(id,'select xelay_google_registration_status()'),/AUTH_REQUIRED/)
  })
  await t.test('moderation fails closed without both a verified second factor and an aal2 session',async()=>{
    assert.equal((await asUser(ids.admin,'select xelay_opportunities_is_admin() allowed',[],'authenticated','aal1')).rows[0].allowed,false)
    await assert.rejects(asUser(ids.admin,'select xelay_opportunities_command($1::jsonb)',[JSON.stringify({type:'settings.save',settings:{enabled:true}})],'authenticated','aal1'),/FORBIDDEN/)
    await db.query('delete from auth.mfa_factors where user_id=$1',[ids.admin])
    assert.equal((await asUser(ids.admin,'select xelay_opportunities_is_admin() allowed')).rows[0].allowed,false)
    await db.query("insert into auth.mfa_factors values($1,'verified')",[ids.admin])
    assert.equal((await asUser(ids.admin,'select xelay_opportunities_is_admin() allowed')).rows[0].allowed,true)
  })
  await t.test('student profile and incomplete Google registration keep their existing gates',async()=>{
    await db.query('insert into profiles(id,full_name)values($1,$2)',[ids.student,'Synthetic Student'])
    assert.equal((await asUser(ids.student,'select xelay_google_registration_status() data')).rows[0].data.required,false)
    const student=(await asUser(ids.student,'select xelay_my_account_bootstrap() data')).rows[0].data
    assert.equal(student.profile.data.id,ids.student); assert.equal(student.business,undefined)
    await db.query("update auth.users set raw_user_meta_data='{\"xelay_registration_version\":\"company-1\",\"organization_kind\":\"school\"}' where id=$1",[ids.stranger])
    assert.equal((await asUser(ids.stranger,'select xelay_my_business_identity() data')).rows[0].data,null)
    await assert.rejects(asUser(ids.stranger,'select xelay_google_registration_status()'),/REGISTRATION_UNAVAILABLE/)
    await db.query('insert into xelay_google_registrations(user_id)values($1)',[ids.stranger])
    await db.query("insert into auth.identities values($1,'google','{\"email_verified\":true}')",[ids.stranger])
    assert.equal((await asUser(ids.stranger,'select xelay_google_registration_status() data')).rows[0].data.required,true)
    await assert.rejects(asUser(null,'select xelay_my_business_identity()',[],'anon'),e=>e.code==='42501')
    assert.equal((await db.query("select prosecdef from pg_proc where oid='xelay_my_account_bootstrap()'::regprocedure")).rows[0].prosecdef,false)
  })
  await t.test('conversation refresh exposes only one permitted application, including withdrawal redaction',async()=>{
    const company=await fx.approveOrganization('company'), item=fx.offer(company)
    await fx.publish(ids.company,item)
    await rpc(ids.student,{type:'resume.save',resume:{...emptyResume({id:ids.student,name:'Synthetic Student',role:'student',companyIds:[],premium:false}),seeking:['job'],headline:'Testing',about:'Testing private application',education:'Synthetic University',city:'Kyiv',skills:['Testing'],experience:'',projects:'',links:[],contact:'synthetic@example.test',visibility:'private',file:null}})
    const applied=await rpc(ids.student,{type:'application.submit',opportunityId:item.id,message:'Synthetic application',contact:'synthetic@example.test',consent:true})
    const app=applied.applications[0]; assert.ok(app)
    await rpc(ids.company,{type:'application.message',id:app.id,body:'Synthetic company reply'})
    for(const user of [ids.student,ids.company]){
      const refreshed=(await asUser(user,'select xelay_opportunities_conversation($1) data',[app.id])).rows[0].data
      assert.equal(refreshed.id,app.id); assert.equal(refreshed.messages.at(-1).body,'Synthetic company reply')
    }
    for(const user of [ids.school,ids.stranger,ids.admin]) assert.equal((await asUser(user,'select xelay_opportunities_conversation($1) data',[app.id])).rows[0].data,null)
    await rpc(ids.student,{type:'application.status',id:app.id,status:'withdrawn'})
    const redacted=(await asUser(ids.company,'select xelay_opportunities_conversation($1) data',[app.id])).rows[0].data
    assert.equal(redacted.contact,'');assert.equal(redacted.resumeSnapshot.contact,'');assert.equal(redacted.resumeSnapshot.file,null)
    await assert.rejects(rpc(ids.company,{type:'application.message',id:app.id,body:'Too late'}),/CLOSED/)
  })
})

test('account response parser rejects a foreign or invented business identity and grants no student roles',async()=>{
  const scope=createAuthReadScope(); const id=randomUUID()
  try {
    for(const business of [{userId:randomUUID(),kind:'company',name:'Other'}, {userId:id,kind:'admin',name:'Forged'}, {userId:id,kind:'school',name:42}]){
      const read=createAccountBootstrapReader({rpc(){return {abortSignal:async()=>({data:{profile:{data:null,error:null,status:200},business},error:null,status:200})}}})
      await assert.rejects(read(id,scope),/unavailable/)
    }
    const read=createAccountBootstrapReader({rpc(){return {abortSignal:async()=>({data:{profile:{data:null,error:null,status:200},business:{userId:id,kind:'school',name:'Synthetic'}},error:null,status:200})}}})
    const result=await read(id,scope); assert.equal(result.business.kind,'school');assert.equal(result.roles.data,null)
  } finally { scope.dispose() }
})
