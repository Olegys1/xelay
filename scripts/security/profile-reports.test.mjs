// Full current SQL chain + synthetic profiles only. No provider/network calls.
// PGlite serializes local statements; concurrent promises exercise idempotency
// and version checks, with production locks/unique constraints asserted too.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import {createFixture} from './fixture.mjs'

const root=new URL('../../',import.meta.url)
const migration=await readFile(new URL('supabase/migrations/202610160007_profile_reports.sql',root),'utf8')
const audit=await readFile(new URL('supabase/audits/202610160007_profile_reports.sql',root),'utf8')
const first=result=>result.rows[0]
const reasons=['harassment','hate','impersonation','inappropriate','spam','privacy','other']
const denied=promise=>assert.rejects(promise,error=>error.code==='42501')

test('private profile reports have isolated submissions, MFA administration and guarded status clearing',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160006',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `})
  t.after(()=>fx.close())
  const {db,asUser,seedUser}=fx
  const ids=Object.fromEntries(['reporter','otherReporter','target','freeTarget','expiredTarget','admin','otherAdmin','noFactorAdmin','factorOnly'].map(key=>[key,randomUUID()]))
  const seed=async(id)=>seedUser(id,{username:'report_'+id.replaceAll('-','').slice(0,16),bio:'Public synthetic profile',categories:['General']})
  for(const id of Object.values(ids))await seed(id)
  const newUser=async()=>{const id=randomUUID();await seed(id);return id}
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN'),($3,'ADMIN')",[ids.admin,ids.otherAdmin,ids.noFactorAdmin])
  for(const id of [ids.admin,ids.otherAdmin,ids.factorOnly])await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[id])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'unverified')",[ids.noFactorAdmin])
  await db.query(`insert into participant_entitlements(user_id,source,valid_from,valid_until)
    values($1,'admin_grant',now()-interval '1 day',now()+interval '1 day'),
    ($2,'admin_grant',now()-interval '2 days',now()-interval '1 day')`,[ids.target,ids.expiredTarget])
  const setStatus=(text='Original status',emoji='sticker:penguin')=>asUser(ids.target,'select xelay_set_participant_status($1,$2)',[text,emoji])
  await setStatus()
  await db.query("insert into premium_preferences(user_id,status_text,emoji_status) values($1,'Private expired preference','sticker:frog'),($2,'Private free preference','😊')",[ids.expiredTarget,ids.freeTarget])
  await asUser(ids.target,"select xelay_set_participant_appearance('ocean','rose','dots')")
  const submit=(actor=ids.reporter,target=ids.target,kind='status',reason='inappropriate',details='A synthetic report description',request=randomUUID())=>
    asUser(actor,'select xelay_submit_profile_report($1,$2,$3,$4,$5) as value',[request,target,kind,reason,details]).then(result=>first(result).value)
  const admin=(sql,params=[],actor=ids.admin,aal='aal2')=>asUser(actor,sql,params,{aal})
  const list=(status='all',limit=25,offset=0,actor=ids.admin,aal='aal2')=>admin('select xelay_admin_profile_reports($1,$2,$3) as value',[status,limit,offset],actor,aal).then(result=>first(result).value)
  const detail=(id,actor=ids.admin,aal='aal2')=>admin('select xelay_admin_profile_report($1) as value',[id],actor,aal).then(result=>first(result).value)
  const review=(id,version,status='resolved',note='Reviewed synthetic evidence',action='none',actor=ids.admin,aal='aal2')=>
    admin('select xelay_admin_review_profile_report($1,$2,$3,$4,$5) as value',[id,version,status,note,action],actor,aal).then(result=>first(result).value)
  const reportRows=()=>db.query('select to_jsonb(t) as value from profile_reports t order by id').then(result=>result.rows)
  const historyRows=()=>db.query('select to_jsonb(t) as value from profile_report_history t order by report_id,version').then(result=>result.rows)
  const prefs=()=>db.query('select to_jsonb(t) as value from premium_preferences t order by user_id').then(result=>result.rows)
  const baseTables=['profiles','auth.users','user_roles','participant_entitlements','premium_preferences','participant_appearance_preferences','notifications','notification_email_outbox']
  const baseline=async()=>Object.fromEntries(await Promise.all(baseTables.map(async table=>[table,
    (await db.query(`select to_jsonb(t) as value from ${table} t order by ${['premium_preferences','participant_appearance_preferences'].includes(table)?'user_id':'id'}`)).rows])))
  const originalFunctions=async()=>(await db.query(`select p.oid::regprocedure::text as signature,p.proowner::text,p.proacl::text,md5(p.prosrc) as body
    from pg_proc p where p.oid in('xelay_is_platform_admin()'::regprocedure,'xelay_has_participant_access(uuid)'::regprocedure,
      'xelay_set_participant_status(text,text)'::regprocedure) order by signature`)).rows
  const before=await baseline(),functionsBefore=await originalFunctions(),auditBefore=await db.exec(audit)
  await db.exec(migration)

  await t.test('installation preserves existing data and RPCs, creates no notifications, and exposes no direct table access',async()=>{
    assert.deepEqual(await baseline(),before);assert.deepEqual(await originalFunctions(),functionsBefore)
    for(const table of ['profile_reports','profile_report_requests','profile_report_history']){
      assert.equal(first(await db.query(`select count(*)::int as n from ${table}`)).n,0)
      const metadata=first(await db.query(`select c.relrowsecurity as rls,(select count(*)::int from pg_policy where polrelid=c.oid) as policies
        from pg_class c where c.oid=$1::regclass`,[table]))
      assert.deepEqual(metadata,{rls:true,policies:0})
      for(const role of ['anon','authenticated','service_role']){
        assert.equal(first(await db.query("select has_table_privilege($1,$2,'select,insert,update,delete') as allowed",[role,table])).allowed,false)
        await denied(asUser(role==='authenticated'?ids.admin:null,`select * from ${table}`,[],{role,aal:'aal2'}))
      }
    }
    const auditAfter=await db.exec(audit)
    const hashes=results=>results.find(result=>result.rows?.[0]?.aggregate_row_hash!==undefined).rows
    assert.deepEqual(hashes(auditAfter),hashes(auditBefore))
    assert.ok(auditAfter.find(result=>result.rows?.[0]?.rls_enabled!==undefined).rows.every(row=>row.rls_enabled&&!row.any_direct_access&&row.policy_count===0))
  })

  let initial,request=randomUUID()
  await t.test('submission captures only server-sourced public fields and returns only an opaque receipt',async()=>{
    initial=await submit(ids.reporter,ids.target,'status','inappropriate','  A synthetic report description  ',request)
    assert.deepEqual(Object.keys(initial).sort(),['duplicate','id','status'])
    assert.equal(initial.status,'open');assert.equal(initial.duplicate,false)
    const data=await detail(initial.id)
    assert.equal(data.report.version,1);assert.equal(data.report.details,'A synthetic report description')
    assert.equal(data.report.target_snapshot.status_text,'Original status');assert.equal(data.report.target_snapshot.emoji_status,'sticker:penguin')
    assert.equal(data.report.target_snapshot.is_premium,true)
    assert.deepEqual(Object.keys(data.report.reporter_snapshot).sort(),['avatar_url','full_name','user_id','username'])
    assert.deepEqual(Object.keys(data.report.target_snapshot).sort(),['academic_unit_id','avatar_url','bio','emoji_status','experience','faculty','full_name','is_premium','specialty','status_text','study_year','university_id','user_id','username'])
    assert.equal(data.history.length,1);assert.equal(data.history[0].action,'submit')
    assert.equal(data.history[0].from_status,null);assert.equal(data.history[0].version,1)
    const serialized=JSON.stringify(data)
    assert.doesNotMatch(serialized,/@example\.test|email|password|raw_user_meta_data|chat_theme|chat_wallpaper|billing|auth_token|banned_until/)
    assert.deepEqual(data.current_status,{is_premium:true,status_text:'Original status',emoji_status:'sticker:penguin'})
  })

  await t.test('UUID retries are normalized, different payloads conflict and another open UUID reuses the report',async()=>{
    const retry=await submit(ids.reporter,ids.target,'status','inappropriate','\u00a0A synthetic report description\u00a0',request)
    assert.deepEqual(retry,{...initial,duplicate:true})
    for(const args of [[ids.target,'profile','inappropriate','A synthetic report description'],
      [ids.target,'status','hate','A synthetic report description'],[ids.target,'status','inappropriate','A changed report description'],
      [ids.freeTarget,'status','inappropriate','A synthetic report description']]){
      await assert.rejects(submit(ids.reporter,...args,request),/REPORT_REQUEST_CONFLICT/)
    }
    const alias=randomUUID(),duplicate=await submit(ids.reporter,ids.target,'status','other','A differently described issue',alias)
    assert.deepEqual(duplicate,{...initial,duplicate:true})
    assert.equal(first(await db.query('select count(*)::int as n from profile_reports')).n,1)
    assert.equal(first(await db.query('select count(*)::int as n from profile_report_requests')).n,2)
    await review(initial.id,1,'dismissed','No violation in this synthetic example')
    assert.deepEqual(await submit(ids.reporter,ids.target,'status','other','A differently described issue',alias),{id:initial.id,status:'dismissed',duplicate:true})
    assert.equal(first(await db.query('select count(*)::int as n from profile_reports')).n,1)
  })

  await t.test('reporter and target cannot read the queue, report, history or another reporter complaint',async()=>{
    for(const actor of [ids.reporter,ids.target,ids.otherReporter,ids.factorOnly]){
      await denied(list('all',25,0,actor,'aal2'));await denied(detail(initial.id,actor,'aal2'))
      await denied(review(initial.id,2,'resolved','Unauthorized review attempt','none',actor,'aal2'))
      for(const table of ['profile_reports','profile_report_requests','profile_report_history'])await denied(asUser(actor,`select * from ${table}`))
    }
    const distinct=await submit(ids.otherReporter,ids.target,'status','inappropriate','A synthetic report description',request)
    assert.notEqual(distinct.id,initial.id);assert.equal(distinct.duplicate,false)
    assert.deepEqual(Object.keys(distinct).sort(),['duplicate','id','status'])
  })

  await t.test('all admin operations require own platform role, AAL2 and a currently verified own factor',async()=>{
    for(const [actor,aal] of [[ids.admin,'aal1'],[ids.noFactorAdmin,'aal2'],[ids.factorOnly,'aal2']]){
      await denied(list('all',25,0,actor,aal));await denied(detail(initial.id,actor,aal))
      await denied(review(initial.id,2,'resolved','Unauthorized review attempt','none',actor,aal))
    }
    for(const role of ['anon','service_role'])for(const [sql,params] of [
      ['select xelay_submit_profile_report($1,$2,$3,$4,$5)',[randomUUID(),ids.target,'profile','other','Synthetic report description']],
      ['select xelay_admin_profile_reports($1,$2,$3)',['all',10,0]],['select xelay_admin_profile_report($1)',[initial.id]],
      ['select xelay_admin_review_profile_report($1,$2,$3,$4,$5)',[initial.id,2,'resolved','Reviewed synthetic evidence','none']],
    ])await denied(asUser(ids.admin,sql,params,{role,aal:'aal2'}))
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1",[ids.admin])
    await denied(list());await denied(detail(initial.id))
    await db.query("update auth.mfa_factors set status='verified' where user_id=$1",[ids.admin])
    assert.ok((await list()).total>=2)
    // Even a hypothetical older permissive shared helper cannot waive the new
    // functions' independent AAL, role and verified-factor checks.
    const original=first(await db.query("select pg_get_functiondef('xelay_is_platform_admin()'::regprocedure) as definition")).definition
    try{
      await db.exec("create or replace function public.xelay_is_platform_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select true $$")
      for(const [actor,aal] of [[ids.admin,'aal1'],[ids.noFactorAdmin,'aal2'],[ids.factorOnly,'aal2']])await denied(list('all',25,0,actor,aal))
    }finally{await db.exec(original)}
  })

  await t.test('authentication, self-report, target, enum and detail validation leave no receipts or reports on failure',async()=>{
    const countBefore=first(await db.query('select count(*)::int as n from profile_report_requests')).n
    await denied(submit(null));await denied(submit(randomUUID()))
    await assert.rejects(submit(ids.reporter,ids.reporter),/REPORT_SELF_NOT_ALLOWED/)
    await assert.rejects(submit(ids.reporter,randomUUID(),'profile'),/REPORT_TARGET_NOT_FOUND/)
    await assert.rejects(submit(ids.reporter,ids.target,'profile','other','valid details here',null),/REPORT_REQUEST_ID_REQUIRED/)
    for(const kind of [null,'all','Status','<script>'])await assert.rejects(submit(ids.reporter,ids.target,kind),/REPORT_KIND_INVALID/)
    for(const reason of [null,'unknown','Hate'])await assert.rejects(submit(ids.reporter,ids.target,'profile',reason),/REPORT_REASON_INVALID/)
    for(const details of [null,'  short  ','x'.repeat(2001),'\u00a0'.repeat(20)])await assert.rejects(submit(ids.reporter,ids.target,'profile','other',details),/REPORT_DETAILS_INVALID/)
    assert.equal(first(await db.query('select count(*)::int as n from profile_report_requests')).n,countBefore)
    const actor=await newUser()
    for(const reason of reasons)assert.ok((await submit(actor,ids.target,'profile',reason,'я'.repeat(10))).id)
    const long=await submit(await newUser(),ids.target,'profile','other','я'.repeat(2000))
    assert.equal((await detail(long.id)).report.details.length,2000)
  })

  await t.test('server Auth bans, soft deletion and missing Auth accounts block still-valid JWTs',async()=>{
    const actor=await newUser()
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[actor])
    await denied(submit(actor,ids.target,'profile'))
    assert.equal(first(await db.query('select count(*)::int as n from profile_report_requests where reporter_id=$1',[actor])).n,0)
    await db.query("update auth.users set banned_until=clock_timestamp()-interval '1 day' where id=$1",[actor])
    assert.ok((await submit(actor,ids.target,'profile')).id)
    await db.query('update auth.users set deleted_at=clock_timestamp() where id=$1',[actor])
    await denied(submit(actor,ids.freeTarget,'profile'))
    const missing=await newUser()
    await db.query('delete from auth.users where id=$1',[missing])
    await denied(submit(missing,ids.target,'profile'))
    await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[ids.admin])
    try{
      await denied(list());await denied(detail(initial.id));await denied(review(initial.id,2))
    }finally{await db.query('update auth.users set banned_until=null where id=$1',[ids.admin])}
  })

  await t.test('expired or absent entitlement never exposes retained private status preferences in snapshots',async()=>{
    const actor=await newUser()
    for(const target of [ids.freeTarget,ids.expiredTarget]){
      const created=await submit(actor,target,'profile')
      const data=await detail(created.id)
      assert.deepEqual(data.current_status,{is_premium:false,status_text:null,emoji_status:null})
      assert.equal(data.report.target_snapshot.is_premium,false)
      assert.equal(data.report.target_snapshot.status_text,null);assert.equal(data.report.target_snapshot.emoji_status,null)
      await assert.rejects(submit(actor,target,'status'),/REPORT_TARGET_STATUS_NOT_FOUND/)
    }
  })

  await t.test('quota counts ten new request IDs per reporter/day; retries remain free and actors are isolated',async()=>{
    const actor=await newUser(),request=randomUUID(),description='Quota synthetic description'
    const created=await submit(actor,ids.target,'profile','spam',description,request)
    for(let i=1;i<10;i++)assert.equal((await submit(actor,ids.target,'profile','spam',description)).duplicate,true)
    const snapshot=await reportRows()
    await assert.rejects(submit(actor,ids.freeTarget,'profile'),/REPORT_RATE_LIMITED/)
    assert.deepEqual(await submit(actor,ids.target,'profile','spam',description,request),{...created,duplicate:true})
    assert.deepEqual(await reportRows(),snapshot)
    assert.ok((await submit(await newUser(),ids.target,'profile')).id)
    await db.query("update profile_report_requests set created_at=date_trunc('day',clock_timestamp() at time zone 'Europe/Kyiv') at time zone 'Europe/Kyiv'-interval '1 second' where reporter_id=$1",[actor])
    assert.ok((await submit(actor,ids.freeTarget,'profile')).id)
  })

  await t.test('queue filtering, pagination and invalid bounds reveal data only through the MFA admin RPC',async()=>{
    const all=await list('all',100,0)
    assert.equal(all.items.length,all.total);assert.ok(all.open_count>0)
    const page=await list('all',2,1);assert.equal(page.items.length,2)
    assert.deepEqual(page.items.map(item=>item.id),all.items.slice(1,3).map(item=>item.id))
    assert.equal((await list('all',100,1000000)).items.length,0)
    for(const status of ['open','in_review','resolved','dismissed']){
      const filtered=await list(status,100,0);assert.ok(filtered.items.every(item=>item.status===status));assert.equal(filtered.total,filtered.items.length)
    }
    for(const args of [['unknown',10,0],[null,10,0],['all',0,0],['all',101,0],['all',10,-1],['all',10,1000001],['all',null,0]])await assert.rejects(list(...args),/REPORT_LIST_INVALID/)
    await assert.rejects(detail(randomUUID()),/REPORT_NOT_FOUND/)
  })

  await t.test('reviews follow the finite workflow, require final explanations and use optimistic versions',async()=>{
    const created=await submit(await newUser(),ids.target,'profile')
    const result=await review(created.id,1,'in_review','')
    assert.equal(result.report.status,'in_review');assert.equal(result.report.version,2);assert.equal(result.history.length,2)
    assert.deepEqual(Object.keys(result).sort(),['history','report'])
    const before=await detail(created.id)
    await assert.rejects(review(created.id,1),/REPORT_CONFLICT/)
    await assert.rejects(review(created.id,2,'in_review',''),/REPORT_TRANSITION_INVALID/)
    await assert.rejects(review(created.id,2,'open',''),/REPORT_TRANSITION_INVALID/)
    for(const note of ['',null,'short','x'.repeat(2001)])await assert.rejects(review(created.id,2,'resolved',note),/REPORT_REVIEW_NOTE_INVALID/)
    assert.deepEqual(await detail(created.id),before)
    const resolved=await review(created.id,2,'resolved','  Final synthetic explanation  ')
    assert.equal(resolved.report.version,3);assert.equal(resolved.report.status,'resolved');assert.equal(resolved.history[2].note,'Final synthetic explanation')
    assert.equal(resolved.history[2].from_status,'in_review');assert.equal(resolved.history[2].actor_id,ids.admin)
    await assert.rejects(review(created.id,3,'dismissed','Attempt to reopen final report'),/REPORT_FINALIZED/)
    assert.equal((await detail(created.id)).history.length,3)
  })

  await t.test('clear is explicit, only for status reports resolved with evidence, and preserves all unrelated records',async()=>{
    await setStatus('Clear this exact snapshot','sticker:penguin 😊')
    const profile=await submit(await newUser(),ids.target,'profile')
    const created=await submit(await newUser(),ids.target,'status')
    const before=await baseline(),allPrefs=await prefs()
    await assert.rejects(review(profile.id,1,'resolved','Reviewed synthetic evidence','clear_status'),/REPORT_ACTION_INVALID/)
    await assert.rejects(review(created.id,1,'in_review','','clear_status'),/REPORT_ACTION_INVALID/)
    await assert.rejects(review(created.id,1,'resolved','Reviewed synthetic evidence','ban'),/REPORT_ACTION_INVALID/)
    assert.deepEqual(await baseline(),before)
    const cleared=await review(created.id,1,'resolved','Status violated community rules','clear_status')
    assert.equal(cleared.report.version,2);assert.equal(cleared.history[1].action,'clear_status')
    const after=await baseline()
    for(const table of baseTables.filter(name=>name!=='premium_preferences'))assert.deepEqual(after[table],before[table],table)
    for(const old of allPrefs){
      const current=after.premium_preferences.find(row=>row.value.user_id===old.value.user_id).value
      if(old.value.user_id===ids.target){const {status_text,emoji_status,updated_at,...rest}=current;const {status_text:oldText,emoji_status:oldEmoji,updated_at:oldUpdated,...oldRest}=old.value;assert.equal(status_text,null);assert.equal(emoji_status,null);assert.deepEqual(rest,oldRest)}
      else assert.deepEqual(current,old.value)
    }
    assert.deepEqual((await detail(created.id)).current_status,{is_premium:true,status_text:null,emoji_status:null})
  })

  await t.test('a changed text or emoji prevents status clearing and rolls back review/history atomically',async()=>{
    for(const [text,emoji,newText,newEmoji] of [[null,'sticker:penguin','Changed','sticker:penguin'],['Same text','sticker:frog','Same text','sticker:penguin']]){
      await setStatus(text,emoji)
      const created=await submit(await newUser(),ids.target,'status')
      await setStatus(newText,newEmoji)
      const beforeReport=await detail(created.id),beforePrefs=await prefs(),beforeHistory=await historyRows()
      await assert.rejects(review(created.id,1,'resolved','Reviewed synthetic evidence','clear_status'),/REPORT_STATUS_CHANGED/)
      assert.deepEqual(await detail(created.id),beforeReport);assert.deepEqual(await prefs(),beforePrefs);assert.deepEqual(await historyRows(),beforeHistory)
    }
  })

  await t.test('concurrent duplicate submissions converge and competing reviews cannot overwrite a newer version',async()=>{
    const actor=await newUser(),request=randomUUID()
    // One identity is installed once: do not interleave fixture role changes.
    const concurrentSubmit=await asUser(actor,`select 1`).then(async()=>{
      await db.exec('set role authenticated')
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor,role:'authenticated',aal:'aal1'})])
      try{return await Promise.all(Array.from({length:4},()=>db.query('select xelay_submit_profile_report($1,$2,$3,$4,$5) as value',[request,ids.target,'profile','other','Concurrent synthetic complaint'])))}
      finally{await db.exec('reset role');await db.exec('reset "request.jwt.claims"')}
    })
    const created=first(concurrentSubmit[0]).value
    assert.ok(concurrentSubmit.every(result=>first(result).value.id===created.id))
    assert.equal(concurrentSubmit.filter(result=>!first(result).value.duplicate).length,1)
    await db.exec('set role authenticated')
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:ids.admin,role:'authenticated',aal:'aal2'})])
    let results
    try{results=await Promise.allSettled(['resolved','dismissed'].map(status=>db.query('select xelay_admin_review_profile_report($1,1,$2,$3,$4)',[created.id,status,'Concurrent administrative decision','none'])))}
    finally{await db.exec('reset role');await db.exec('reset "request.jwt.claims"')}
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
    assert.match(results.find(result=>result.status==='rejected').reason.message,/REPORT_CONFLICT/)
    assert.equal((await detail(created.id)).report.version,2);assert.equal((await detail(created.id)).history.length,2)
    assert.match(migration,/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\('xelay:profile-report:'/)
    assert.match(migration,/select \* into v_report from public\.profile_reports where id=p_report_id for update/)
    assert.match(migration,/where status in\('open','in_review'\)/)
  })

  await t.test('two status complaints cannot clear a changed/removed status twice; exact pair including nulls is authoritative',async()=>{
    await setStatus(null,'sticker:penguin')
    const a=await submit(await newUser(),ids.target,'status'),b=await submit(await newUser(),ids.target,'status')
    // A same-content save changes its timestamp, but not the reported pair.
    await setStatus(null,'sticker:penguin')
    await review(a.id,1,'resolved','Confirmed exact reported status','clear_status')
    await assert.rejects(review(b.id,1,'resolved','Second stale status decision','clear_status'),/REPORT_STATUS_CHANGED/)
    assert.equal((await detail(b.id)).report.version,1);assert.equal((await detail(b.id)).history.length,1)
  })

  await t.test('deleted target profiles retain minimal evidence but no current profile or administrative status action',async()=>{
    const target=await newUser(),actor=await newUser(),request=randomUUID()
    const created=await submit(actor,target,'profile','privacy','Synthetic deletion report evidence',request)
    await db.query('delete from profiles where id=$1',[target])
    const data=await detail(created.id)
    assert.equal(data.report.target_user_id,null);assert.equal(data.current_status,null)
    assert.equal(data.report.target_snapshot.user_id,target)
    assert.deepEqual(await submit(actor,target,'profile','privacy','Synthetic deletion report evidence',request),{...created,duplicate:true})
    await review(created.id,1,'dismissed','Target profile is no longer available')
    await db.query('delete from profiles where id=$1',[actor])
    assert.equal((await detail(created.id)).report.reporter_id,null)
    assert.equal(first(await db.query('select count(*)::int as n from profile_report_requests where reporter_id=$1',[actor])).n,0)
  })

  await t.test('the real typed frontend helper parses actual SQL receipts, lists, details, history and review responses',async()=>{
    let clientActor=await newUser(),clientAal='aal1'
    const sqlByName={
      xelay_submit_profile_report:['select xelay_submit_profile_report($1,$2,$3,$4,$5) as value',['p_request_id','p_target_user_id','p_kind','p_reason','p_details']],
      xelay_admin_profile_reports:['select xelay_admin_profile_reports($1,$2,$3) as value',['p_status','p_limit','p_offset']],
      xelay_admin_profile_report:['select xelay_admin_profile_report($1) as value',['p_report_id']],
      xelay_admin_review_profile_report:['select xelay_admin_review_profile_report($1,$2,$3,$4,$5) as value',['p_report_id','p_expected_version','p_status','p_note','p_action']],
    }
    const rpc=async(name,params)=>{
      assert.ok(Object.hasOwn(sqlByName,name));const [sql,keys]=sqlByName[name]
      assert.deepEqual(Object.keys(params).sort(),[...keys].sort())
      try{return {data:first(await asUser(clientActor,sql,keys.map(key=>params[key]),{aal:clientAal})).value,error:null}}
      catch(error){return {data:null,error:{code:error.code,message:error.message}}}
    }
    const module={exports:{}}
    const source=ts.transpileModule(await readFile(new URL('src/lib/profileReports.ts',root),'utf8'),{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
    }).outputText
    vm.runInNewContext(source,{module,exports:module.exports,Date,require(name){assert.equal(name,'./supabase');return {supabase:{rpc}}}})
    const api=module.exports
    await setStatus(null,'sticker:penguin')
    const input={targetUserId:ids.target,targetKind:'status',reason:'inappropriate',details:'Actual backend contract evidence',requestId:randomUUID()}
    const receipt=await api.submitProfileReport(input)
    assert.equal(receipt.duplicate,false);assert.equal(receipt.status,'open')
    assert.equal((await api.submitProfileReport(input)).duplicate,true)
    await assert.rejects(api.loadAdminProfileReport(receipt.id),error=>/ADMIN_MFA_REQUIRED/.test(error.message))
    clientActor=ids.admin;clientAal='aal2'
    const page=await api.loadAdminProfileReports({status:'all',limit:100,offset:0})
    assert.ok(page.items.some(report=>report.id===receipt.id))
    const data=await api.loadAdminProfileReport(receipt.id)
    assert.equal(data.report.target_snapshot.study_year,null)
    assert.equal(data.history[0].from_status,null);assert.equal(data.history[0].action,'submit')
    const firstReview=await api.reviewProfileReport({reportId:receipt.id,expectedVersion:1,status:'in_review',note:'',action:'none'})
    assert.equal(firstReview.report.version,2)
    const resolved=await api.reviewProfileReport({reportId:receipt.id,expectedVersion:2,status:'resolved',note:'Confirmed synthetic status evidence',action:'clear_status'})
    assert.equal(resolved.report.version,3);assert.equal(resolved.history.length,3)
    assert.equal((await api.loadAdminProfileReport(receipt.id)).current_status.emoji_status,null)
  })

  await t.test('reapplying the migration preserves complaints, history, receipts, data, setter owner and execution ACLs',async()=>{
    const reports=await reportRows(),history=await historyRows(),receipts=(await db.query('select to_jsonb(t) as value from profile_report_requests t order by reporter_id,request_id')).rows
    const base=await baseline(),functions=await originalFunctions()
    const contracts=async()=>(await db.query(`select p.oid::regprocedure::text as signature,p.proowner::text,p.proacl::text,p.prosecdef,p.proconfig
      from pg_proc p where p.proname in('xelay_submit_profile_report','xelay_admin_profile_reports','xelay_admin_profile_report','xelay_admin_review_profile_report') order by signature`)).rows
    const oldContracts=await contracts()
    await db.exec(migration)
    assert.deepEqual(await reportRows(),reports);assert.deepEqual(await historyRows(),history)
    assert.deepEqual((await db.query('select to_jsonb(t) as value from profile_report_requests t order by reporter_id,request_id')).rows,receipts)
    assert.deepEqual(await baseline(),base);assert.deepEqual(await originalFunctions(),functions);assert.deepEqual(await contracts(),oldContracts)
    for(const table of ['profile_reports','profile_report_requests','profile_report_history'])for(const role of ['anon','authenticated','service_role']){
      assert.equal(first(await db.query("select has_table_privilege($1,$2,'select,insert,update,delete') as allowed",[role,table])).allowed,false)
    }
  })
})
