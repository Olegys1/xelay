// Isolated full-chain PostgreSQL and synthetic profiles/groups only. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createFixture} from './fixture.mjs'

const first=result=>result.rows[0]
const root=new URL('../../',import.meta.url)
const migration=await readFile(new URL('supabase/migrations/202610160005_academic_specialty_study_levels.sql',root),'utf8')
const audit=await readFile(new URL('supabase/audits/202610160005_academic_specialty_study_levels.sql',root),'utf8')
const expected=new Map([
  ['Бізнес-консалтинг',['master']],['Менеджмент інноваційної діяльності',['master']],
  ['Менеджмент організацій',['bachelor','master']],['Менеджмент підприємницької діяльності',['bachelor','master']],
])

test('catalog metadata matches the four officially verified degree classifications without disabling programs',async()=>{
  const catalog=JSON.parse(await readFile(new URL('supabase/data/knu_academic_specialties.json',root),'utf8'))
  const classified=catalog.filter(row=>Object.hasOwn(row,'study_levels'))
  assert.equal(classified.length,4)
  for(const row of classified){assert.equal(row.university_slug,'knu');assert.equal(row.unit_slug,'economics');assert.equal(row.code,'D3');assert.deepEqual(row.study_levels,expected.get(row.name))}
  assert.doesNotMatch(migration,/\b(?:update|delete\s+from)\s+public\.(?:profiles|study_groups|class_representative_requests)\b|\bset\s+is_active\s*=|\bgrant\b|\brevoke\b|\bcreate\s+(?:or\s+replace\s+)?function\b/i)
})

test('degree metadata changes only exact catalog rows and preserves existing users, groups, learning content and access',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160004',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `})
  t.after(()=>fx.close())
  const {db,asUser,seedUser}=fx
  const scope=first(await db.query(`select u.id as university,a.id as unit from universities u join academic_units a on a.university_id=u.id
    where u.slug='knu' and a.slug='economics'`))
  assert.ok(scope)
  const targetRows=async()=>(await db.query(`select s.* from academic_specialties s where university_id=$1 and academic_unit_id=$2 and code='D3'
    and name=any($3::text[]) order by name`,[scope.university,scope.unit,[...expected.keys()]])).rows
  const originalTargets=await targetRows();assert.equal(originalTargets.length,4)
  const innovation=originalTargets.find(row=>row.name==='Менеджмент інноваційної діяльності')
  const organizations=originalTargets.find(row=>row.name==='Менеджмент організацій')
  const owner=randomUUID(),member=randomUUID(),outsider=randomUUID()
  for(const [id,program] of [[owner,innovation],[member,organizations],[outsider,organizations]])await seedUser(id,{
    username:'degree_'+id.replaceAll('-','').slice(0,16),university_id:scope.university,academic_unit_id:scope.unit,
    specialty_id:program.id,experience:'bachelor',study_year:2,categories:['General'],
  })
  const request=randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,university_id,academic_unit_id,specialty,'LEGACY-MI-2','degree_fixture','approved',id,now() from profiles where id=$2`,[request,owner])
  const group=first(await asUser(owner,'select xelay_create_study_group($1) as id',[request])).id
  const invite=first(await asUser(owner,'select xelay_invite_to_study_group($1,$2) as id',[group,'degree_'+member.replaceAll('-','').slice(0,16)])).id
  await asUser(member,'select xelay_respond_study_group_invitation($1,true)',[invite])
  const lesson=first(await asUser(owner,`insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
    values($1,1,'08:00','09:20','Legacy preserved subject','lecture','2030-04-01','2030-04-29',$2) returning id`,[group,owner])).id
  const filePath=`${group}/${owner}/${randomUUID()}-preserved.pdf`
  await asUser(owner,`insert into storage.objects(bucket_id,name,owner,metadata) values('xelay-homework-files',$1,$2,
    '{"size":123,"mimetype":"application/pdf"}')`,[filePath,owner])
  await asUser(owner,`insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,attachments,created_by)
    values($1,$2,'2030-04-01','Preserved private homework',$3::jsonb,$4)`,
    [group,lesson,JSON.stringify([{storage_path:filePath,file_name:'preserved.pdf',mime_type:'application/pdf',file_size:123}]),owner])
  // Same label/code outside economics, and same label with another code inside
  // economics, must remain unclassified and keep their original active state.
  const otherUnit=first(await db.query('select id from academic_units where university_id=$1 and id<>$2 order by id limit 1',[scope.university,scope.unit])).id
  const otherScope=randomUUID(),otherCode=randomUUID()
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name,is_active)
    values($1,$2,$3,'D3','Synthetic other faculty','Менеджмент інноваційної діяльності',false),
    ($4,$2,$5,'TEST','Synthetic other code','Менеджмент інноваційної діяльності',true)`,[otherScope,scope.university,otherUnit,otherCode,scope.unit])
  const snapshot=async()=>Object.fromEntries(await Promise.all(['profiles','class_representative_requests','study_groups',
    'study_group_members','study_group_schedule','study_group_homework','study_group_seminars','study_group_materials',
    'notifications','notification_email_outbox','storage.objects'].map(async table=>[table,(await db.query(`select to_jsonb(t) as value from ${table} t order by id`)).rows])))
  const catalogWithoutLevels=async()=>(await db.query("select to_jsonb(s)-'study_levels' as value from academic_specialties s order by id")).rows
  const policies=async()=>(await db.query("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname in('public','storage') order by schemaname,tablename,policyname")).rows
  const functions=async()=>(await db.query(`select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,p.proowner::text,p.proacl::text,md5(p.prosrc) as hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.proname,arguments`)).rows
  const before=await snapshot(),catalogBefore=await catalogWithoutLevels(),policiesBefore=await policies(),functionsBefore=await functions()
  const auditBefore=await db.exec(audit)
  assert.equal(auditBefore.find(result=>result.rows?.[0]?.profile_id_references!==undefined).rows.length,4)
  assert.equal(auditBefore.find(result=>result.rows?.[0]?.aggregate_row_hash!==undefined).rows.length,3)
  await db.exec(migration)

  await t.test('all old references/content and catalog identity/visibility/source fields are unchanged',async()=>{
    assert.deepEqual(await snapshot(),before)
    assert.deepEqual(await catalogWithoutLevels(),catalogBefore)
    assert.deepEqual(await policies(),policiesBefore);assert.deepEqual(await functions(),functionsBefore)
    const auditAfter=await db.exec(audit)
    const classified=auditAfter.find(result=>result.rows?.[0]?.profile_id_references!==undefined).rows
    for(const row of classified)assert.deepEqual(row.study_levels,expected.get(row.name))
    assert.deepEqual(auditAfter.find(result=>result.rows?.[0]?.aggregate_row_hash!==undefined).rows,
      auditBefore.find(result=>result.rows?.[0]?.aggregate_row_hash!==undefined).rows)
    for(const row of await targetRows())assert.deepEqual(row.study_levels,expected.get(row.name))
    assert.deepEqual(first(await db.query('select study_levels,is_active from academic_specialties where id=$1',[otherScope])),{study_levels:[],is_active:false})
    assert.deepEqual(first(await db.query('select study_levels,is_active from academic_specialties where id=$1',[otherCode])),{study_levels:[],is_active:true})
  })

  await t.test('empty metadata remains unknown; constraints reject nulls, unsupported codes and multidimensional arrays',async()=>{
    const unknown=first(await db.query('select study_levels from academic_specialties where id=$1',[otherCode]))
    assert.deepEqual(unknown.study_levels,[])
    for(const expression of ["null","array['unknown']::text[]","array['bachelor',null]::text[]","array[['bachelor'],['master']]::text[]",
      "array['bachelor','master','postgraduate','bachelor']::text[]"]){
      await assert.rejects(db.query(`update academic_specialties set study_levels=${expression} where id=$1`,[otherCode]))
      assert.deepEqual(first(await db.query('select study_levels from academic_specialties where id=$1',[otherCode])).study_levels,[])
    }
    await db.query("update academic_specialties set study_levels=array['postgraduate'] where id=$1",[otherCode])
    await db.query("update academic_specialties set study_levels='{}' where id=$1",[otherCode])
  })

  await t.test('existing public read/admin-only write boundaries stay intact and programs remain active for masters',async()=>{
    for(const actor of [null,member]){
      const rows=(await asUser(actor,'select id,study_levels,is_active from academic_specialties where id=any($1::uuid[]) order by id',
        [originalTargets.map(row=>row.id)],{role:actor?'authenticated':'anon'})).rows
      assert.equal(rows.length,4);assert.ok(rows.every(row=>row.is_active))
      assert.equal(rows.find(row=>row.id===innovation.id).study_levels.includes('master'),true)
    }
    await assert.rejects(asUser(null,"update academic_specialties set study_levels='{}' where id=$1",[innovation.id],{role:'anon'}),/permission denied/)
    assert.equal((await asUser(member,"update academic_specialties set study_levels='{}' where id=$1 returning id",[innovation.id])).rows.length,0)
    assert.deepEqual(first(await db.query('select study_levels from academic_specialties where id=$1',[innovation.id])).study_levels,['master'])
    assert.equal((await asUser(outsider,'select id from study_group_homework where group_id=$1',[group])).rows.length,0)
  })

  await t.test('existing bachelor users keep their chosen program and may still edit unrelated profile fields or their course',async()=>{
    await asUser(owner,"update profiles set bio='Explicit own bio update' where id=$1",[owner])
    await asUser(owner,'update profiles set study_year=3 where id=$1',[owner])
    const profile=first(await db.query('select specialty_id,specialty,experience,study_year from profiles where id=$1',[owner]))
    assert.equal(profile.specialty_id,innovation.id);assert.equal(profile.specialty,innovation.name)
    assert.equal(profile.experience,'bachelor');assert.equal(profile.study_year,3)
    assert.deepEqual((await db.query('select to_jsonb(g) as value from study_groups g where id=$1',[group])).rows,
      before.study_groups.filter(row=>row.value.id===group))
  })

  await t.test('missing exact catalog targets fail closed and a normal rerun changes no row or access rule',async()=>{
    const business=originalTargets.find(row=>row.name==='Бізнес-консалтинг')
    await db.query("update academic_specialties set code='TEMP-MISSING' where id=$1",[business.id])
    try{await assert.rejects(db.exec(migration),/KNU_ECONOMICS_MANAGEMENT_CATALOG_SCOPE_MISMATCH/)}
    finally{await db.exec('rollback');await db.query("update academic_specialties set code='D3' where id=$1",[business.id])}
    const before=await snapshot(),catalog=(await db.query('select to_jsonb(s) as value from academic_specialties s order by id')).rows
    await db.exec(migration)
    assert.deepEqual(await snapshot(),before)
    assert.deepEqual((await db.query('select to_jsonb(s) as value from academic_specialties s order by id')).rows,catalog)
    assert.deepEqual(await policies(),policiesBefore);assert.deepEqual(await functions(),functionsBefore)
  })
})
