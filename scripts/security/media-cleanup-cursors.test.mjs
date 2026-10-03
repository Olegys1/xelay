// Isolated managed-index approximation; synthetic paths and PostgreSQL only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'
const first=(result)=>result.rows[0]
const denied=(work)=>assert.rejects(work,(error)=>error.code==='42501')

test('cleanup candidates use bounded managed name pages and rotate all buckets',async(t)=>{
  const fx=await createFixture({useStagingParity:true})
  const {db,asUser,seedUser}=fx
  const user=randomUUID(),other=randomUUID()
  const publicBuckets=['avatars','answer-media','question-images']
  const privateBuckets=['xelay-message-media','xelay-chat-media']
  const before=new Date(Date.now()-24*60*60*1000).toISOString()
  const candidates=async(scope,limit=1)=>first(await asUser(null,`select xelay_${scope}_media_cleanup_candidates($1,$2) as value`,[before,limit],{role:'service_role'})).value
  const reset=()=>db.exec("update media_cleanup_bucket_cursors set last_storage_path='';update media_cleanup_bucket_rotation set next_bucket=0")
  const insert=async(bucket,name,age='3 days')=>{
    // Seed legacy metadata directly in the isolated test, not a hosted Storage
    // write: current upload reservations and quotas are covered elsewhere.
    await db.exec('alter table storage.objects disable trigger user')
    try {await db.query(`insert into storage.objects(bucket_id,name,owner_id,metadata,created_at,updated_at)
      values($1,$2,$3,'{"size":100,"mimetype":"image/png"}',now()-$4::interval,now()-$4::interval)`,[bucket,name,user,age])}
    finally {await db.exec('alter table storage.objects enable trigger user')}
  }
  try {
    // Model the hosted installer that could not create migration008's index.
    await db.exec('drop index if exists storage.xelay_public_media_cleanup_scan_idx')
    await seedUser(user,{username:'cursor_owner'});await seedUser(other,{username:'cursor_other'})
    await t.test('client/helper ACLs remain closed and candidate windows are validated',async()=>{
      for(const role of ['anon','authenticated']) {
        for(const scope of ['public','private'])await denied(asUser(user,`select xelay_${scope}_media_cleanup_candidates()`,[],{role}))
        await denied(asUser(user,"select xelay_media_cleanup_scan_candidates('public',now()-interval '2 days',1)",[],{role}))
        await denied(asUser(user,'select * from media_cleanup_bucket_cursors',[],{role}))
        await denied(asUser(user,'select * from media_cleanup_bucket_rotation',[],{role}))
      }
      await denied(asUser(null,"select xelay_media_cleanup_scan_candidates('public',now()-interval '2 days',1)",[],{role:'service_role'}))
      await denied(asUser(null,'update media_cleanup_bucket_cursors set last_storage_path=$1',['fake'],{role:'service_role'}))
      for(const scope of ['public','private']) {
        for(const [time,limit] of [[new Date().toISOString(),1],[before,0],[before,101],['infinity',1]]) {
          await assert.rejects(asUser(null,`select xelay_${scope}_media_cleanup_candidates($1,$2)`,[time,limit],{role:'service_role'}),(error)=>error.code==='22023')
        }
      }
    })
    await t.test('p_limit=1 rotates the first bucket across public and private scopes',async()=>{
      for(const bucket of [...publicBuckets,...privateBuckets])await insert(bucket,`${user}/00-${bucket}.png`)
      const publicSeen=[];for(let i=0;i<3;i++){const result=await candidates('public');assert.equal(result.length,1);publicSeen.push(result[0].bucket_id)}
      const privateSeen=[];for(let i=0;i<2;i++){const result=await candidates('private');assert.equal(result.length,1);privateSeen.push(result[0].bucket_id)}
      assert.deepEqual(publicSeen,publicBuckets);assert.deepEqual(privateSeen,privateBuckets)
      const names=(await db.query('select last_storage_path from media_cleanup_bucket_cursors')).rows
      assert.ok(names.every((row)=>row.last_storage_path.includes('/00-')))
      // Exhausted pages wrap instead of permanently starving later uploads.
      await candidates('public');await candidates('private')
      assert.ok((await candidates('public')).length>0)
    })
    await t.test('fresh/attached/claimed prefixes advance, later old files become candidates',async()=>{
      await db.exec('alter table storage.objects disable trigger user')
      try {await db.exec('delete from storage.objects')}
      finally {await db.exec('alter table storage.objects enable trigger user')}
      await reset()
      const retained=`${user}/00-retained.png`,claimed=`${user}/01-claimed.png`,fresh=`${user}/02-fresh.png`,eligible=`${user}/03-eligible.png`
      for(const bucket of publicBuckets){await insert(bucket,retained);await insert(bucket,claimed);await insert(bucket,fresh,'0 minutes');await insert(bucket,eligible)}
      await db.query('update profiles set avatar_url=$1 where id=$2',[`https://staging.supabase.co/storage/v1/object/public/avatars/${retained}`,user])
      // Retain the matching path in all public buckets to test name-prefix
      // advancement independently of the URL parser's bucket choice.
      await db.exec(`create table public.fixture_retained_paths(bucket_id text,name text);
        insert into fixture_retained_paths select bucket_id,name from storage.objects where name like '%/00-retained.png';
        alter function public.xelay_public_media_referenced(text,text) rename to fixture_original_public_media_referenced;
        create function public.xelay_public_media_referenced(p_bucket text,p_name text) returns boolean language sql stable security definer set search_path='' as $$
          select exists(select 1 from public.fixture_retained_paths where bucket_id=p_bucket and name=p_name)
            or public.fixture_original_public_media_referenced(p_bucket,p_name)$$;
        revoke all on function public.xelay_public_media_referenced(text,text) from public,anon,authenticated,service_role;`)
      for(const bucket of publicBuckets){const object=first(await db.query('select id from storage.objects where bucket_id=$1 and name=$2',[bucket,claimed]));await asUser(null,'select xelay_public_media_cleanup_claim($1,$2,$3)',[bucket,claimed,object.id],{role:'service_role'})}
      const found=new Set()
      for(let i=0;i<12;i++)for(const row of await candidates('public')){assert.equal(row.name,eligible);found.add(row.bucket_id)}
      assert.deepEqual([...found].sort(),[...publicBuckets].sort())
      // Private attachment and claim predicates also run after the same page.
      for(const bucket of privateBuckets){await insert(bucket,retained);await insert(bucket,claimed);await insert(bucket,fresh,'0 minutes');await insert(bucket,eligible)}
      await db.exec(`alter function public.xelay_private_media_attached(text,text) rename to fixture_original_private_media_attached;
        create function public.xelay_private_media_attached(p_bucket text,p_name text) returns boolean language sql stable security definer set search_path='' as $$
          select p_name like '%/00-retained.png' or public.fixture_original_private_media_attached(p_bucket,p_name)$$;
        revoke all on function public.xelay_private_media_attached(text,text) from public,anon,authenticated,service_role;`)
      for(const bucket of privateBuckets){const object=first(await db.query('select id from storage.objects where bucket_id=$1 and name=$2',[bucket,claimed]));await asUser(null,'select xelay_private_media_cleanup_claim($1,$2,$3)',[bucket,claimed,object.id],{role:'service_role'})}
      const privateFound=new Set()
      for(let i=0;i<10;i++)for(const row of await candidates('private')){assert.equal(row.name,eligible);privateFound.add(row.bucket_id)}
      assert.deepEqual([...privateFound].sort(),[...privateBuckets].sort())
    })
    await t.test('actual PostgreSQL planner uses the existing managed unique index without sorting',async()=>{
      const index=first(await db.query(`select indexname,indexdef from pg_indexes where schemaname='storage' and tablename='objects'
        and indexdef like 'CREATE UNIQUE INDEX%bucket_id, name%'`))
      assert.ok(index,'Managed (bucket_id,name) unique index must exist in the mock')
      await db.exec(`alter index storage."${index.indexname}" rename to bucketid_objname`)
      await db.exec('alter table storage.objects disable trigger user')
      try {await db.exec(`insert into storage.objects(bucket_id,name,metadata)
        select 'avatars','z-planner-'||lpad(i::text,6,'0'),'{}'::jsonb from generate_series(1,10000) i`)}
      finally {await db.exec('alter table storage.objects enable trigger user')}
      await db.exec('analyze storage.objects')
      // Do not disable seqscan or otherwise force a favorable plan.
      const plan=first(await db.query("explain (analyze,format json) select o.* from storage.objects o where o.bucket_id='avatars' and o.name>'z-planner-005000' order by o.name limit 66"))['QUERY PLAN'][0].Plan
      const nodes=[];const visit=(node)=>{nodes.push(node);for(const child of node.Plans||[])visit(child)};visit(plan)
      assert.equal(plan['Node Type'],'Limit')
      assert.ok(nodes.some((node)=>node['Index Name']==='bucketid_objname'&&node['Node Type'].includes('Index')))
      assert.ok(!nodes.some((node)=>node['Node Type']==='Sort'||node['Node Type']==='Seq Scan'))
      assert.equal(plan['Actual Rows'],66)
      assert.ok(nodes.filter((node)=>node['Index Name']==='bucketid_objname').every((node)=>node['Actual Rows']<=66))
    })
  } finally {await fx.close()}
})
