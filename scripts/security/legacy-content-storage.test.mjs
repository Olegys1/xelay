import assert from 'node:assert/strict'
import { createFixture } from './fixture.mjs'

const A='00000000-0000-4000-8000-000000000001'
const B='00000000-0000-4000-8000-000000000002'
const C='00000000-0000-4000-8000-000000000003'
const D='00000000-0000-4000-8000-000000000004'
const origin='https://staging.supabase.co/storage/v1/object/public/'
const fixture=await createFixture({through:'202610030004'})
const {db,asUser,seedUser}=fixture
let checks=0
const ok=(condition,message)=>{assert.ok(condition,message);checks++}
const denied=async(fn,code='42501')=>{await assert.rejects(fn,(error)=>error.code===code);checks++}
const reserve=(uid,path,bucket='answer-media',size=100,mimetype='image/png')=>asUser(uid,
  'select xelay_reserve_public_media_upload($1,$2,$3,$4)',[bucket,path,size,mimetype])
const upload=async(uid,path,bucket='answer-media',size=100,mimetype='image/png')=>{
  await reserve(uid,path,bucket,size,mimetype)
  return asUser(uid,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4) returning id',
    [bucket,path,uid,{size,mimetype}])
}

try {
  await db.exec('alter table auth.users add column if not exists deleted_at timestamptz')
  for(const uid of [A,B,C,D]) await seedUser(uid)
  const q=(await asUser(A,`insert into questions(user_id,title,content,category,author_name,created_at,views,is_pinned)
    values($1,'Question','Question','Business','Forged','infinity',999,true) returning *`,[A])).rows[0]
  ok(q.author_name!== 'Forged' && q.views===0 && !q.is_pinned,'server sets authorship and system fields')
  ok(Number.isFinite(new Date(q.created_at).getTime()),'server timestamp replaces invalid client date')
  ok((await asUser(B,'update questions set content=$1 where id=$2 returning id',['Hijack',q.id])).rows.length===0,'foreign question text denied')
  ok((await asUser(A,'update questions set content=$1 where id=$2 returning id',['Own edit',q.id])).rows.length===1,'own question edit preserved')
  for(const field of ['user_id','id','author_name','created_at','is_pinned','views','answers_count']) {
    await denied(()=>asUser(A,`update questions set ${field}=${field} where id=$1`,[q.id]))
  }
  await db.exec('grant update(id,author_name) on questions to authenticated')
  await denied(()=>asUser(A,'update questions set id=$1 where id=$2',['replacement-id',q.id]))
  await denied(()=>asUser(A,'update questions set author_name=$1 where id=$2',['Different person',q.id]))
  await db.exec('revoke update(id,author_name) on questions from authenticated')
  const a=(await asUser(B,`insert into answers(question_id,user_id,content,author_name,author_rating)
    values($1,$2,'Answer','Impersonation',999) returning *`,[q.id,B])).rows[0]
  ok(a.author_name!=='Impersonation' && a.author_rating===0,'answer authorship and rating server assigned')
  ok((await db.query('select answers_count from questions where id=$1',[q.id])).rows[0].answers_count===1,'definer answer counter survives tighter grants')
  ok((await asUser(A,'update answers set content=$1 where id=$2 returning id',['Foreign edit',a.id])).rows.length===0,'foreign answer edit denied')
  ok((await asUser(B,'update answers set content=$1 where id=$2 returning id',['Own answer edit',a.id])).rows.length===1,'own answer edit preserved')
  for(const field of ['user_id','question_id','id','created_at','author_name','author_rating','likes']) {
    await denied(()=>asUser(B,`update answers set ${field}=${field} where id=$1`,[a.id]))
  }
  await denied(()=>asUser(A,'select xelay_delete_own_answer($1)',[a.id]))

  const path=`${A}/questions/photo.png`
  await upload(A,path)
  const image=(await asUser(A,'insert into question_images(question_id,image_url) values($1,$2) returning id',
    [q.id,origin+'answer-media/'+path])).rows[0]
  ok(Boolean(image.id),'own uploaded image attaches')
  await denied(()=>asUser(B,'insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+'answer-media/'+path]))
  await denied(()=>asUser(null,'insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+'answer-media/'+path],{role:'anon'}))
  ok((await asUser(B,'delete from question_images where id=$1 returning id',[image.id])).rows.length===0,'foreign image delete denied')
  await denied(()=>asUser(A,'update question_images set question_id=$1 where id=$2',[q.id,image.id]))
  await denied(()=>asUser(A,'update question_images set image_url=$1 where id=$2',
    ['https://different.supabase.co/storage/v1/object/public/answer-media/'+path,image.id]),'22023')
  await denied(()=>asUser(B,'insert into answer_images(answer_id,image_url) values($1,$2)',[a.id,origin+'answer-media/'+path]))
  ok((await asUser(null,'select id from question_images where id=$1',[image.id],{role:'anon'})).rows.length===1,'public reading preserved')

  const avatar=`${A}/avatars/photo.png`
  await upload(A,avatar,'avatars')
  ok((await asUser(B,'update storage.objects set metadata=$1 where name=$2 returning id',[{size:99,mimetype:'image/png'},avatar])).rows.length===0,'foreign avatar overwrite denied')
  ok((await asUser(B,'delete from storage.objects where name=$1 returning id',[avatar])).rows.length===0,'foreign avatar delete denied')
  await reserve(A,avatar,'avatars',99)
  ok((await asUser(A,'update storage.objects set metadata=$1 where name=$2 returning id',[{size:99,mimetype:'image/png'},avatar])).rows.length===1,'own avatar update preserved')
  await denied(()=>asUser(A,'update storage.objects set name=$1 where name=$2',[`${B}/avatars/renamed.png`,avatar]))
  await denied(()=>upload(B,`${A}/answers/new.png`))
  await denied(()=>upload(A,'questions/old-arbitrary-path.png'))
  await denied(()=>upload(A,`${A}/answers/payload.svg`,'answer-media',100,'image/svg+xml'),'22023')
  await denied(()=>upload(A,`${A}/answers/oversize.png`,'answer-media',26214401),'22023')
  await denied(()=>upload(A,`${A}/avatars/oversize.png`,'avatars',5242881),'22023')

  // Synthetic history: owner metadata wins over forged links or paths; truly
  // ownerless old files use only unambiguous existing author relationships.
  const legacy='questions/old-linked-photo.png'
  await db.query(`insert into storage.objects(bucket_id,name,metadata) values('answer-media',$1,$2)`,[legacy,{size:100,mimetype:'image/png'}])
  await db.query('insert into question_images(question_id,image_url) values($1,$2)',[q.id,origin+'answer-media/'+legacy])
  ok((await asUser(A,'select xelay_owns_legacy_public_object($1,$2,null) owns',['answer-media',legacy])).rows[0].owns,'legacy linked own file remains manageable')
  ok(!(await asUser(B,'select xelay_owns_legacy_public_object($1,$2,null) owns',['answer-media',legacy])).rows[0].owns,'legacy link does not grant foreign file access')
  await db.query('insert into answer_images(answer_id,image_url) values($1,$2)',[a.id,origin+'answer-media/'+legacy])
  ok(!(await asUser(A,'select xelay_owns_legacy_public_object($1,$2,null) owns',['answer-media',legacy])).rows[0].owns,'ambiguous ownerless legacy links grant neither author ownership')
  await denied(()=>asUser(B,'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4)',
    ['answer-media',`${B}/answers/spoofed-owner.png`,A,{size:100,mimetype:'image/png'}]))
  const oldAvatar=`${A}-1700000000000.jpg`
  await db.query(`insert into storage.objects(bucket_id,name,owner,metadata) values('avatars',$1,$2,$3)`,[oldAvatar,A,{size:100,mimetype:'image/jpeg'}])
  ok((await asUser(A,'delete from storage.objects where name=$1 returning id',[oldAvatar])).rows.length===1,'old root avatar owned via owner metadata can be removed')
  await db.query(`insert into storage.objects(bucket_id,name,owner_id,metadata)
    select 'answer-media',$1||'/answers/'||n||'.png',$1,jsonb_build_object('size',26214400,'mimetype','image/png') from generate_series(1,20)n`,[C])
  await denied(()=>upload(C,`${C}/answers/over-quota.png`,'answer-media',1),'54000')
  await db.query(`insert into public_media_upload_receipts(user_id,bucket_id,storage_path)
    select $1,'answer-media',n::text from generate_series(1,50)n`,[D])
  await denied(()=>upload(D,`${D}/answers/over-rate.png`),'54000')
  await denied(()=>asUser(A,'select * from public_media_upload_receipts'))

  await asUser(A,'select increment_question_views($1)',[q.id])
  await asUser(A,'select increment_question_views($1)',[q.id])
  await asUser(null,'select increment_question_views($1)',[q.id],{role:'anon'})
  ok((await db.query('select views from questions where id=$1',[q.id])).rows[0].views===1,'views RPC preserved and deduplicated')
  await denied(()=>asUser(A,'select * from question_view_receipts'))
  await asUser(B,'select xelay_delete_own_answer($1)',[a.id])
  ok((await db.query('select answers_count from questions where id=$1',[q.id])).rows[0].answers_count===0,'own deletion and counter cleanup preserved')
  await asUser(A,'select xelay_delete_own_question($1)',[q.id])
  ok((await db.query('select count(*)::int n from question_images where question_id=$1',[q.id])).rows[0].n===0,'owner question delete still cleans child links')
  console.log(`Legacy content and public storage: ${checks} checks passed.`)
} finally { await fixture.close() }
