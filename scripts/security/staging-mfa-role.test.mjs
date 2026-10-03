// Operator SQL executed only inside the isolated managed-platform fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'
import { buildStagingInstall } from './build-staging-install.mjs'
import { syntheticIdentity } from './test1-auth-fixtures.mjs'
import { validateMfaRoleSeed } from './test1-mfa-probe.mjs'
const seedSQL=await readFile(new URL('../../supabase/setup/security_staging_mfa_role_seed.sql',import.meta.url),'utf8')
const cleanupSQL=await readFile(new URL('../../supabase/setup/security_staging_mfa_role_cleanup.sql',import.meta.url),'utf8')
const first=(result)=>result.rows[0]
const resultJSON=(results,name)=>results.flatMap(result=>result.rows).find(row=>row[name])?.[name]

test('prepared UI role SQL changes only the exact owned synthetic ADMIN tuple and keeps ACLs',async()=>{
  const fx=await createFixture({useStagingBaseline:true,setupOnly:true})
  const {db,asUser,seedUser}=fx
  const runId=randomUUID(),user=randomUUID(),human=randomUUID(),probeId=randomUUID(),roleId=randomUUID()
  const identity=syntheticIdentity(runId,'A')
  const configure=async({who=user,time}={})=>{
    for(const [key,value] of Object.entries({security_staging:'true',security_test_project:'saufzpryybuawudohhwj',
      security_media_run_id:runId,security_media_user_a:who,security_mfa_probe_id:probeId,security_mfa_role_id:roleId,
      ...(time?{security_mfa_role_granted_at:time}:{})}))await db.query('select set_config($1,$2,false)',[`xelay.${key}`,value])
  }
  const rejected=async(sql,pattern)=>{await assert.rejects(db.exec(sql),pattern);await db.exec('rollback')}
  try {
    await db.exec("alter table auth.users add column raw_app_meta_data jsonb default '{}';alter table auth.mfa_factors add column friendly_name text")
    // This exact operator artifact belongs to the hosted through015/manifest45
    // session; its target guard must not be weakened by later product features.
    const bundle=await buildStagingInstall({includeSupplement:true,migrationsThrough:'202610030015_private_storage_error_compatibility.sql'});assert.equal(bundle.manifest.length,45)
    await db.exec(bundle.sql)
    await seedUser(user,{email:identity.email,username:identity.username});await seedUser(human,{username:'independent_human'})
    await db.query('update auth.users set raw_app_meta_data=$1,raw_user_meta_data=$2 where id=$3',[
      {xelay_security_fixture:'media-v1',xelay_security_run_id:runId,xelay_security_label:'A'},
      {username:identity.username,full_name:'Synthetic media A'},user])
    await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[human])
    const before=first(await db.query(`select (select count(*)::int from auth.users) users,
      (select count(*)::int from profiles) profiles,(select count(*)::int from auth.mfa_factors) factors,
      (select count(*)::int from storage.objects) objects,has_table_privilege('service_role','user_roles','INSERT') ins,
      has_table_privilege('service_role','user_roles','DELETE') del`))
    await rejected(seedSQL,/confirmation/)
    await configure({who:human});await rejected(seedSQL,/owned synthetic A/)
    await configure()
    const seeded=resultJSON(await db.exec(seedSQL),'security_mfa_role_seed')
    assert.equal(seeded.adminRoleId,roleId);assert.equal(seeded.userId,user);assert.equal(seeded.initialRoleBaselineEmpty,true)
    validateMfaRoleSeed(seeded,{runId},{id:user})
    const own=(await asUser(user,'select id,user_id,role from user_roles')).rows
    assert.equal(own.length,1);assert.equal(own[0].id,roleId)
    const after=first(await db.query(`select (select count(*)::int from auth.users) users,
      (select count(*)::int from profiles) profiles,(select count(*)::int from auth.mfa_factors) factors,
      (select count(*)::int from storage.objects) objects,has_table_privilege('service_role','user_roles','INSERT') ins,
      has_table_privilege('service_role','user_roles','DELETE') del`))
    assert.deepEqual(after,before)
    await configure();await rejected(seedSQL,/empty initial role and factor/)
    await configure({time:new Date(Date.parse(seeded.role.granted_at)+1000).toISOString()})
    await rejected(cleanupSQL,/exact owned seed tuple/)
    assert.equal(first(await db.query('select count(*)::int n from user_roles where id=$1',[roleId])).n,1)
    await configure({who:human,time:seeded.role.granted_at});await rejected(cleanupSQL,/owned synthetic A/)
    // If service factor cleanup failed, UI deletion still removes ADMIN and
    // reports only the remaining exact factor; it never deletes Auth rows.
    await db.query("insert into auth.mfa_factors(user_id,status,friendly_name) values($1,'verified',$2)",[user,`security_media_mfa_${probeId}`])
    await configure({time:seeded.role.granted_at})
    const cleaned=resultJSON(await db.exec(cleanupSQL),'security_mfa_role_cleanup')
    assert.equal(cleaned.roleDeleted,1);assert.equal(cleaned.exactRoleAbsent,true);assert.equal(cleaned.initialRoleBaselineRestored,true)
    assert.equal(cleaned.remainingExactMfaFactors,1)
    assert.equal(first(await db.query('select count(*)::int n from user_roles where user_id=$1',[human])).n,1)
    assert.equal(first(await db.query('select count(*)::int n from auth.mfa_factors where user_id=$1',[user])).n,1)
    await configure({time:seeded.role.granted_at})
    const repeated=resultJSON(await db.exec(cleanupSQL),'security_mfa_role_cleanup')
    assert.equal(repeated.roleDeleted,0);assert.equal(repeated.exactRoleAbsent,true)
  }finally{await fx.close()}
})
