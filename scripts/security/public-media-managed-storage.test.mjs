// Local role model, never connects to Supabase. A managed Storage table allows
// TRIGGER/DML to its installer without transferring ownership or index rights.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

test('008 only skips an optional Storage index under a nonowner installer; cleanup ACL and guard remain active',async()=>{
  const fixture=await createFixture({through:'202610030007'})
  const {db,asUser,seedUser}=fixture
  const A='00000000-0000-4000-8000-000000000079'
  try {
    await seedUser(A)
    // Hosted postgres is an administrative BYPASSRLS role, but does not own
    // managed Storage. BYPASSRLS is separate from CREATE INDEX permission.
    await db.exec(`create role fixture_managed_installer bypassrls;
      grant usage,create on schema public to fixture_managed_installer;
      grant usage on schema auth,storage to fixture_managed_installer;
      grant all on all tables in schema public to fixture_managed_installer;
      grant all on all sequences in schema public to fixture_managed_installer;
      grant execute on all functions in schema public,auth,storage to fixture_managed_installer;
      grant select,insert,update,delete,trigger on storage.objects to fixture_managed_installer;
      set role fixture_managed_installer`)
    // Reproduce the actual hosted failure before exercising the narrow catch.
    await assert.rejects(()=>db.exec('create index fixture_forbidden_storage_index on storage.objects(created_at)'),error=>error.code==='42501')
    const migration=await readFile(new URL('../../supabase/migrations/202610030008_security_public_media_cleanup.sql',import.meta.url),'utf8')
    await db.exec(migration)
    await db.exec('reset role')
    assert.equal((await db.query("select count(*)::int n from pg_indexes where schemaname='storage' and indexname='xelay_public_media_cleanup_scan_idx'")).rows[0].n,0)
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.public_media_cleanup_claims'::regclass")).rows[0].relrowsecurity,true)
    assert.equal((await db.query("select has_function_privilege('service_role','public.xelay_public_media_cleanup_candidates(timestamptz,integer)','execute') allowed")).rows[0].allowed,true)
    assert.equal((await db.query("select has_function_privilege('authenticated','public.xelay_public_media_cleanup_candidates(timestamptz,integer)','execute') allowed")).rows[0].allowed,false)
    await assert.rejects(()=>asUser(A,'select xelay_public_media_cleanup_candidates()'),error=>error.code==='42501')
    const orphan=(await db.query(`insert into storage.objects(bucket_id,name,owner_id,metadata,created_at,updated_at)
      values('answer-media',$1,$2,'{"size":100,"mimetype":"image/png"}',now()-interval '2 days',now()-interval '2 days') returning id`,
      [`${A}/answers/managed-storage.png`,A])).rows[0]
    const service=(sql,params=[])=>asUser(null,sql,params,{role:'service_role'})
    const listed=(await service('select xelay_public_media_cleanup_candidates() items')).rows[0].items
    assert.ok(listed.some(item=>item.object_id===orphan.id))
    await assert.rejects(()=>service('delete from storage.objects where id=$1',[orphan.id]),error=>error.code==='42501')
    assert.equal((await service('select xelay_public_media_cleanup_claim($1,$2,$3) claimed',
      ['answer-media',`${A}/answers/managed-storage.png`,orphan.id])).rows[0].claimed,true)
    assert.equal((await service('delete from storage.objects where id=$1 returning id',[orphan.id])).rows.length,1)
  } finally {await db.exec('reset role');await fixture.close()}
})
