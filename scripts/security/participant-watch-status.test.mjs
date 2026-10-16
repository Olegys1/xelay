import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import vm from 'node:vm'
import ts from 'typescript'
const read=name=>readFile(new URL('../../'+name,import.meta.url),'utf8')
const module={exports:{}};vm.runInNewContext(ts.transpileModule(await read('src/lib/participantStatus.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports})
const catalog=module.exports,token='sticker:green-watch'
test('green watch is one static premium sticker with the existing ownership and three-token guards',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  const paid='00000000-0000-4000-8000-000000000001',free='00000000-0000-4000-8000-000000000002'
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    create table premium_preferences(user_id uuid primary key,status_text text,emoji_status text,updated_at timestamptz default now());
    alter table premium_preferences enable row level security;
    create function xelay_has_participant_access(uuid) returns boolean language sql stable as $$select $1='${paid}'::uuid$$;
    create function xelay_set_participant_status(text,text) returns void language sql as $$select$$;
    revoke all on function xelay_set_participant_status(text,text) from public,anon,service_role;
    grant execute on function xelay_set_participant_status(text,text) to authenticated;`)
  for(const file of ['202610140005_participant_cheburashka_status.sql','202610160004_participant_animal_statuses.sql','202610160006_participant_penguin_status.sql'])await db.exec(await read('supabase/migrations/'+file))
  const definition=async()=>(await db.query("select pg_get_functiondef('xelay_set_participant_status(text,text)'::regprocedure) as v")).rows[0].v
  const contract=async()=>(await db.query("select proacl::text,proowner::text,proconfig,prosecdef from pg_proc where oid='xelay_set_participant_status(text,text)'::regprocedure")).rows[0]
  const before=await definition(),oldContract=await contract()
  const migration=await read('supabase/migrations/202610170003_participant_green_watch_status.sql');await db.exec(migration)
  const after=await definition()
  assert.equal(after,before.replace("'sticker:penguin'];","'sticker:penguin','sticker:green-watch'];"));assert.deepEqual(await contract(),oldContract)
  const allowed=[...after.match(/v_allowed text\[\] := array\[([^;]+)\];/)[1].matchAll(/'([^']+)'/g)].map(x=>x[1])
  assert.deepEqual(new Set(allowed),new Set(catalog.PARTICIPANT_STATUS_EMOJIS))
  assert.equal(catalog.PARTICIPANT_STATUS_EMOJIS.filter(x=>x===token).length,1)
  assert.match(catalog.participantStatusEmojiLabel(token),/Золотий годинник/)
  const save=async(uid,value,text='Годинник')=>{await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);try{return await db.query('select xelay_set_participant_status($1,$2)',[text,value])}finally{await db.exec('reset role')}}
  for(const value of [token,`${token} 😊`,`${token} sticker:penguin ❤️`]){await save(paid,value);assert.equal((await db.query('select emoji_status from premium_preferences where user_id=$1',[paid])).rows[0].emoji_status,value)}
  for(const value of [`${token} ${token}`,`${token} 😊 ❤️ 🦛`,'sticker:watch','sticker:Green-watch',`${token}\n😊`])await assert.rejects(save(paid,value),/INVALID_PARTICIPANT_STATUS_EMOJI/)
  await assert.rejects(save(free,token),/PARTICIPANT_REQUIRED/);await assert.rejects(save('',token),/PARTICIPANT_REQUIRED/)
  await assert.rejects(save(paid,token,'x'.repeat(49)),/INVALID_PARTICIPANT_STATUS_TEXT/)
  const rows=(await db.query('select * from premium_preferences')).rows;await db.exec(migration);assert.deepEqual((await db.query('select * from premium_preferences')).rows,rows);assert.equal(await definition(),after)
  for(const role of ['anon','authenticated','service_role']){
    const row=(await db.query("select has_function_privilege($1,'xelay_set_participant_status(text,text)','execute') as execute,has_table_privilege($1,'premium_preferences','insert,update,delete') as direct_write",[role])).rows[0]
    assert.deepEqual(row,{execute:role==='authenticated',direct_write:false})
  }
  await save(paid,null,null);assert.equal((await db.query('select emoji_status from premium_preferences where user_id=$1',[paid])).rows[0].emoji_status,null)
})
test('watch renderer selects the compact transparent asset, static fallback and existing picker sizes',async()=>{
  const source=await read('src/components/ParticipantStatusEmoji.tsx')
  assert.match(source,/green-watch-20261017\.png/);assert.match(source,/isWatch \? watchStatusImage/);assert.match(source,/isWatch \? '⌚'/)
  assert.match(source,/const size = picker \? 32 : 24/)
  const png=await readFile(new URL('../../src/assets/status/green-watch-20261017.png',import.meta.url))
  assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),128);assert.equal(png.readUInt32BE(20),128)
  assert.equal(png[25],6);assert.ok(png.length<35000)
})
