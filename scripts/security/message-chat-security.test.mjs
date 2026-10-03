import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const ids = Object.fromEntries(['a','b','c','d','e','f'].map((key) => [key, randomUUID()]))
const migration = await readFile(new URL('../../supabase/migrations/202610030005_message_chat_security.sql', import.meta.url), 'utf8')
const rejects = (work, code) => assert.rejects(work, (error) => error.message.includes(code))
const first = (result) => result.rows[0]

test('message/chat security with real PostgreSQL functions, grants and RLS', async (t) => {
  const fx = await createFixture({ through: '202610030003' })
  const { db, asUser } = fx
  try {
    for (const id of Object.values(ids)) await fx.seedUser(id)
    const conv = async (a,b) => first(await db.query('insert into conversations(user_one_id,user_two_id) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) returning id',[a,b])).id
    const ab = await conv(ids.a,ids.b), dc = await conv(ids.d,ids.c), ef = await conv(ids.e,ids.f)
    await db.query("insert into participant_entitlements(user_id,source,valid_from,valid_until) values($1,'admin_grant',now()-interval '1 day',now()+interval '1 year')",[ids.a])
    const legacyMessage = first(await asUser(ids.a,"insert into messages(conversation_id,sender_id,recipient_id,body,created_at) values($1,$2,$3,'legacy date','infinity') returning id",[ab,ids.a,ids.b])).id
    const legacyPoll = first(await asUser(ids.a,"select xelay_chat_publish('poll',$1::jsonb,null,$2) as value",[JSON.stringify({question:'Legacy poll',options:['A','B'],anonymous:true,allows_multiple:false,closes_at:'280000-01-01T00:00:00Z'}),ab])).value
    await db.exec(migration)
    const reserve = (owner,bucket,path) => asUser(owner,'select xelay_private_reserve_media($1,$2)',[bucket,path])
    const upload = async (owner,bucket,path,size=10,mime='image/png') => {
      await reserve(owner,bucket,path)
      return first(await asUser(owner,
        'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb) returning id',
        [bucket,path,owner,JSON.stringify({size,mimetype:mime})])).id
    }
    const media = (path) => ({storage_path:path,file_name:'image.png',media_type:'image',mime_type:'image/png'})
    const direct = async (owner,conversation,messageId= randomUUID(),attachments=[]) => first(await asUser(owner,
      'select xelay_send_direct_message($1,$2,$3,null,$4::jsonb) as value',[messageId,conversation,'Message',JSON.stringify(attachments)])).value

    await t.test('legacy invalid metadata is repaired and original values are retained', async () => {
      assert.equal(first(await db.query('select xelay_private_safe_timestamp(created_at) as safe,body from messages where id=$1',[legacyMessage])).safe,true)
      assert.equal(first(await db.query('select body from messages where id=$1',[legacyMessage])).body,'legacy date')
      const poll=first(await db.query('select content from chat_publications where id=$1',[legacyPoll.id])).content
      assert.equal(poll.closes_at,null); assert.deepEqual(poll.options,['A','B'])
      assert.equal(first(await db.query('select count(*)::int as count from message_chat_date_repairs')).count,2)
      await rejects(asUser(ids.b,'select * from message_chat_date_repairs'),'permission denied')
    })
    await t.test('client dates are replaced and dates cannot be edited; foreign sends fail', async () => {
      for(const value of ['infinity','-infinity','280000-01-01','0001-01-01','9999-12-31']) {
        const row=first(await asUser(ids.a,'insert into messages(conversation_id,sender_id,recipient_id,body,created_at) values($1,$2,$3,$4,$5) returning id,created_at',[ab,ids.a,ids.b,'Date guard',value]))
        assert.ok(Number.isFinite(new Date(row.created_at).getTime()))
        assert.ok(Math.abs(new Date(row.created_at).getTime()-Date.now())<60_000)
        await rejects(asUser(ids.a,"update messages set created_at='infinity' where id=$1",[row.id]),'permission denied')
      }
      await rejects(direct(ids.c,ab),'CHAT_MEMBER_REQUIRED')
    })
    await t.test('poll upper bound, Premium gate and anonymous voters stay enforced', async () => {
      const content=(closes_at) => JSON.stringify({question:'Safe poll',options:['A','B'],anonymous:true,allows_multiple:false,closes_at})
      for(const value of ['infinity','-infinity','280000-01-01','2020-01-01',new Date(Date.now()+367*86400000).toISOString()]) {
        await rejects(asUser(ids.a,"select xelay_chat_publish('poll',$1::jsonb,null,$2)",[content(value),ab]),'CHAT_PUBLICATION_INVALID_INPUT')
      }
      for(const value of [null,new Date(Date.now()+364*86400000).toISOString()]) {
        const pub=first(await asUser(ids.a,"select xelay_chat_publish('poll',$1::jsonb,null,$2) as value",[content(value),ab])).value
        await asUser(ids.b,'select xelay_chat_poll_vote($1,array[1])',[pub.id])
        await rejects(asUser(ids.a,'select xelay_chat_poll_voters($1,1)',[pub.id]),'CHAT_POLL_ANONYMOUS')
      }
      await rejects(asUser(ids.b,"select xelay_chat_publish('poll',$1::jsonb,null,$2)",[content(null),ab]),'PARTICIPANT_REQUIRED')
      await rejects(asUser(ids.b,'select * from chat_poll_votes'),'permission denied')
      await rejects(asUser(ids.b,'select xelay_chat_poll_json($1)',[legacyPoll.id]),'permission denied')
    })
    await t.test('atomic attachments validate owner/metadata/count/total and roll back the message', async () => {
      const m=randomUUID(), paths=[]
      for(let i=0;i<6;i++) { const path=`${ab}/${ids.a}/${m}/${randomUUID()}.png`; await upload(ids.a,'xelay-message-media',path); paths.push(path) }
      await rejects(direct(ids.a,ab,m,paths.map(media)),'PRIVATE_MEDIA_ATTACHMENT_LIMIT')
      assert.equal(first(await db.query('select count(*)::int as count from messages where id=$1',[m])).count,0)
      await direct(ids.a,ab,m,paths.slice(0,5).map(media))
      await rejects(asUser(ids.a,"insert into message_attachments(message_id,conversation_id,uploaded_by,storage_path,file_name,media_type,mime_type) values($1,$2,$3,$4,'sixth','image','image/png')",[m,ab,ids.a,paths[5]]),'PRIVATE_MEDIA_ATTACHMENT_LIMIT')
      const totalM=randomUUID(), totalPaths=[]
      for(let i=0;i<3;i++) { const path=`${ab}/${ids.a}/${totalM}/${randomUUID()}.png`; await upload(ids.a,'xelay-message-media',path,26214400); totalPaths.push(path) }
      await rejects(direct(ids.a,ab,totalM,totalPaths.map(media)),'PRIVATE_MEDIA_ATTACHMENT_LIMIT')
      assert.equal(first(await db.query('select count(*)::int as count from messages where id=$1',[totalM])).count,0)
      await direct(ids.a,ab,totalM,totalPaths.slice(0,2).map(media))
      const badM=randomUUID(), badPath=`${ab}/${ids.a}/${badM}/${randomUUID()}.png`
      await upload(ids.a,'xelay-message-media',badPath)
      await db.query('update storage.objects set owner_id=$1 where name=$2',[ids.b,badPath]) // Hostile legacy descriptor fixture.
      await rejects(direct(ids.a,ab,badM,[media(badPath)]),'PRIVATE_MEDIA_INVALID')
      assert.equal(first(await db.query('select count(*)::int as count from messages where id=$1',[badM])).count,0)
      await rejects(asUser(ids.a,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[`${ab}/${ids.a}/${randomUUID()}/fake.png`,ids.b,JSON.stringify({size:10,mimetype:'image/png'})]),'PRIVATE_MEDIA_FORBIDDEN')
      const mismatchM=randomUUID(), mismatchPath=`${ab}/${ids.a}/${mismatchM}/${randomUUID()}.png`
      await upload(ids.a,'xelay-message-media',mismatchPath,10,'image/jpeg')
      await rejects(direct(ids.a,ab,mismatchM,[media(mismatchPath)]),'PRIVATE_MEDIA_INVALID')
    })
    await t.test('attached delete is denied; soft-delete receipt permits and consumes actual cleanup', async () => {
      const m=randomUUID(), path=`${ab}/${ids.a}/${m}/${randomUUID()}.png`
      await upload(ids.a,'xelay-message-media',path); await direct(ids.a,ab,m,[media(path)])
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[path])).rows.length,1)
      assert.equal((await asUser(ids.a,'delete from storage.objects where name=$1 returning id',[path])).rows.length,0)
      await rejects(db.query('delete from storage.objects where name=$1',[path]),'PRIVATE_MEDIA_IN_USE')
      await asUser(ids.a,'select xelay_delete_message($1)',[m])
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup where storage_path=$1',[path])).count,1)
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[path])).rows.length,0)
      assert.equal((await asUser(ids.a,'select id from storage.objects where name=$1',[path])).rows.length,1)
      assert.equal((await asUser(ids.a,'delete from storage.objects where name=$1 returning id',[path])).rows.length,1)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup where storage_path=$1',[path])).count,0)
      const replacementM=randomUUID(), replacementPath=`${ab}/${ids.a}/${replacementM}/${randomUUID()}.png`
      await upload(ids.a,'xelay-message-media',replacementPath)
      await asUser(ids.a,'delete from storage.objects where name=$1',[replacementPath])
      await rejects(direct(ids.a,ab,replacementM,[media(replacementPath)]),'PRIVATE_MEDIA_INVALID')
    })
    let space
    await t.test('chat admin cleanup survives role loss without exposing other pending or attached files', async () => {
      space=first(await asUser(ids.a,"select xelay_chat_create('group','private','Security group',null,'',null,true,false,true) as id")).id
      await db.query("insert into chat_members(space_id,user_id,status,role) values($1,$2,'active','admin')",[space,ids.b])
      const path=`${ids.a}/${randomUUID()}/file.png`, other=`${ids.a}/${randomUUID()}/other.png`
      await upload(ids.a,'xelay-chat-media',path); await upload(ids.a,'xelay-chat-media',other)
      const descriptors=[{...media(path),file_size:10}]
      const post=first(await asUser(ids.a,"select xelay_chat_send($1,'Post',null,null,null,$2::jsonb) as id",[space,JSON.stringify(descriptors)])).id
      await asUser(ids.b,'select xelay_chat_delete_post($1)',[post])
      await asUser(ids.a,"select xelay_chat_member($1,$2,'ban')",[space,ids.b])
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[other])).rows.length,0)
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[path])).rows.length,1)
      assert.equal((await asUser(ids.b,'delete from storage.objects where name=$1 returning id',[path])).rows.length,1)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup where storage_path=$1',[path])).count,0)
      const attached=`${ids.a}/${randomUUID()}/attached.png`; const object=await upload(ids.a,'xelay-chat-media',attached)
      await asUser(ids.a,"select xelay_chat_send($1,'Attached',null,null,null,$2::jsonb)",[space,JSON.stringify([{...media(attached),file_size:10}])])
      await db.query("insert into private_media_cleanup(bucket_id,storage_path,object_id,owner_id,cleanup_user_id) values('xelay-chat-media',$1,$2,$3,$4)",[attached,object,ids.a,ids.b])
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[attached])).rows.length,0)
      assert.equal((await asUser(ids.b,'delete from storage.objects where name=$1 returning id',[attached])).rows.length,0)
      await rejects(asUser(ids.b,'select * from private_media_cleanup'),'permission denied')
      await rejects(asUser(ids.b,'select xelay_private_media_cleanup_candidates()'),'permission denied')
    })
    await t.test('cancel without an own pending request is a no-op; cancellation touches the header once', async () => {
      const before=first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at
      await asUser(ids.c,'select xelay_chat_cancel_request($1)',[space])
      assert.deepEqual(first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at,before)
      await db.query('insert into chat_join_requests(space_id,user_id) values($1,$2)',[space,ids.c])
      await asUser(ids.c,'select xelay_chat_cancel_request($1)',[space])
      assert.equal(first(await db.query('select status from chat_join_requests where space_id=$1 and user_id=$2',[space,ids.c])).status,'cancelled')
      const after=first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at
      await asUser(ids.c,'select xelay_chat_cancel_request($1)',[space])
      assert.deepEqual(first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at,after)
    })
    await t.test('ordinary INSERT and RPC share the atomic 30/minute direct-message limit', async () => {
      await Promise.all(Array.from({length:30},(_,i)=>asUser(ids.d,'insert into messages(conversation_id,sender_id,recipient_id,body) values($1,$2,$3,$4)',[dc,ids.d,ids.c,`Rate ${i}`])))
      await rejects(direct(ids.d,dc),'DIRECT_MESSAGE_RATE_LIMIT')
      assert.equal(first(await db.query('select count(*)::int as count from messages where sender_id=$1',[ids.d])).count,30)
    })
    await t.test('connection requests have a server limit and rejected-pair cooldown', async () => {
      const recipients=[]
      for(let i=0;i<11;i++){ const id=randomUUID(); await fx.seedUser(id); recipients.push(id) }
      for(const id of recipients.slice(0,10)) await asUser(ids.d,'select send_connection_request($1)',[id])
      await rejects(asUser(ids.d,'select send_connection_request($1)',[recipients[10]]),'CONNECTION_REQUEST_RATE_LIMIT')
      const rejected=first(await asUser(ids.c,'select send_connection_request($1) as id',[ids.f])).id
      await asUser(ids.f,'select reject_connection_request($1)',[rejected])
      await rejects(asUser(ids.c,'select send_connection_request($1)',[ids.f]),'CONNECTION_REQUEST_RATE_LIMIT')
      await rejects(asUser(ids.c,"insert into connection_requests(requester_id,recipient_id,status) values($1,$2,'accepted')",[ids.c,ids.b]),'CONNECTION_REQUEST_INVALID')
    })
    await t.test('daily direct/connection limits accept the last allowed action and reject the next', async () => {
      const owner=randomUUID(), recipient=randomUUID(); await fx.seedUser(owner); await fx.seedUser(recipient)
      const conversation=await conv(owner,recipient)
      await db.exec('alter table messages disable trigger xelay_private_guard_message')
      try { await db.query("insert into messages(conversation_id,sender_id,recipient_id,body,created_at) select $1,$2,$3,'Synthetic history',now()-interval '2 minutes' from generate_series(1,999)",[conversation,owner,recipient]) }
      finally { await db.exec('alter table messages enable trigger xelay_private_guard_message') }
      await direct(owner,conversation); await rejects(direct(owner,conversation),'DIRECT_MESSAGE_RATE_LIMIT')
      const targets=[]
      for(let i=0;i<31;i++){ const id=randomUUID(); await fx.seedUser(id); targets.push(id) }
      await db.exec('alter table connection_requests disable trigger xelay_private_guard_connection_request')
      try { await db.query("insert into connection_requests(requester_id,recipient_id,created_at,updated_at) select $1,id,now()-interval '11 minutes',now()-interval '11 minutes' from unnest($2::uuid[]) id",[owner,targets.slice(0,29)]) }
      finally { await db.exec('alter table connection_requests enable trigger xelay_private_guard_connection_request') }
      await asUser(owner,'select send_connection_request($1)',[targets[29]])
      await rejects(asUser(owner,'select send_connection_request($1)',[targets[30]]),'CONNECTION_REQUEST_RATE_LIMIT')
    })
    await t.test('cancel quotas count only an effective cancellation and keep failed headers unchanged', async () => {
      const owner=randomUUID(); await fx.seedUser(owner)
      await db.query('insert into chat_join_requests(space_id,user_id) values($1,$2)',[space,owner])
      await db.query('insert into private_chat_cancel_events(owner_id) select $1 from generate_series(1,9)',[owner])
      await asUser(owner,'select xelay_chat_cancel_request($1)',[space])
      await db.query("update chat_join_requests set status='pending' where space_id=$1 and user_id=$2",[space,owner])
      const before=first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at
      await rejects(asUser(owner,'select xelay_chat_cancel_request($1)',[space]),'CHAT_RATE_LIMIT')
      assert.deepEqual(first(await db.query('select updated_at from chat_spaces where id=$1',[space])).updated_at,before)
      await db.query('delete from private_chat_cancel_events where owner_id=$1',[owner])
      await db.query("insert into private_chat_cancel_events(owner_id,cancelled_at) select $1,now()-interval '11 minutes' from generate_series(1,49)",[owner])
      await asUser(owner,'select xelay_chat_cancel_request($1)',[space])
      await db.query("update chat_join_requests set status='pending' where space_id=$1 and user_id=$2",[space,owner])
      await rejects(asUser(owner,'select xelay_chat_cancel_request($1)',[space]),'CHAT_RATE_LIMIT')
      assert.equal(first(await db.query('select count(*)::int as count from private_chat_cancel_events where owner_id=$1',[owner])).count,50)
    })
    await t.test('detached-file count includes reservations and total object count includes attached files', async () => {
      const owner=randomUUID(), recipient=randomUUID(); await fx.seedUser(owner); await fx.seedUser(recipient)
      const conversation=await conv(owner,recipient)
      await db.exec('alter table storage.objects disable trigger xelay_private_guard_storage_upload')
      try { await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) select 'xelay-message-media',$1||'/'||$2||'/'||gen_random_uuid()||'/file.png',$2,jsonb_build_object('size',1,'mimetype','image/png') from generate_series(1,99)",[conversation,owner]) }
      finally { await db.exec('alter table storage.objects enable trigger xelay_private_guard_storage_upload') }
      await reserve(owner,'xelay-message-media',`${conversation}/${owner}/${randomUUID()}/last-reservation.png`)
      await rejects(reserve(owner,'xelay-message-media',`${conversation}/${owner}/${randomUUID()}/too-many.png`),'PRIVATE_MEDIA_QUOTA')
      const totalOwner=randomUUID(), totalRecipient=randomUUID(); await fx.seedUser(totalOwner); await fx.seedUser(totalRecipient)
      const totalConversation=await conv(totalOwner,totalRecipient)
      await db.exec('alter table messages disable trigger xelay_private_guard_message; alter table storage.objects disable trigger xelay_private_guard_storage_upload; alter table message_attachments disable trigger user')
      try {
        await db.query("insert into messages(conversation_id,sender_id,recipient_id,body,created_at) select $1,$2,$3,'Synthetic attachments',now()-interval '2 minutes' from generate_series(1,200)",[totalConversation,totalOwner,totalRecipient])
        await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) select 'xelay-message-media',m.conversation_id||'/'||m.sender_id||'/'||m.id||'/'||n||'.png',m.sender_id,jsonb_build_object('size',1,'mimetype','image/png') from messages m cross join generate_series(1,5) n where m.conversation_id=$1",[totalConversation])
        await db.query("insert into message_attachments(message_id,conversation_id,uploaded_by,storage_path,file_name,media_type,mime_type,file_size) select split_part(name,'/',3)::uuid,$1::uuid,$2::uuid,name,'file.png','image','image/png',1 from storage.objects where owner_id=$2::text",[totalConversation,totalOwner])
      } finally { await db.exec('alter table messages enable trigger xelay_private_guard_message; alter table storage.objects enable trigger xelay_private_guard_storage_upload; alter table message_attachments enable trigger user') }
      await rejects(reserve(totalOwner,'xelay-message-media',`${totalConversation}/${totalOwner}/${randomUUID()}/object-limit.png`),'PRIVATE_MEDIA_QUOTA')
      const path=first(await db.query('select storage_path from message_attachments where uploaded_by=$1 limit 1',[totalOwner])).storage_path
      await db.query('delete from message_attachments where storage_path=$1',[path]); await asUser(totalOwner,'delete from storage.objects where name=$1',[path])
      await upload(totalOwner,'xelay-message-media',`${totalConversation}/${totalOwner}/${randomUUID()}/last-object.png`,1)
      assert.equal(first(await db.query('select count(*)::int as count from storage.objects where owner_id=$1',[totalOwner])).count,1000)
    })
    await t.test('avatar replacement and deleted/edited article covers have narrow actual-owner cleanup receipts', async () => {
      const owner=randomUUID(), admin=randomUUID(); await fx.seedUser(owner); await fx.seedUser(admin)
      await db.query("insert into participant_entitlements(user_id,source,valid_from,valid_until) values($1,'admin_grant',now()-interval '1 day',now()+interval '1 year')",[owner])
      const avatar=`${owner}/${randomUUID()}/avatar.png`; await upload(owner,'xelay-chat-media',avatar)
      const group=first(await asUser(owner,"select xelay_chat_create('group','private','Cleanup group',null,'',$1,true,false,true) as id",[avatar])).id
      await db.query("insert into chat_members(space_id,user_id,status,role) values($1,$2,'active','admin')",[group,admin])
      await asUser(admin,'select xelay_chat_update($1,$2::jsonb)',[group,JSON.stringify({avatar_path:null})])
      const row=first(await db.query('select owner_id,cleanup_user_id from private_media_cleanup where storage_path=$1',[avatar]))
      assert.equal(row.owner_id,owner); assert.equal(row.cleanup_user_id,admin)
      await asUser(owner,"select xelay_chat_member($1,$2,'ban')",[group,admin])
      assert.equal((await asUser(admin,'delete from storage.objects where name=$1 returning id',[avatar])).rows.length,1)
      const cover=`${owner}/${randomUUID()}/cover.png`; await upload(owner,'xelay-chat-media',cover)
      const article=first(await asUser(owner,"select xelay_chat_publish('article',$1::jsonb,$2) as value",[JSON.stringify({title:'Article',body:'Article content',cover_path:cover}),group])).value
      await asUser(owner,'select xelay_chat_article_edit($1,$2,$3,null)',[article.id,'Edited article','Retained article content'])
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup where storage_path=$1',[cover])).count,1)
      assert.equal((await asUser(owner,'delete from storage.objects where name=$1 returning id',[cover])).rows.length,1)
      await db.query("update chat_members set status='active',role='admin' where space_id=$1 and user_id=$2",[group,admin])
      const second=`${owner}/${randomUUID()}/cover.png`; await upload(owner,'xelay-chat-media',second)
      const deleted=first(await asUser(owner,"select xelay_chat_publish('article',$1::jsonb,$2) as value",[JSON.stringify({title:'Delete article',body:'Deleted content',cover_path:second}),group])).value
      await asUser(admin,'select xelay_chat_delete_post($1)',[deleted.post_id])
      assert.equal(first(await db.query('select cleanup_user_id from private_media_cleanup where storage_path=$1',[second])).cleanup_user_id,admin)
      assert.equal((await asUser(admin,'delete from storage.objects where name=$1 returning id',[second])).rows.length,1)
    })
    await t.test('upload rate survives deletion/reupload, and quota checks are server-side', async () => {
      for(let i=0;i<30;i++){ const path=`${ef}/${ids.e}/${randomUUID()}/file.png`; await upload(ids.e,'xelay-message-media',path); await asUser(ids.e,'delete from storage.objects where name=$1',[path]) }
      await rejects(upload(ids.e,'xelay-message-media',`${ef}/${ids.e}/${randomUUID()}/limit.png`),'PRIVATE_MEDIA_UPLOAD_RATE_LIMIT')
      await db.query("update private_media_upload_events set uploaded_at=now()-interval '2 minutes' where owner_id=$1",[ids.e])
      // Only fixture seeding bypasses the upload trigger; every assertion uses the enabled guard.
      await db.exec('alter table storage.objects disable trigger xelay_private_guard_storage_upload')
      try {
        await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) select 'xelay-message-media',$1||'/'||$2||'/'||gen_random_uuid()||'/file.png',$2,jsonb_build_object('size',26214400,'mimetype','image/png') from generate_series(1,39)",[ef,ids.e])
        await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,jsonb_build_object('size',25165824,'mimetype','image/png'))",[`${ef}/${ids.e}/${randomUUID()}/seed.png`,ids.e])
      } finally { await db.exec('alter table storage.objects enable trigger xelay_private_guard_storage_upload') }
      await upload(ids.e,'xelay-message-media',`${ef}/${ids.e}/${randomUUID()}/boundary.png`,25*1024*1024)
      await rejects(upload(ids.e,'xelay-message-media',`${ef}/${ids.e}/${randomUUID()}/quota.png`,1),'PRIVATE_MEDIA_QUOTA')
      await db.query("insert into private_media_upload_events(owner_id,uploaded_at) select $1,now()-interval '2 minutes' from generate_series(1,200)",[ids.f])
      await rejects(upload(ids.f,'xelay-message-media',`${ef}/${ids.f}/${randomUUID()}/daily.png`),'PRIVATE_MEDIA_UPLOAD_RATE_LIMIT')
    })
    await t.test('Storage permission rollback retains the reservation; trusted final upload validates the real owner', async () => {
      const owner=randomUUID(), recipient=randomUUID(); await fx.seedUser(owner); await fx.seedUser(recipient)
      const conversation=await conv(owner,recipient), path=`${conversation}/${owner}/${randomUUID()}/preflight.png`
      await reserve(owner,'xelay-message-media',path); await reserve(owner,'xelay-message-media',path)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_upload_events where owner_id=$1',[owner])).count,1)
      await db.exec('begin')
      await asUser(owner,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb) returning id",[path,owner,JSON.stringify({mimetype:'image/png',contentLength:10})])
      await db.exec('rollback')
      assert.equal(first(await db.query('select count(*)::int as count from storage.objects where name=$1',[path])).count,0)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_upload_reservations where storage_path=$1',[path])).count,1)
      await rejects(asUser(null,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[path,recipient,JSON.stringify({size:10,mimetype:'image/png'})],{role:'service_role'}),'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
      await asUser(null,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[path,owner,JSON.stringify({size:10,mimetype:'image/png'})],{role:'service_role'})
      assert.equal(first(await db.query('select count(*)::int as count from private_media_upload_reservations where storage_path=$1',[path])).count,0)
      await rejects(asUser(owner,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[`${conversation}/${owner}/${randomUUID()}/unreserved.png`,owner,JSON.stringify({size:10,mimetype:'image/png'})]),'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
      const pending=`${conversation}/${owner}/${randomUUID()}/placeholder.png`
      await reserve(owner,'xelay-message-media',pending)
      await asUser(owner,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[pending,owner,JSON.stringify({mimetype:'image/png',contentLength:10})])
      await asUser(null,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb) on conflict(bucket_id,name) do update set metadata=excluded.metadata,owner_id=excluded.owner_id",[pending,owner,JSON.stringify({size:25*1024*1024,mimetype:'image/png'})],{role:'service_role'})
      assert.equal(first(await db.query('select count(*)::int as count from private_media_upload_reservations where storage_path=$1',[pending])).count,0)
      await rejects(asUser(null,"update storage.objects set metadata=jsonb_build_object('size',26214401,'mimetype','image/png') where name=$1",[pending],{role:'service_role'}),'PRIVATE_MEDIA_INVALID')
      const expired=`${conversation}/${owner}/${randomUUID()}/expired.png`; await reserve(owner,'xelay-message-media',expired)
      await db.query("update private_media_upload_reservations set expires_at=now()-interval '1 second' where storage_path=$1",[expired])
      await rejects(asUser(null,"insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-message-media',$1,$2,$3::jsonb)",[expired,owner,JSON.stringify({size:10,mimetype:'image/png'})],{role:'service_role'}),'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
    })
    await t.test('cleanup worker claims exact identity, age and version; attached files win after a claim', async () => {
      await db.exec('alter table storage.objects add column version text')
      const owner=randomUUID(), recipient=randomUUID(); await fx.seedUser(owner); await fx.seedUser(recipient)
      const conversation=await conv(owner,recipient)
      const claim=(path,id)=>asUser(null,"select xelay_private_media_cleanup_claim('xelay-message-media',$1,$2) as value",[path,id],{role:'service_role'})
      const age=(path)=>db.query("update storage.objects set created_at=now()-interval '2 days',updated_at=now()-interval '2 days',version='v1' where name=$1",[path])
      const path=`${conversation}/${owner}/${randomUUID()}/cleanup.png`, id=await upload(owner,'xelay-message-media',path)
      assert.equal(first(await claim(path,id)).value,false); await age(path)
      await rejects(asUser(null,'delete from storage.objects where name=$1',[path],{role:'service_role'}),'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      assert.equal(first(await claim(path,id)).value,true)
      await db.query("update storage.objects set version='v2' where name=$1",[path])
      await rejects(asUser(null,'delete from storage.objects where name=$1',[path],{role:'service_role'}),'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      assert.equal(first(await claim(path,id)).value,true)
      await db.query('update storage.objects set updated_at=now() where name=$1',[path])
      await rejects(asUser(null,'delete from storage.objects where name=$1',[path],{role:'service_role'}),'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      assert.equal(first(await claim(path,id)).value,false)
      await age(path); assert.equal(first(await claim(path,id)).value,true)
      assert.equal((await asUser(null,'delete from storage.objects where name=$1 returning id',[path],{role:'service_role'})).rows.length,1)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup_claims where storage_path=$1',[path])).count,0)
      const replacement=await upload(owner,'xelay-message-media',path); assert.notEqual(replacement,id)
      await rejects(asUser(null,'delete from storage.objects where name=$1',[path],{role:'service_role'}),'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      assert.equal(first(await claim(path,id)).value,false)
      const message=randomUUID(), attached=`${conversation}/${owner}/${message}/attached.png`, attachedId=await upload(owner,'xelay-message-media',attached)
      await age(attached); assert.equal(first(await claim(attached,attachedId)).value,true)
      await direct(owner,conversation,message,[media(attached)])
      await rejects(asUser(null,'delete from storage.objects where name=$1',[attached],{role:'service_role'}),'PRIVATE_MEDIA_IN_USE')
      assert.equal(first(await claim(attached,attachedId)).value,false)
      const candidates=first(await asUser(null,"select xelay_private_media_cleanup_candidates(now()-interval '1 day',100) as value",[],{role:'service_role'})).value
      assert.ok(candidates.every((row)=>row.name&&row.bucket_id&&row.object_id)); assert.ok(!candidates.some((row)=>row.name===attached))
    })
    await t.test('expired accounting maintenance is bounded and service-only', async () => {
      await db.query("insert into private_media_upload_events(owner_id,uploaded_at) select $1,now()-interval '8 days' from generate_series(1,1001)",[ids.a])
      await rejects(asUser(ids.a,'select xelay_private_media_maintenance()'),'permission denied')
      await asUser(null,'select xelay_private_media_maintenance()',[],{role:'service_role'})
      assert.equal(first(await db.query("select count(*)::int as count from private_media_upload_events where uploaded_at<now()-interval '7 days'")).count,1)
      await asUser(null,'select xelay_private_media_maintenance()',[],{role:'service_role'})
      assert.equal(first(await db.query("select count(*)::int as count from private_media_upload_events where uploaded_at<now()-interval '7 days'")).count,0)
    })
    await t.test('seminar stale receipts are consumed/invalidate on new versions; acknowledgements are idempotent', async () => {
      const path=`${randomUUID()}/${ids.a}/${randomUUID()}-file.pdf`
      await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-seminar-files',$1,$2,$3::jsonb)",[path,ids.a,JSON.stringify({size:10,mimetype:'application/pdf'})])
      await db.query('insert into study_group_seminar_file_cleanup(storage_path,cleanup_user_id,owner_id) values($1,$2,$3)',[path,ids.b,ids.a])
      await db.query("delete from storage.objects where bucket_id='xelay-seminar-files' and name=$1",[path])
      assert.equal(first(await db.query('select count(*)::int as count from study_group_seminar_file_cleanup where storage_path=$1',[path])).count,0)
      await asUser(ids.b,'select xelay_ack_seminar_file_cleanup($1)',[path])
      await db.query('insert into study_group_seminar_file_cleanup(storage_path,cleanup_user_id,owner_id) values($1,$2,$3)',[path,ids.b,ids.a])
      await db.query("insert into storage.objects(bucket_id,name,owner_id,metadata) values('xelay-seminar-files',$1,$2,$3::jsonb)",[path,ids.a,JSON.stringify({size:10,mimetype:'application/pdf'})])
      assert.equal(first(await db.query('select count(*)::int as count from study_group_seminar_file_cleanup where storage_path=$1',[path])).count,0)
      assert.equal((await asUser(ids.b,'select id from storage.objects where name=$1',[path])).rows.length,0)
    })
    await t.test('client ACLs remain narrow; anonymous private reads are empty', async () => {
      await rejects(asUser(ids.a,'select xelay_private_object_owner($1::jsonb)',['{}']),'permission denied')
      await rejects(asUser(ids.a,'select xelay_chat_activate($1,$2)',[space,ids.b]),'permission denied')
      assert.equal((await asUser(null,"select id from storage.objects where bucket_id in('xelay-message-media','xelay-chat-media')",[],{role:'anon'})).rows.length,0)
      const candidates=first(await asUser(null,"select xelay_private_media_cleanup_candidates(now()-interval '1 day',100) as value",[],{role:'service_role'})).value
      assert.ok(Array.isArray(candidates)); assert.ok(candidates.length<=100)
    })
  } finally { await fx.close() }
})
