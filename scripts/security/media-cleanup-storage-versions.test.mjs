// Synthetic managed Storage versions/indexes; no hosted requests or files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'
const first=(result)=>result.rows[0]
const denied=(work)=>assert.rejects(work,(error)=>error.code==='42501')

test('cleanup supports current managed C indexes and skips all retained versions',async(t)=>{
  const fx=await createFixture({useStagingParity:true})
  const {db,asUser,seedUser}=fx
  const user=randomUUID(),before=new Date(Date.now()-86400000).toISOString()
  const buckets=['avatars','answer-media','question-images','xelay-message-media','xelay-chat-media']
  const reset=()=>db.exec("update media_cleanup_bucket_cursors set last_storage_path='';update media_cleanup_bucket_rotation set next_bucket=0")
  const candidates=async(scope,limit=100)=>first(await asUser(null,`select xelay_${scope}_media_cleanup_candidates($1,$2) value`,[before,limit],{role:'service_role'})).value
  const claim=async(bucket,name,id)=>first(await asUser(null,`select xelay_${bucket.startsWith('xelay-')?'private':'public'}_media_cleanup_claim($1,$2,$3) value`,[bucket,name,id],{role:'service_role'})).value
  const insert=async(bucket,name,flags={})=>{
    const id=randomUUID()
    await db.exec('alter table storage.objects disable trigger user')
    try {await db.query(`insert into storage.objects(id,bucket_id,name,owner_id,metadata,created_at,updated_at,version,is_versioned,is_delete_marker,archived_at)
      values($1,$2,$3,$4,'{"size":100,"mimetype":"image/png"}',now()-interval '3 days',now()-interval '3 days',$5,$6,$7,$8)`,
      [id,bucket,name,user,randomUUID(),flags.versioned||false,flags.marker||false,flags.archived?'2020-01-01T00:00:00Z':null])}
    finally {await db.exec('alter table storage.objects enable trigger user')}
    return id
  }
  try {
    await seedUser(user,{username:'storage_versions'})
    await db.exec(`drop index if exists storage.xelay_public_media_cleanup_scan_idx;
      alter table storage.objects drop constraint objects_bucket_id_name_key;
      alter table storage.objects add column version text;
      alter table storage.objects add column archived_at timestamptz;
      alter table storage.objects add column is_versioned boolean not null default false;
      alter table storage.objects add column is_delete_marker boolean not null default false;
      alter table storage.buckets add column versioning_status text default 'DISABLED';
      create index idx_objects_bucket_id_name on storage.objects(bucket_id,name collate "C");
      create unique index idx_objects_current_version on storage.objects(bucket_id,name collate "C") where archived_at is null;
      create unique index idx_objects_null_version on storage.objects(bucket_id,name collate "C") where not is_versioned;
      create unique index objects_bucket_id_name_version_key on storage.objects(bucket_id,name collate "C",version) nulls not distinct;`)
    await t.test('internal helpers and service claims remain unavailable to clients',async()=>{
      for(const shape of [{is_versioned:null},{is_delete_marker:null},{is_versioned:'unknown'},null]){
        assert.equal(first(await db.query('select xelay_media_cleanup_live_object($1::jsonb) value',[JSON.stringify(shape)])).value,false)
      }
      assert.equal(first(await db.query("select xelay_media_cleanup_live_object('{}'::jsonb) value")).value,true)
      for(const role of ['anon','authenticated','service_role']){
        await denied(asUser(user,"select xelay_media_cleanup_live_object('{}')",[],{role}))
        await denied(asUser(user,"select xelay_media_cleanup_unversioned_bucket('avatars')",[],{role}))
        await denied(asUser(user,"select xelay_media_cleanup_scan_candidates('public',now()-interval '2 days',1)",[],{role}))
      }
      for(const role of ['anon','authenticated'])for(const scope of ['public','private']){
        await denied(asUser(user,`select xelay_${scope}_media_cleanup_claim('avatars','test',$1)`,[randomUUID()],{role}))
      }
    })
    await t.test('archived versions, delete markers and enabled buckets are never candidates or claims',async()=>{
      for(const bucket of buckets){
        const prefix=`${user}/${bucket}`
        const flags=[['00-archived',{versioned:true,archived:true}],['01-versioned',{versioned:true}],
          ['02-marker',{versioned:true,marker:true}],['03-abnormal-archive',{archived:true}],['04-abnormal-marker',{marker:true}]]
        for(const [suffix,flag] of flags){const name=`${prefix}/${suffix}.png`,id=await insert(bucket,name,flag);assert.equal(await claim(bucket,name,id),false)}
        const name=`${prefix}/05-live.png`,id=await insert(bucket,name)
        // Multiple archived versions at an active path must not consume or
        // starve the unique nonversioned keyset page for that live object.
        for(let i=0;i<6;i++)await insert(bucket,name,{versioned:true,archived:true})
        await reset()
        const result=await candidates(bucket.startsWith('xelay-')?'private':'public')
        assert.ok(result.some((row)=>row.object_id===id))
        assert.ok(result.every((row)=>row.name.endsWith('/05-live.png')))
        await db.query('update storage.buckets set versioning_status=$1 where id=$2',['ENABLED',bucket])
        assert.equal(await claim(bucket,name,id),false)
        await reset()
        assert.ok((await candidates(bucket.startsWith('xelay-')?'private':'public')).every((row)=>row.bucket_id!==bucket))
        await db.query('update storage.buckets set versioning_status=null where id=$1',[bucket])
        assert.equal(await claim(bucket,name,id),false)
        await db.query("update storage.buckets set versioning_status='DISABLED' where id=$1",[bucket])
        assert.equal(await claim(bucket,name,id),true)
      }
    })
    await t.test('current-version partial index is an indexed fallback when null-version index is absent',async()=>{
      await db.exec('drop index storage.idx_objects_null_version')
      await reset()
      const result=await candidates('public')
      assert.ok(result.every((row)=>row.name.endsWith('/05-live.png')))
      await db.exec('create unique index idx_objects_null_version on storage.objects(bucket_id,name collate "C") where not is_versioned')
    })
    await t.test('a live claim does not authorize a newly versioned or archived row',async()=>{
      for(const bucket of ['avatars','xelay-message-media']){
        const name=`${user}/claim-transition.png`,id=await insert(bucket,name)
        assert.equal(await claim(bucket,name,id),true)
        // Model the unusual transition without application UPDATE triggers
        // consuming the claim; DELETE must independently reject the flags.
        await db.exec('alter table storage.objects disable trigger user')
        try {await db.query('update storage.objects set is_versioned=true where id=$1',[id])}
        finally {await db.exec('alter table storage.objects enable trigger user')}
        await assert.rejects(asUser(null,'delete from storage.objects where id=$1',[id],{role:'service_role'}),
          (error)=>error.code==='42501'||error.message==='PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
        assert.equal(first(await db.query('select count(*)::int n from storage.objects where id=$1',[id])).n,1)
      }
    })
    await t.test('unforced indexed page is bounded even across abnormal archived/marker prefixes',async()=>{
      await db.exec('alter table storage.objects disable trigger user')
      try {await db.exec(`insert into storage.objects(bucket_id,name,metadata,is_delete_marker,archived_at)
        select 'avatars','z-planner-'||lpad(i::text,6,'0'),'{}'::jsonb,i<=8000,
          case when i<=4000 then now()-interval '3 days' end from generate_series(1,10000) i`)}
      finally {await db.exec('alter table storage.objects enable trigger user')}
      await db.exec('analyze storage.objects')
      const plan=first(await db.query(`explain (analyze,format json) select o.* from storage.objects o
        where o.bucket_id='avatars' and o.name collate "C">'z-planner-005000' collate "C"
          and not o.is_versioned order by o.name collate "C" limit 66`))['QUERY PLAN'][0].Plan
      const nodes=[];const visit=(node)=>{nodes.push(node);for(const child of node.Plans||[])visit(child)};visit(plan)
      assert.equal(plan['Node Type'],'Limit');assert.equal(plan['Actual Rows'],66)
      assert.ok(nodes.some((node)=>node['Index Name']==='idx_objects_null_version'))
      assert.ok(!nodes.some((node)=>['Sort','Seq Scan'].includes(node['Node Type'])))
      assert.ok(nodes.filter((node)=>node['Index Name']==='idx_objects_null_version').every((node)=>node['Actual Rows']<=66))
      // New candidates use the same exact indexed predicate and inspect each
      // page's marker/archive flags afterward. A prefix still advances.
      await db.query("update media_cleanup_bucket_cursors set last_storage_path='z-planner-005000' where bucket_id='avatars'")
      await db.query("update media_cleanup_bucket_rotation set next_bucket=0 where scope='public'")
      await candidates('public')
      assert.equal(first(await db.query("select last_storage_path from media_cleanup_bucket_cursors where bucket_id='avatars'")).last_storage_path,'z-planner-005066')
    })
    await t.test('hosted read-only diagnostic returns catalog/plans only and leaves no writes',async()=>{
      const rows=await db.exec(await readFile(new URL('../../supabase/setup/security_staging_storage_index_plan.sql',import.meta.url),'utf8'))
      const values=rows.flatMap((result)=>result.rows).filter((row)=>row.security_storage_index_plan)
      assert.equal(values.length,1)
      const report=values[0].security_storage_index_plan
      assert.equal(report.read_only,true);assert.equal(report.plans.length,10)
      assert.equal(report.versioning_columns.length,3)
      assert.ok(report.indexes.some((index)=>index.name==='idx_objects_null_version'))
      assert.ok(!JSON.stringify(report).includes(user))
    })
  } finally {await fx.close()}
})
