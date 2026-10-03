import assert from 'node:assert/strict'
import { createFixture } from './fixture.mjs'

const A='00000000-0000-4000-8000-000000000081'
const B='00000000-0000-4000-8000-000000000082'
const C='00000000-0000-4000-8000-000000000083'
const f=await createFixture({through:'202610030008'})
const {db,asUser,seedUser}=f
let checks=0
const ok=(value,message)=>{assert.ok(value,message);checks++}
const denied=async(fn,code='22023')=>{await assert.rejects(fn,e=>e.code===code);checks++}
const post=(uid,content='Content',title='Question',category='Business')=>asUser(uid,
  'insert into questions(user_id,title,content,category) values($1,$2,$3,$4) returning id',[uid,title,content,category])
try {
  await seedUser(A);await seedUser(B);await seedUser(C)
  const q=(await post(B)).rows[0]
  await denied(()=>post(B,'x'.repeat(50001)))
  await denied(()=>post(B,'Content','x'.repeat(501)))
  await denied(()=>post(B,'Content','Question','x'.repeat(201)))
  await denied(()=>asUser(B,'insert into answers(question_id,user_id,content) values($1,$2,$3)',[q.id,B,'x'.repeat(50001)]))
  const full=(await post(B,'x'.repeat(50000))).rows[0]
  ok(Boolean(full.id),'50,000-character question is permitted')
  await denied(()=>asUser(B,'update questions set content=$1 where id=$2',['x'.repeat(50001),q.id]))
  await asUser(B,'insert into answers(question_id,user_id,content) values($1,$2,$3)',[q.id,B,'x'.repeat(50000)])
  ok(true,'50,000-character answer is permitted')
  const legacy=(await db.query('insert into questions(user_id,title,content,category) values($1,$2,$3,$4) returning id',
    [B,'Old header'.repeat(80),'x'.repeat(60000),'Business'])).rows[0]
  await asUser(B,'update questions set category=$1 where id=$2',['Economic',legacy.id])
  ok((await db.query('select length(content)::int n from questions where id=$1',[legacy.id])).rows[0].n===60000,
    'unchanged long legacy content is preserved')
  await asUser(B,'update questions set content=$1 where id=$2',['Shortened legacy body',legacy.id])
  ok(true,'legacy body can be shortened without altering the old header')
  const url=`https://staging.supabase.co/storage/v1/object/public/answer-media/${B}/answers/unknown.png`
  await denied(()=>post(B,(url+' ').repeat(101)))
  await post(B,(url+' ').repeat(100))
  ok(true,'up to 100 project file URLs are permitted')
  const before=(await db.query('select count(*)::int n from public_content_creation_receipts where user_id=$1',[B])).rows[0].n
  await denied(()=>post(B,(url+' ').repeat(101)))
  ok((await db.query('select count(*)::int n from public_content_creation_receipts where user_id=$1',[B])).rows[0].n===before,
    'failed creation does not consume a posting receipt')
  const first=(await post(A)).rows[0]
  for(let i=1;i<30;i++) await post(A)
  await denied(()=>post(A),'54000')
  await asUser(A,'select xelay_delete_own_question($1)',[first.id])
  await denied(()=>post(A),'54000')
  await denied(()=>asUser(A,'insert into answers(question_id,user_id,content) values($1,$2,$3)',[q.id,A,'Answer']),'54000')
  await db.query("insert into public_content_creation_receipts(user_id,created_at) select $1,now()-interval '2 hours' from generate_series(1,1000)",[C])
  await denied(()=>post(C),'54000')
  await denied(()=>asUser(B,'select * from public_content_creation_receipts'),'42501')
  await db.query("insert into public_content_creation_receipts(user_id,created_at) values($1,now()-interval '10 days')",[C])
  const maintenance=(await asUser(null,'select xelay_public_media_maintenance() counts',[],{role:'service_role'})).rows[0].counts
  ok(maintenance.content_receipts===1,'inactive-account posting receipts get bounded maintenance')
  console.log(`Public content length, URL and posting quotas: ${checks} checks passed.`)
} finally {await f.close()}
