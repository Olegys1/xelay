import assert from 'node:assert/strict'
import { createFixture } from './fixture.mjs'

const A='00000000-0000-4000-8000-000000000071'
const B='00000000-0000-4000-8000-000000000072'
const bucket='answer-media'
const origin='https://staging.supabase.co/storage/v1/object/public/'
const fixture=await createFixture({through:'202610030008'})
const {db,asUser,seedUser}=fixture
let checks=0
const ok=(value,message)=>{assert.ok(value,message);checks++}
const denied=async(fn,code='42501')=>{await assert.rejects(fn,e=>e.code===code);checks++}
const service=(sql,params=[])=>asUser(null,sql,params,{role:'service_role'})
const reserve=(path,size=100,mimetype='image/png')=>asUser(A,
  'select xelay_reserve_public_media_upload($1,$2,$3,$4)',[bucket,path,size,mimetype])
const history=async(path,mediaBucket=bucket,owner=A)=>
  (await db.query(`insert into storage.objects(bucket_id,name,owner_id,metadata,created_at,updated_at)
    values($1,$2,$3,'{"size":100,"mimetype":"image/png"}',now()-interval '2 days',now()-interval '2 days') returning *`,
    [mediaBucket,path,owner])).rows[0]
const candidates=async()=>((await service('select xelay_public_media_cleanup_candidates() items')).rows[0].items)
const claim=(path,id,mediaBucket=bucket)=>service('select xelay_public_media_cleanup_claim($1,$2,$3) claimed',[mediaBucket,path,id])
const remove=(path,mediaBucket=bucket)=>service('delete from storage.objects where bucket_id=$1 and name=$2 returning id',[mediaBucket,path])

try {
  await seedUser(A);await seedUser(B)
  const path=`${A}/questions/provider-upload.png`
  await reserve(path)
  await reserve(path)
  ok((await db.query('select count(*)::int n from public_media_upload_receipts where user_id=$1',[A])).rows[0].n===1,
    'idempotent reservation charges once')
  // Match Supabase Storage canUpload(): preview metadata, authenticated role,
  // rollback. The final write runs with the service JWT without the uploader ID.
  await db.exec('begin')
  await asUser(A,`insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)`,
    [bucket,path,A,{contentLength:500,mimetype:'image/png'}])
  await db.exec('rollback')
  ok((await db.query('select count(*)::int n from public_media_upload_reservations')).rows[0].n===1,'rolled-back preview does not consume reservation')
  ok(true,'multipart preview overhead above reserved file bytes does not reject a valid upload')
  await service('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,path,A,{size:100,mimetype:'image/png'}])
  ok((await db.query('select count(*)::int n from public_media_upload_reservations')).rows[0].n===0,'service final consumes reservation')
  ok((await db.query('select count(*)::int n from public_media_upload_receipts where user_id=$1',[A])).rows[0].n===1,'preview and final do not recharge rate')
  await denied(()=>service('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,`${A}/questions/unreserved.png`,A,{size:100,mimetype:'image/png'}]))
  await denied(()=>asUser(B,'select xelay_reserve_public_media_upload($1,$2,$3,$4)',[bucket,`${A}/questions/foreign.png`,100,'image/png']))
  await denied(()=>asUser(null,'select xelay_reserve_public_media_upload($1,$2,$3,$4)',[bucket,path,100,'image/png'],{role:'anon'}))
  const mismatched=`${A}/questions/mismatched.png`
  await reserve(mismatched,50)
  await denied(()=>service('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,mismatched,A,{size:51,mimetype:'image/png'}]),'22023')
  await denied(()=>service('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,mismatched,A,{size:50,mimetype:'text/html'}]),'22023')
  await asUser(A,'select xelay_cancel_public_media_upload($1,$2)',[bucket,mismatched])
  ok((await db.query('select count(*)::int n from public_media_upload_reservations')).rows[0].n===0,'failed upload reservation released')
  const unknownSize=`${A}/questions/provider-unknown-size.png`
  await reserve(unknownSize)
  await db.exec('begin')
  await asUser(A,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,unknownSize,A,{mimetype:'image/png'}])
  await db.exec('rollback')
  await service('insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    [bucket,unknownSize,A,{size:100,mimetype:'image/png'}])
  ok(true,'unknown contentLength preview accepts declared reservation; final validates actual bytes')
  // Account quota counts outstanding bodies, not only completed object rows.
  for(let i=0;i<19;i++) await reserve(`${A}/questions/pending-${i}.png`,26214400)
  await denied(()=>reserve(`${A}/questions/over-pending-quota.png`,26214400),'54000')
  await db.query('delete from public_media_upload_reservations where user_id=$1',[A])
  ok((await db.query('select count(*)::int n from public_media_upload_receipts where user_id=$1',[A])).rows[0].n===22,'cancellation cannot reset upload rate')

  const orphan=await history(`${A}/questions/orphan.png`)
  const unknown=await history('questions/unknown-legacy.png',bucket,null)
  const avatar=await history(`${A}/avatars/retained.png`,'avatars')
  await db.query('update profiles set avatar_url=$1 where id=$2',[origin+'avatars/'+avatar.name+'?cache=2',A])
  const legacy=await history(`${A}/questions/old file.png`)
  const q=(await asUser(A,`insert into questions(user_id,title,content,category)
    values($1,'Synthetic','Content','Business') returning id`,[A])).rows[0]
  await db.query('insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+bucket+'/'+legacy.name.replace(' ','%20')])
  let listed=await candidates()
  ok(listed.some(x=>x.object_id===orphan.id),'attributable detached old media listed')
  ok(!listed.some(x=>x.object_id===unknown.id),'unknown ownerless legacy file retained')
  ok(!listed.some(x=>x.object_id===avatar.id),'profile avatar with cache query retained')
  ok(!listed.some(x=>x.object_id===legacy.id),'URL-encoded legacy linked image retained')
  await denied(()=>asUser(A,'select xelay_public_media_cleanup_candidates()'))
  await denied(()=>asUser(A,'select * from public_media_cleanup_claims'))
  await denied(()=>remove(orphan.name))
  ok((await claim(orphan.name,orphan.id)).rows[0].claimed,'service claim granted for orphan')
  await denied(()=>asUser(A,'insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+bucket+'/'+orphan.name]))
  ok((await remove(orphan.name)).rows.length===1,'leased unreferenced object can be removed by Storage service')
  const attachedAfterList=await history(`${A}/questions/attached-after-list.png`)
  listed=await candidates()
  ok(listed.some(x=>x.object_id===attachedAfterList.id),'unattached candidate initially listed')
  await asUser(A,'insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+bucket+'/'+attachedAfterList.name])
  ok(!(await claim(attachedAfterList.name,attachedAfterList.id)).rows[0].claimed,'claim rechecks references created after listing')
  const recreated=await history(`${A}/questions/recreated.png`)
  await claim(recreated.name,recreated.id)
  await db.query('delete from storage.objects where id=$1',[recreated.id])
  const recreatedCurrent=await history(recreated.name)
  ok(recreatedCurrent.id!==recreated.id,'same path recreated with new object ID')
  await denied(()=>remove(recreated.name))
  ok(!(await claim(recreated.name,recreated.id)).rows[0].claimed,'stale candidate ID cannot claim recreated file')
  const versioned=await history(`${A}/questions/versioned.png`)
  await claim(versioned.name,versioned.id)
  await db.query('update storage.objects set updated_at=clock_timestamp(),metadata=$1 where id=$2',
    [{size:99,mimetype:'image/png'},versioned.id])
  await denied(()=>remove(versioned.name))
  ok(!(await claim(versioned.name,versioned.id)).rows[0].claimed,'replacement keeping same UUID invalidates lease and TTL eligibility')
  const expires=await history(`${A}/questions/expired-lease.png`)
  await claim(expires.name,expires.id)
  await db.query("update public_media_cleanup_claims set expires_at=now()-interval '1 minute' where object_id=$1",[expires.id])
  await denied(()=>remove(expires.name))
  await db.query("insert into public_media_upload_receipts(user_id,bucket_id,storage_path,created_at) values($1,$2,'old',now()-interval '10 days')",[B,bucket])
  await db.query("insert into question_view_receipts(question_id,user_id,viewed_on) values($1,$2,current_date-10)",[q.id,B])
  await db.query("insert into public_media_upload_reservations(bucket_id,storage_path,user_id,byte_size,mimetype,expires_at) values($1,'expired',$2,1,'image/png',now()-interval '1 day')",[bucket,B])
  const maintenance=(await service('select xelay_public_media_maintenance() counts')).rows[0].counts
  ok(maintenance.receipts===1 && maintenance.reservations===1 && maintenance.claims===1 && maintenance.views===1,'bounded maintenance trims inactive-account history')
  await denied(()=>asUser(A,'select xelay_public_media_maintenance()'))
  await denied(()=>service('select xelay_public_media_cleanup_candidates($1,$2)',[new Date(),101]),'22023')
  console.log(`Public media provider compatibility and cleanup: ${checks} checks passed.`)
} finally {await fixture.close()}
