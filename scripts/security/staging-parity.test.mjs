// Sanitized schema-only legacy reconstruction. Never contacts a Supabase project.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const parity=await readFile(new URL('../../supabase/setup/security_staging_legacy_parity.sql',import.meta.url),'utf8')
const first=(result)=>result.rows[0]
const denied=(work,code='42501')=>assert.rejects(work,(error)=>error.code===code)
const legacyTables=['answer_discussions','answer_likes','answer_translations','badge_notifications',
  'question_comments','question_likes','question_translations','user_badges']

test('sanitized legacy parity, ordinary triggers and complete migration chain',async(t)=>{
  const fx=await createFixture({useStagingParity:true})
  const {db,asUser,seedUser}=fx
  const a=randomUUID(),b=randomUUID()
  let question,answer
  try {
    await seedUser(a,{username:'parity_owner'});await seedUser(b,{username:'parity_member'})
    await t.test('legacy types, exact nullability, indexes and protected bootstrap order',async()=>{
      const rows=(await db.query(`select table_name,column_name,data_type,is_nullable from information_schema.columns
        where table_schema='public' and table_name=any($1::text[])`,[['profiles','notifications','questions','answers',
          'question_images','answer_images','xelay_users',...legacyTables]])).rows
      const column=(table,name)=>rows.find((r)=>r.table_name===table&&r.column_name===name)
      for(const table of legacyTables)assert.ok(column(table,'id'),table)
      for(const name of ['recipient_id','actor_id','actor_name','type','message'])assert.equal(column('notifications',name).is_nullable,'NO')
      for(const name of ['question_id','answer_id'])assert.equal(column('notifications',name).data_type,'uuid')
      for(const table of ['question_images','answer_images'])assert.equal(column(table,'image_url').is_nullable,'NO')
      for(const name of ['faculty','specialty','skills','help_with','want_to_learn'])assert.equal(column('profiles',name).is_nullable,'NO')
      assert.equal(column('profiles','email').is_nullable,'YES')
      for(const name of ['user_id','name','email','country','experience','categories','rating','created_at'])assert.equal(column('xelay_users',name).is_nullable,'NO')
      assert.equal(first(await db.query(`select count(*)::int as count from pg_indexes where schemaname='public'
        and indexname=any($1::text[])`,[['answer_likes_unique','user_badges_unique','question_comments_question_created_idx','xelay_users_user_id_idx']])).count,4)
      // Migration006 intentionally removes the legacy profile email cache UNIQUE.
      assert.equal(first(await db.query("select count(*)::int as count from pg_constraint where conrelid='profiles'::regclass and conname='profiles_email_key'")).count,0)
      assert.equal(first(await db.query("select count(*)::int as count from pg_default_acl where defaclnamespace='public'::regnamespace and defaclobjtype='r'")).count,0)
      await assert.rejects(db.exec(parity),/set xelay.security_staging=true/)
      await db.exec('rollback')
      await db.exec("set xelay.security_staging='true'")
      await assert.rejects(db.exec(parity),/BEFORE repository migrations/)
      await db.exec('rollback;reset xelay.security_staging')
      assert.ok(!/create\s+(?:or\s+replace\s+)?(?:schema|table|function)\s+(?:auth|storage)\./i.test(parity))
      assert.ok(!/execute\s+(?:function|procedure)\s+(?:net\.|supabase_functions\.|http_request)/i.test(parity))
    })
    await t.test('authenticated answer triggers recount a different author question through migration004',async()=>{
      question=first(await asUser(a,"insert into questions(user_id,title,content,category) values($1,'Parity question','Question content','IT') returning id",[a])).id
      answer=first(await asUser(b,"insert into answers(question_id,user_id,content) values($1,$2,'Parity answer') returning id",[question,b])).id
      assert.equal(first(await asUser(a,'select answers_count from questions where id=$1',[question])).answers_count,1)
      const notifications=(await asUser(a,"select * from notifications where type='answer' and question_id=$1::uuid",[question])).rows
      assert.equal(notifications.length,1)
      await asUser(a,'update questions set views=99,likes=99,answers_count=99 where id=$1',[question]).then(
        ()=>assert.fail('Client counters must be protected'),(error)=>assert.equal(error.code,'42501'))
      await asUser(null,'select increment_profile_rating($1)',[b],{role:'service_role'})
      assert.equal(first(await asUser(b,'select rating from profiles where id=$1',[b])).rating,1)
    })
    await t.test('ordinary discussion/comment/like permissions and plain DB notification are functional',async()=>{
      const discussion=first(await asUser(a,"insert into answer_discussions(answer_id,user_id,text) values($1,$2,'A discussion') returning id",[answer,a])).id
      await asUser(a,"update answer_discussions set text='Edited discussion' where id=$1",[discussion])
      assert.equal((await asUser(null,'select id from answer_discussions where id=$1',[discussion],{role:'anon'})).rows.length,1)
      await denied(asUser(a,'update answer_discussions set user_id=$1 where id=$2',[b,discussion]))
      await denied(asUser(a,'insert into answer_discussions(answer_id,user_id,text) values($1,$2,$3)',[answer,b,'Forged author']))
      assert.equal((await asUser(b,'delete from answer_discussions where id=$1 returning id',[discussion])).rows.length,0)
      const comment=first(await asUser(b,"insert into question_comments(question_id,user_id,body) values($1,$2,'A question comment') returning id",[question,b])).id
      assert.ok(comment)
      assert.equal((await asUser(a,"select id from notifications where type='question_comment' and question_id=$1::uuid",[question])).rows.length,1)
      await asUser(a,"insert into question_comments(question_id,user_id,body) values($1,$2,'Own question comment')",[question,a])
      assert.equal((await asUser(a,"select id from notifications where type='question_comment' and question_id=$1::uuid",[question])).rows.length,1)
      await asUser(a,'insert into question_likes(question_id,user_id) values($1,$2)',[question,a])
      await asUser(a,'insert into answer_likes(answer_id,user_id) values($1,$2)',[answer,a])
      await denied(asUser(a,'insert into question_likes(question_id,user_id) values($1,$2)',[question,b]))
      await denied(asUser(a,'insert into answer_likes(answer_id,user_id) values($1,$2)',[answer,b]))
      await denied(asUser(a,'insert into answer_likes(answer_id,user_id) values($1,$2)',[answer,a]),'23505')
      await denied(asUser(null,"insert into question_translations(question_id,language,translated_text) values($1,'en','forged')",[question],{role:'anon'}))
    })
    await t.test('non-UUID legacy question IDs and missing profile recipients preserve comments',async()=>{
      const oldQuestion=first(await asUser(a,"insert into questions(id,user_id,title,content,category) values('legacy-question-id',$1,'Old question','Historical body','IT') returning id",[a])).id
      await asUser(b,"insert into question_comments(question_id,user_id,body) values($1,$2,'Legacy comment')",[oldQuestion,b])
      const unlinked=(await asUser(a,"select * from notifications where type='question_comment' and question_id is null")).rows
      assert.equal(unlinked.length,1);assert.equal(unlinked[0].actor_id,b)
      await denied(asUser(null,'select id from notifications',[],{role:'anon'}))
      assert.equal((await asUser(b,"select id from notifications where type='question_comment' and question_id is null")).rows.length,0)
      const missingOwnerQuestion=first(await asUser(null,"insert into questions(user_id,title,content,category) values('retired-legacy-author','Orphan owner','Retained old question','IT') returning id",[],{role:'service_role'})).id
      await asUser(b,"insert into question_comments(question_id,user_id,body) values($1,$2,'No recipient remains')",[missingOwnerQuestion,b])
      assert.equal(first(await db.query("select count(*)::int as count from question_comments where question_id=$1",[missingOwnerQuestion])).count,1)
      assert.equal(first(await db.query("select count(*)::int as count from notifications where type='question_comment' and question_id=$1::uuid",[missingOwnerQuestion])).count,0)
      assert.equal(first(await db.query("select has_function_privilege('authenticated','public.xelay_notify_question_comment()','EXECUTE') as allowed")).allowed,false)
      assert.equal(first(await db.query("select has_function_privilege('anon','public.xelay_notify_question_comment()','EXECUTE') as allowed")).allowed,false)
      assert.equal(first(await db.query("select has_function_privilege('service_role','public.xelay_notify_question_comment()','EXECUTE') as allowed")).allowed,false)
    })
    await t.test('legacy badge helpers remain service-only and produce unique awards',async()=>{
      for(const [name,type,argument] of [['award_pioneer_badge','uuid',a],['check_user_badges','uuid',a],['check_expert_badge','text',a]]) {
        await denied(asUser(a,`select ${name}($1::${type})`,[argument]))
        await denied(asUser(null,`select ${name}($1::${type})`,[argument],{role:'anon'}))
        await asUser(null,`select ${name}($1::${type})`,[argument],{role:'service_role'})
      }
      await asUser(null,'select award_pioneer_badge($1)',[a],{role:'service_role'})
      assert.equal((await asUser(null,"select id from user_badges where user_id=$1 and badge_type='pioneer'",[a],{role:'anon'})).rows.length,1)
      await denied(asUser(a,"insert into user_badges(user_id,badge_type) values($1,'authority')",[a]))
      await asUser(null,"insert into badge_notifications(user_id,badge_type) values($1,'pioneer'),($2,'pioneer')",[a,b],{role:'service_role'})
      assert.equal((await asUser(a,'select id from badge_notifications')).rows.length,1)
      await asUser(a,'update badge_notifications set is_seen=true where user_id=$1',[a])
      await denied(asUser(a,"update badge_notifications set badge_type='authority' where user_id=$1",[a]))
    })
    await t.test('legacy definer ancestry cannot authorize new client score changes, cleanup remains compatible',async()=>{
      // This synthetic helper represents a future reward integration, not an
      // observed production trigger. Migration006 intentionally rejects it.
      await db.exec(`create function public.fixture_legacy_score(p_id uuid) returns void language sql security definer
        set search_path='' as $$update public.profiles set rating=coalesce(rating,0)+1 where id=p_id$$;
        grant execute on function public.fixture_legacy_score(uuid) to authenticated;`)
      await assert.rejects(asUser(a,'select fixture_legacy_score($1)',[a]),/PROFILE_SCORES_SERVER_OWNED/)
      await assert.rejects(asUser(a,'select fixture_legacy_score($1)',[b]),/PROFILE_OWNER_REQUIRED/)
      await asUser(a,"update profiles set bio='Profile edit after answer' where id=$1",[a])
      await asUser(b,'select xelay_delete_own_answer($1)',[answer])
      assert.equal(first(await asUser(a,'select answers_count from questions where id=$1',[question])).answers_count,0)
      assert.equal((await asUser(a,'select id from answer_discussions where answer_id=$1',[answer])).rows.length,0)
      await asUser(a,'select xelay_delete_own_question($1)',[question])
      assert.equal((await asUser(a,'select id from question_comments where question_id=$1',[question])).rows.length,0)
      assert.equal((await asUser(a,'select id from notifications where question_id=$1::uuid',[question])).rows.length,0)
    })
  } finally {await fx.close()}
})

test('exact legacy comment notification bug is reproduced through009 and repaired by010',async()=>{
  const fx=await createFixture({useStagingParity:true,through:'202610030009'})
  try {
    const a=randomUUID(),b=randomUUID()
    await fx.seedUser(a,{username:'before_fix_owner'});await fx.seedUser(b,{username:'before_fix_member'})
    const question=first(await fx.asUser(a,"insert into questions(user_id,title,content,category) values($1,'Before fix','Question body','IT') returning id",[a])).id
    await denied(fx.asUser(b,"insert into question_comments(question_id,user_id,body) values($1,$2,'Would fail legacy trigger')",[question,b]),'42804')
    assert.equal(first(await fx.db.query('select count(*)::int as count from question_comments')).count,0)
    await fx.db.exec(await readFile(new URL('../../supabase/migrations/202610030010_question_comment_notifications.sql',import.meta.url),'utf8'))
    await fx.asUser(b,"insert into question_comments(question_id,user_id,body) values($1,$2,'Comment after fix')",[question,b])
    assert.equal((await fx.asUser(a,"select id from notifications where type='question_comment' and question_id=$1::uuid",[question])).rows.length,1)
    // Migration replacement is safe to retry and does not duplicate triggers.
    await fx.db.exec(await readFile(new URL('../../supabase/migrations/202610030010_question_comment_notifications.sql',import.meta.url),'utf8'))
    assert.equal(first(await fx.db.query("select count(*)::int as count from pg_trigger where tgrelid='question_comments'::regclass and tgname='question_comment_notification'")).count,1)
  } finally {await fx.close()}
})
