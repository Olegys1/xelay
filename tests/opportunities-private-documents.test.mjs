import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { opportunitiesFixture } from './helpers/opportunitiesFixture.mjs'

test('organization proof uses live identity, MFA and authenticated Storage operations', { timeout: 120000 }, async t => {
  const fx = await opportunitiesFixture(); t.after(() => fx.close())
  const { db, ids } = fx
  await db.exec(`
    create table auth.sessions(id uuid primary key,user_id uuid,aal text,not_after timestamptz);
    create or replace function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object(
      'aal',current_setting('request.jwt.claim.aal',true),'session_id',current_setting('request.jwt.claim.session_id',true))$$;
    create function storage.allow_any_operation(operations text[]) returns boolean language sql stable as $$
      select coalesce(regexp_replace(current_setting('storage.operation',true),'^storage\\.','')=any(
        array(select regexp_replace(o,'^storage\\.','') from unnest(operations) o)),false)$$;
    alter table storage.objects enable row level security;
    grant select,delete on storage.objects to anon,authenticated;
  `)
  await db.exec(await readFile(new URL('../supabase/migrations/20261118214310_opportunities_private_documents.sql', import.meta.url), 'utf8'))
  const sessions = Object.fromEntries(Object.keys(ids).map(k => [k, randomUUID()]))
  for (const key of Object.keys(ids)) await db.query('insert into auth.sessions values($1,$2,$3,null)', [sessions[key], ids[key], key === 'admin' ? 'aal2' : 'aal1'])
  const id = randomUUID(), path = `${ids.company}/company/${id}.pdf`
  const file = { id, path, ownerId: ids.company, kind: 'company', name: 'proof.pdf', size: 1148, mime: 'application/pdf' }
  await db.query('insert into opportunities_files(id,owner_id,path,kind,data)values($1,$2,$3,$4,$5)', [id, ids.company, path, 'company', JSON.stringify(file)])
  await db.query('insert into storage.objects(id,bucket_id,name,owner)values($1,$2,$3,$4)', [id, 'opportunities-private', path, ids.company])
  async function request(who, operation, sql, args = [], { session = sessions[who] || '', aal = who === 'admin' ? 'aal2' : 'aal1' } = {}) {
    await db.exec('begin')
    try {
      const role = who ? 'authenticated' : 'anon'
      await db.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true),
        set_config('request.jwt.claim.aal',$3,true),set_config('request.jwt.claim.session_id',$4,true),set_config('storage.operation',$5,true)`, [ids[who] || '', role, aal, session, operation])
      await db.exec('set local role ' + role)
      const result = await db.query(sql, args); await db.exec('commit'); return result.rows
    } catch (e) { await db.exec('rollback'); throw e }
  }
  const rows = (who, op = 'storage.object.get_authenticated', options) => request(who, op, 'select id from storage.objects where id=$1', [id], options)
  const metadata = (who, options) => request(who, '', 'select xelay_opportunities_document_access($1) data', [id], options)
  await t.test('owner and MFA administrator can open, anonymous and other accounts cannot', async () => {
    for (const who of ['company', 'admin']) { assert.equal((await rows(who)).length, 1); assert.deepEqual((await metadata(who))[0].data, file) }
    for (const who of [null, 'student', 'stranger', 'school', 'editor']) {
      assert.equal((await rows(who)).length, 0)
      await assert.rejects(metadata(who), e => e.code === '42501')
    }
  })
  await t.test('cannot mint transferable signed URLs, copy or enumerate proofs, even with another permissive policy', async () => {
    await db.exec('create policy synthetic_permissive on storage.objects for select to authenticated using(true)')
    for (const who of ['company', 'admin', 'stranger']) for (const op of ['storage.object.sign', 'storage.object.sign_many', 'storage.object.copy', 'storage.object.list', 'storage.object.list_v2', 's3.get_object', '']) assert.equal((await rows(who, op)).length, 0, `${who} ${op}`)
    assert.equal((await rows('stranger')).length, 0)
    await db.exec('drop policy synthetic_permissive on storage.objects')
  })
  await t.test('revoked, missing, forged and expired sessions fail on the next open', async () => {
    for (const session of ['', randomUUID(), sessions.school]) {
      assert.equal((await rows('company', undefined, { session })).length, 0)
      await assert.rejects(metadata('company', { session }), /NOT_FOUND/)
    }
    await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1", [sessions.company])
    assert.equal((await rows('company')).length, 0); await assert.rejects(metadata('company'), /NOT_FOUND/)
    await db.query('update auth.sessions set not_after=null where id=$1', [sessions.company])
    await db.query('delete from auth.sessions where id=$1', [sessions.company])
    assert.equal((await rows('company')).length, 0)
    await db.query("insert into auth.sessions values($1,$2,'aal1',null)", [sessions.company, ids.company])
  })
  await t.test('admin role, verified factor, JWT aal2 and current session aal2 must all agree', async () => {
    assert.equal((await rows('admin', undefined, { aal: 'aal1' })).length, 0)
    await assert.rejects(metadata('admin', { aal: 'aal1' }), /NOT_FOUND/)
    await db.query("update auth.sessions set aal='aal1' where id=$1", [sessions.admin])
    assert.equal((await rows('admin')).length, 0); await assert.rejects(metadata('admin'), /NOT_FOUND/)
    await db.query("update auth.sessions set aal='aal2' where id=$1", [sessions.admin])
    await db.query("update auth.mfa_factors set status='unverified' where user_id=$1", [ids.admin])
    assert.equal((await rows('admin')).length, 0)
    await db.query("update auth.mfa_factors set status='verified' where user_id=$1", [ids.admin])
    await db.query('delete from user_roles where user_id=$1', [ids.admin])
    assert.equal((await rows('admin')).length, 0)
    await db.query("insert into user_roles values($1,'ADMIN')", [ids.admin])
  })
  await t.test('account confirmation, bans and deletion are checked again', async () => {
    for (const assignment of ["banned_until=now()+interval '1 hour'", 'email_confirmed_at=null', 'deleted_at=now()']) {
      await db.query('update auth.users set ' + assignment + ' where id=$1', [ids.company])
      assert.equal((await rows('company')).length, 0); await assert.rejects(metadata('company'), /NOT_FOUND/)
      await db.query('update auth.users set banned_until=null,deleted_at=null,email_confirmed_at=now() where id=$1', [ids.company])
    }
  })
  await t.test('registered unattached proof cleanup and saved company proof remain functional', async () => {
    assert.equal((await rows('company', 'storage.object.delete')).length, 1)
    const company = fx.organization(); company.verificationFile = file
    await fx.rpc(ids.company, { type: 'company.save', company })
    assert.deepEqual((await fx.load(ids.company)).companies.find(c => c.id === company.id).verificationFile, file)
    assert.equal((await request('company', 'storage.object.delete', 'delete from storage.objects where id=$1 returning id', [id])).length, 0, 'attached proof cannot be deleted')
    assert.equal((await rows('company')).length, 1)
  })
  await t.test('other attachment types keep signing and are not accepted by proof metadata RPC', async () => {
    for (const kind of ['resume', 'opportunity']) {
      const otherId = randomUUID(), otherPath = `${ids.company}/${kind}/${otherId}.pdf`
      await db.query('insert into opportunities_files(id,owner_id,path,kind,data)values($1,$2,$3,$4,$5)', [otherId, ids.company, otherPath, kind, JSON.stringify({ ...file, id: otherId, path: otherPath, kind })])
      await db.query('insert into storage.objects(id,bucket_id,name,owner)values($1,$2,$3,$4)', [otherId, 'opportunities-private', otherPath, ids.company])
      assert.equal((await request('company', 'storage.object.sign', 'select id from storage.objects where id=$1', [otherId])).length, 1)
      await assert.rejects(request('company', '', 'select xelay_opportunities_document_access($1)', [otherId]), /NOT_FOUND/)
    }
    await assert.rejects(request('company', '', 'select xelay_opportunities_document_access($1)', [randomUUID()]), /NOT_FOUND/)
  })
})
