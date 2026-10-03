// The prepared hosted SQL only consumes existing human Auth IDs. These tests
// create synthetic accounts exclusively inside the isolated PostgreSQL fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'
const seedSQL=await readFile(new URL('../../supabase/setup/security_staging_media_fixture.sql',import.meta.url),'utf8')
const first=(result)=>result.rows[0]

test('prepared staging media fixture uses confirmed accounts and real user RPCs without global roles',async(t)=>{
  const fx=await createFixture({useStagingParity:true})
  const {db,asUser}=fx,ids=[randomUUID(),randomUUID(),randomUUID()],run=randomUUID()
  const names=['a','b','c'].map((label)=>`security_media_${label}_${run.slice(0,8)}`)
  const emails=['a','b','c'].map((label)=>`security_media_${label}_${run.replaceAll('-','')}@example.test`)
  const configure=async(ref='saufzpryybuawudohhwj')=>{
    await db.query("select set_config('xelay.security_staging','true',false),set_config('xelay.security_test_project',$1,false)",[ref])
    await db.query("select set_config('xelay.security_media_run_id',$1,false)",[run])
    for(let i=0;i<3;i++)await db.query('select set_config($1,$2,false)',[`xelay.security_media_user_${'abc'[i]}`,ids[i]])
  }
  const refusal=async(pattern)=>{
    await assert.rejects(db.exec(seedSQL),pattern)
    await db.exec('rollback')
    assert.equal(first(await db.query('select count(*)::int n from conversations')).n,0)
    assert.equal(first(await db.query("select count(*)::int n from chat_spaces where kind='group'")).n,0)
  }
  try {
    await db.exec("alter table auth.users add column raw_app_meta_data jsonb default '{}'")
    await db.exec('alter table auth.users disable trigger user')
    try {for(let i=0;i<3;i++)await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
      values($1,$2,now(),$3,$4)`,[ids[i],emails[i],{xelay_security_fixture:'media-v1',xelay_security_run_id:run,
        xelay_security_label:'ABC'[i]},{username:names[i],full_name:`Synthetic media ${'ABC'[i]}`}])}
    finally {await db.exec('alter table auth.users enable trigger user')}
    await t.test('no confirmation, wrong project, unconfirmed user and mismatched username fail before writes',async()=>{
      await refusal(/staging confirmation required/)
      await configure('baohfpadxvhqhhjjqtil');await refusal(/staging confirmation required/)
      await configure();await db.query('update auth.users set email_confirmed_at=null where id=$1',[ids[1]])
      await refusal(/exact owned run metadata required/)
      await db.query('update auth.users set email_confirmed_at=now() where id=$1',[ids[1]])
      await db.query("update auth.users set raw_user_meta_data=jsonb_set(raw_user_meta_data,'{username}','\"different_staging_user\"') where id=$1",[ids[2]])
      await refusal(/exact owned run metadata required/)
      await db.query("update auth.users set raw_user_meta_data=jsonb_set(raw_user_meta_data,'{username}',to_jsonb($1::text)) where id=$2",[names[2],ids[2]])
    })
    await t.test('atomic fixture commits A+B connection/private membership and C is denied',async()=>{
      await configure()
      const before=first(await db.query(`select (select count(*)::int from auth.users) users,
        (select count(*)::int from user_roles) roles,(select count(*)::int from auth.mfa_factors) factors,
        (select count(*)::int from storage.objects) objects`))
      await db.exec("set request.jwt.claims='{}'")
      const results=await db.exec(seedSQL)
      const row=results.flatMap((entry)=>entry.rows).find((row)=>row.security_media_fixture)
      const result=row?.security_media_fixture,checks=row?.fixture_assertions
      assert.ok(result);assert.equal(result.projectRef,'saufzpryybuawudohhwj');assert.equal(result.runId,run)
      assert.deepEqual(Object.keys(result).sort(),['mode','projectRef','origin','runId','conversationId','chatSpaceId'].sort())
      assert.equal(checks.a_owner_b_member,true);assert.equal(checks.c_outsider_read_denied,true)
      assert.equal(checks.auth_or_global_role_mutation,false);assert.equal(checks.storage_mutation,false)
      const after=first(await db.query(`select (select count(*)::int from auth.users) users,
        (select count(*)::int from user_roles) roles,(select count(*)::int from auth.mfa_factors) factors,
        (select count(*)::int from storage.objects) objects`))
      assert.deepEqual(after,before)
      assert.equal(first(await db.query("select current_setting('role') role,current_setting('request.jwt.claims') claims")).role,'none')
      assert.equal(first(await db.query("select current_setting('request.jwt.claims') claims")).claims,'{}')
      for(const id of ids.slice(0,2)){
        assert.equal((await asUser(id,'select id from conversations where id=$1',[result.conversationId])).rows.length,1)
        assert.equal((await asUser(id,'select id from chat_spaces where id=$1',[result.chatSpaceId])).rows.length,1)
      }
      for(const table of ['conversations','chat_spaces'])assert.equal((await asUser(ids[2],`select id from ${table} where id=$1`,
        [table==='conversations'?result.conversationId:result.chatSpaceId])).rows.length,0)
      assert.equal(first(await db.query('select count(*)::int n from messages')).n,0)
      assert.equal(first(await db.query('select count(*)::int n from chat_posts')).n,0)
      // A prepared second call cannot silently reuse or multiply containers.
      await configure()
      await assert.rejects(db.exec(seedSQL),/existing containers are never reused/)
      await db.exec('rollback')
      assert.equal(first(await db.query('select count(*)::int n from conversations')).n,1)
      assert.equal(first(await db.query("select count(*)::int n from chat_spaces where kind='group'")).n,1)
    })
  } finally {await fx.close()}
})
