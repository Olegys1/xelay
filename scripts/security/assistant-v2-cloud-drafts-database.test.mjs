// Execute the exact migration against one in-memory PostgreSQL instance.
// Synthetic accounts/documents only: no environment keys, network or live DB.
// PGlite has one connection, so Promise.all checks queued contenders/restarts,
// not a proof of independent PostgreSQL backend scheduling or load capacity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createCloudDraftRepository } from '../../server/assistant-v2/cloudDraftRepository.ts'

const migration = await readFile(new URL('../../supabase/migrations/202610310002_assistant_cloud_drafts.sql', import.meta.url), 'utf8')
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const owner = id(1), other = id(2), hash = 'a'.repeat(64), differentHash = 'b'.repeat(64)
const digest = value => createHash('sha256').update(value).digest('hex')
const code = expected => error => error.code === expected
const draft = (value, patch = {}) => ({ id: id(value), action: 'homework.upsert', scope: { groupId: id(80), lessonId: id(81) },
  payload: { text: 'Synthetic homework', title: 'Check draft' }, recordId: id(82),
  fingerprint: 'fixture-version', plan: { table: 'fixture_only', values: { text: 'Synthetic homework' } },
  title: 'Homework draft', fields: [], items: [], targetSummary: 'Synthetic group', ...patch })
const document = value => { const { id: ignored, ...rest } = value; return rest }
const signatures = [
  'xelay_assistant_cloud_draft_create(uuid,uuid,jsonb,text)',
  'xelay_assistant_cloud_draft_replace(uuid,uuid,integer,text,jsonb,text)',
  'xelay_assistant_cloud_draft_cancel(uuid,uuid,integer,text)',
  'xelay_assistant_cloud_draft_get(uuid,uuid)',
  'xelay_assistant_cloud_draft_list(uuid,integer)',
  'xelay_assistant_cloud_draft_claim(uuid,uuid,integer,text,text)',
  'xelay_assistant_cloud_draft_finish(uuid,uuid,text,text,jsonb)',
]

test('cloud confirmation journal is private, durable and conservative before any business write', { timeout: 120000 }, async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.role() to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
    create table public.profiles(id uuid primary key);
    insert into auth.users(id,email_confirmed_at) values('${owner}',now()),('${other}',now()),('${id(3)}',now());
    insert into public.profiles select id from auth.users;
  `)
  await db.exec(migration)
  const rows = async (sql, values = []) => (await db.query(sql, values)).rows
  const asRole = async (role, operation, claim = role) => {
    await db.exec(`set role ${role}`)
    await db.query("select set_config('request.jwt.claim.role',$1,false)", [claim])
    try { return await operation() } finally { await db.exec("reset role; select set_config('request.jwt.claim.role','',false)") }
  }
  const rawRpc = async (name, values) => (await rows(`select public.${name}(${values.map((_, index) => '$' + (index + 1)).join(',')}) result`, values))[0].result
  const rpc = (name, values) => asRole('service_role', () => rawRpc('xelay_assistant_cloud_draft_' + name, values))
  const create = (value = 101, user = owner, doc = document(draft(value))) => rpc('create', [user, id(value), doc, hash])
  const claim = (value = 101, user = owner, version = 1, confirmation = hash, nonce = differentHash) => rpc('claim', [user, id(value), version, confirmation, nonce])
  const finish = (value = 101, user = owner, nonce = differentHash, outcome = 'confirmed', receipt = { action: 'homework.upsert', savedId: id(82) }) => rpc('finish', [user, id(value), nonce, outcome, receipt])
  const reset = async () => {
    await db.exec('truncate public.assistant_cloud_drafts; update auth.users set email_confirmed_at=now(),deleted_at=null,banned_until=null; insert into public.profiles select id from auth.users on conflict do nothing')
  }
  // Serialize session-level SET ROLE for the single PGlite connection. SQL row
  // locking, ownership and status predicates are still the real migration code.
  let sessionQueue = Promise.resolve()
  const client = { rpc(name, args) {
    const execute = () => asRole('service_role', async () => {
      try { return { data: await rawRpc(name, Object.values(args)), error: null } }
      catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
    })
    const result = sessionQueue.then(execute, execute)
    sessionQueue = result.then(() => undefined, () => undefined)
    return result
  } }
  const repository = () => createCloudDraftRepository({ client, confirmationSecret: 'synthetic-local-confirmation-secret-123456789' })

  await t.test('installation grants no browser access and service role can only call narrow RPCs', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const permissions = (await rows("select has_table_privilege($1,'public.assistant_cloud_drafts','select') r,has_table_privilege($1,'public.assistant_cloud_drafts','insert') i,has_table_privilege($1,'public.assistant_cloud_drafts','update') u,has_table_privilege($1,'public.assistant_cloud_drafts','delete') d", [role]))[0]
      assert.deepEqual(permissions, { r: false, i: false, u: false, d: false })
      for (const signature of signatures) assert.equal((await rows('select has_function_privilege($1,$2,\'execute\') allowed', [role, 'public.' + signature]))[0].allowed, role === 'service_role')
      for (const helper of ['xelay_assistant_draft_service(uuid,boolean)', 'xelay_assistant_draft_document_valid(jsonb)', 'xelay_assistant_draft_envelope(public.assistant_cloud_drafts)']) {
        assert.equal((await rows('select has_function_privilege($1,$2,\'execute\') allowed', [role, 'public.' + helper]))[0].allowed, false)
      }
      await assert.rejects(asRole(role, () => db.query('select * from assistant_cloud_drafts')), code('42501'))
    }
    assert.equal((await rows("select relrowsecurity from pg_class where oid='public.assistant_cloud_drafts'::regclass"))[0].relrowsecurity, true)
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(role, () => rawRpc('xelay_assistant_cloud_draft_create', [owner, id(101), document(draft(101)), hash])), code('42501'))
      await assert.rejects(asRole(role, () => db.exec('delete from assistant_cloud_drafts')), code('42501'))
    }
    await assert.rejects(asRole('authenticated', () => rawRpc('xelay_assistant_cloud_draft_get', [owner, id(101)]), 'service_role'), code('42501'))
    await assert.rejects(asRole('service_role', () => rawRpc('xelay_assistant_cloud_draft_get', [owner, id(101)]), 'authenticated'), code('42501'))
  })

  await t.test('requires a real active confirmed profile before accepting or retrieving a draft', async () => {
    await reset()
    await create()
    for (const change of ['email_confirmed_at=null', 'deleted_at=now()', "banned_until=now()+interval'1 hour'"]) {
      await db.exec(`update auth.users set ${change} where id='${owner}'`)
      for (const operation of [() => create(102), () => rpc('get', [owner, id(101)]), () => rpc('list', [owner, 30]), () => claim()]) await assert.rejects(operation(), code('42501'))
      await db.exec('update auth.users set email_confirmed_at=now(),deleted_at=null,banned_until=null')
    }
    await db.query('delete from profiles where id=$1', [owner])
    await assert.rejects(create(102), code('42501'))
    await assert.rejects(create(102, id(99)), code('42501'))
    assert.equal((await rows('select count(*)::int n from assistant_cloud_drafts'))[0].n, 1)
  })

  await t.test('creates idempotently with bounded expiry and never returns stored hashes or credentials', async () => {
    await reset()
    const first = await create()
    assert.equal(first.status, 'pending'); assert.equal(first.revision, 1)
    assert.equal(Date.parse(first.expiresAt) - Date.parse(first.createdAt), 15 * 60 * 1000)
    assert.deepEqual(await create(), first)
    assert.equal(first.confirmation_hash, undefined); assert.equal(first.claim_hash, undefined)
    assert.equal(first.confirmationToken, undefined); assert.equal(first.claimToken, undefined)
    assert.deepEqual(first.document, document(draft(101)))
    await assert.rejects(create(101, other), code('PT409'))
    await assert.rejects(create(101, owner, document(draft(101, { payload: { text: 'Changed' } }))), code('PT409'))
    await assert.rejects(rpc('create', [owner, id(101), document(draft(101)), differentHash]), code('PT409'))
    assert.equal((await rows('select count(*)::int n from assistant_cloud_drafts'))[0].n, 1)
  })

  await t.test('edits bind owner, token and version; rotate confirmation without extending deadline or changing target', async () => {
    await reset()
    const first = await create()
    const changed = document(draft(101, { payload: { title: 'Reviewed', text: 'Edited' } }))
    await assert.rejects(rpc('replace', [other, id(101), 1, hash, changed, differentHash]), code('PT404'))
    await assert.rejects(rpc('replace', [owner, id(101), 2, hash, changed, differentHash]), code('PT409'))
    await assert.rejects(rpc('replace', [owner, id(101), 1, differentHash, changed, differentHash]), code('PT409'))
    for (const patch of [{ action: 'schedule.create' }, { scope: { groupId: id(88) } }, { recordId: id(83) }]) {
      await assert.rejects(rpc('replace', [owner, id(101), 1, hash, { ...changed, ...patch }, differentHash]), code('PT409'))
    }
    const replaced = await rpc('replace', [owner, id(101), 1, hash, changed, differentHash])
    assert.equal(replaced.revision, 2); assert.equal(replaced.expiresAt, first.expiresAt)
    assert.deepEqual(replaced.document.payload, changed.payload)
    await assert.rejects(claim(), code('PT409'))
    await assert.rejects(claim(101, owner, 2, hash), code('PT409'))
    assert.equal((await claim(101, owner, 2, differentHash)).claimed, true)
    await assert.rejects(rpc('replace', [owner, id(101), 2, differentHash, changed, hash]), code('PT409'))
  })

  await t.test('list/get/cancel cannot expose or change another account; cancel is terminal and repeatable', async () => {
    await reset()
    await create(); await create(102); await create(201, other)
    assert.deepEqual((await rpc('list', [owner, 1])).map(row => row.id), [id(102)])
    assert.deepEqual((await rpc('list', [other, 30])).map(row => row.id), [id(201)])
    for (const name of ['get', 'cancel']) await assert.rejects(rpc(name, [other, id(101), ...(name === 'cancel' ? [1, hash] : [])]), code('PT404'))
    for (const limit of [0, 101, null]) await assert.rejects(rpc('list', [owner, limit]), code('22023'))
    await assert.rejects(rpc('cancel', [owner, id(101), 1, differentHash]), code('PT409'))
    const cancelled = await rpc('cancel', [owner, id(101), 1, hash])
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(await rpc('cancel', [owner, id(101), 1, hash]), cancelled)
    await assert.rejects(claim(), code('PT409'))
    await assert.rejects(finish(), code('PT404'))
  })

  await t.test('one claim is consumed before effects and completion requires the opaque claim hash', async () => {
    await reset(); await create()
    await assert.rejects(claim(101, other), code('PT404'))
    await assert.rejects(claim(101, owner, 1, differentHash), code('PT409'))
    await assert.rejects(finish(), code('PT404'))
    const first = await claim()
    assert.equal(first.claimed, true); assert.equal(first.record.status, 'committing')
    const repeated = await claim(101, owner, 1, hash, 'c'.repeat(64))
    assert.equal(repeated.claimed, false); assert.equal(repeated.record.status, 'committing')
    assert.equal(repeated.claim_hash, undefined); assert.equal(repeated.record.claim_hash, undefined)
    await assert.rejects(finish(101, other), code('PT404'))
    await assert.rejects(finish(101, owner, 'c'.repeat(64)), code('PT404'))
    const completed = await finish()
    assert.equal(completed.status, 'confirmed'); assert.equal(completed.receipt.savedId, id(82))
    assert.deepEqual(await finish(), completed)
    await assert.rejects(finish(101, owner, differentHash, 'unknown', null), code('PT409'))
    await assert.rejects(finish(101, owner, differentHash, 'confirmed', { savedId: id(83) }), code('PT409'))
    assert.equal((await claim()).claimed, false)
  })

  await t.test('expiry, server restart and unknown outcome cannot accidentally authorize replay', async () => {
    await reset(); await create(); await create(102)
    await db.query("update assistant_cloud_drafts set created_at=clock_timestamp()-interval'20 minutes',expires_at=clock_timestamp()-interval'5 minutes' where id=$1", [id(101)])
    await assert.rejects(claim(), code('PT409'))
    await assert.rejects(rpc('replace', [owner, id(101), 1, hash, document(draft(101)), differentHash]), code('PT409'))
    assert.equal((await claim(102)).claimed, true)
    await db.query("update assistant_cloud_drafts set created_at=clock_timestamp()-interval'20 minutes',expires_at=clock_timestamp()-interval'5 minutes' where id=$1", [id(102)])
    // Rerunning additive migration simulates a fresh server against durable rows.
    await db.exec(migration)
    assert.equal((await claim(102)).claimed, false)
    assert.equal((await finish(102, owner, differentHash, 'unknown', null)).status, 'unknown')
    assert.equal((await claim(102)).claimed, false)
    await assert.rejects(finish(102), code('PT409'))
    assert.equal((await rpc('get', [owner, id(102)])).status, 'unknown')
  })

  await t.test('revocation blocks new claims but can record a previously attempted result', async () => {
    await reset(); await create(); await create(102); await claim()
    await db.query("update auth.users set banned_until=clock_timestamp()+interval'1 day' where id=$1", [owner])
    await assert.rejects(claim(102), code('42501'))
    assert.equal((await finish()).status, 'confirmed')
    await assert.rejects(rpc('get', [owner, id(101)]), code('42501'))
  })

  await t.test('failed/rolled back journal transactions leave no half-created or half-claimed state', async () => {
    await reset(); await create()
    await db.exec('begin')
    await asRole('service_role', () => rawRpc('xelay_assistant_cloud_draft_claim', [owner, id(101), 1, hash, differentHash]))
    await db.exec('rollback')
    assert.equal((await rpc('get', [owner, id(101)])).status, 'pending')
    assert.equal((await claim()).claimed, true)
    await assert.rejects(rpc('replace', [owner, id(101), 1, hash, document(draft(101)), differentHash]), code('PT409'))
    assert.equal((await rows('select status,claim_hash from assistant_cloud_drafts where id=$1', [id(101)]))[0].claim_hash, differentHash)
    // This is why the server awaits claim RPC commit before calling business RPC.
  })

  await t.test('per-owner active pending cap is shared and expired/cancelled drafts stay terminal', async () => {
    await reset()
    for (let index = 1; index <= 20; index++) await create(300 + index)
    await assert.rejects(create(321), code('PT429'))
    assert.equal((await create(401, other)).status, 'pending')
    await rpc('cancel', [owner, id(301), 1, hash]); await create(321)
    await db.query("update assistant_cloud_drafts set created_at=clock_timestamp()-interval'20 minutes',expires_at=clock_timestamp()-interval'5 minutes' where id=$1", [id(302)])
    await create(322)
    await assert.rejects(create(323), code('PT429'))
    await assert.rejects(claim(301), code('PT409')); await assert.rejects(claim(302), code('PT409'))
  })

  await t.test('SQL rejects unsupported documents, reserved envelope fields, secrets and oversized receipts', async () => {
    await reset()
    const base = document(draft(101))
    for (const bad of [null, [], {}, { ...base, action: 'arbitrary.sql' }, { ...base, scope: [] }, { ...base, payload: null },
      { ...base, id: id(101) }, { ...base, status: 'confirmed' }, { ...base, payload: { access_token: 'never-store-this' } },
      { ...base, plan: { Authorization: 'never-store-this' } }, { ...base, payload: { text: 'x'.repeat(180001) } }]) {
      await assert.rejects(create(101, owner, bad), code('22023'))
    }
    for (const badHash of [null, '../bad', 'A'.repeat(64)]) await assert.rejects(rpc('create', [owner, id(101), base, badHash]), code('22023'))
    await create(); await claim()
    for (const receipt of [null, [], { access_token: 'never-store-this' }, { nested: { cookie: 'never-store-this' } }, { text: 'x'.repeat(12001) }]) await assert.rejects(finish(101, owner, differentHash, 'confirmed', receipt), code('22023'))
    await assert.rejects(finish(101, owner, differentHash, 'unknown', {}), code('22023'))
    assert.equal((await rpc('get', [owner, id(101)])).status, 'committing')
  })

  await t.test('repository reconstructs stable tokens after restart while DB stores only hashes', async () => {
    await reset()
    const first = await repository().create(owner, draft(501))
    assert.equal(repository().mode, 'supabase-service-journal')
    assert.match(first.confirmationToken, /^[a-f0-9]{48}$/)
    assert.deepEqual(await repository().get(owner, first.id), first)
    assert.deepEqual(await repository().list(owner), [first])
    const stored = (await rows('select document,confirmation_hash,claim_hash from assistant_cloud_drafts where id=$1', [first.id]))[0]
    assert.equal(stored.confirmation_hash, digest(first.confirmationToken)); assert.equal(stored.claim_hash, null)
    assert.equal(JSON.stringify(stored).includes(first.confirmationToken), false)
    const changed = await repository().replace(owner, first.id, first.revision, first.confirmationToken, draft(501, { payload: { text: 'Revised' } }))
    assert.equal(changed.revision, 2); assert.notEqual(changed.confirmationToken, first.confirmationToken)
    assert.equal(changed.expiresAt, first.expiresAt)
    await assert.rejects(repository().claim(owner, first.id, 1, first.confirmationToken), code('draft_changed'))
    await assert.rejects(repository().get(other, first.id), code('draft_not_found'))
    const cancelled = await repository().cancel(owner, changed.id, 2, changed.confirmationToken)
    assert.equal(cancelled.status, 'cancelled')
  })

  await t.test('queued cross-instance contenders return one opaque claim and cannot redispatch after confirmation', async () => {
    await reset()
    const first = await repository().create(owner, draft(601))
    const results = await Promise.all(Array.from({ length: 8 }, () => repository().claim(owner, first.id, 1, first.confirmationToken)))
    const winners = results.filter(result => result.claimed)
    assert.equal(winners.length, 1); assert.match(winners[0].claimToken, /^[a-f0-9]{48}$/)
    assert.ok(results.filter(result => !result.claimed).every(result => !('claimToken' in result)))
    const stored = (await rows('select claim_hash,document from assistant_cloud_drafts where id=$1', [first.id]))[0]
    assert.equal(stored.claim_hash, digest(winners[0].claimToken))
    assert.equal(JSON.stringify(stored).includes(winners[0].claimToken), false)
    await assert.rejects(repository().finish(owner, first.id, 'f'.repeat(48), 'confirmed', { id: id(82) }), code('draft_not_found'))
    assert.equal((await repository().finish(owner, first.id, winners[0].claimToken, 'confirmed', { id: id(82) })).status, 'confirmed')
    assert.equal((await repository().claim(owner, first.id, 1, first.confirmationToken)).claimed, false)
    assert.equal((await repository().get(owner, first.id)).receipt.id, id(82))
  })

  await t.test('repository validates before RPC and exposes no provider messages or raw errors', async () => {
    let calls = 0
    const fake = { rpc: async () => { calls++; return { data: null, error: { code: 'XX000', message: 'PRIVATE_DATABASE_DETAIL' } } } }
    const repo = createCloudDraftRepository({ client: fake, confirmationSecret: 'synthetic-local-confirmation-secret-123456789' })
    await assert.rejects(repo.create(owner, draft(701, { payload: { refresh_token: 'SECRET' } })), code('invalid_payload'))
    await assert.rejects(repo.claim(owner, id(701), 1, '💣'.repeat(48)), code('confirmation_required'))
    await assert.rejects(repo.claim(owner, id(701), 1, 'A'.repeat(48)), code('confirmation_required'))
    await assert.rejects(repo.get('not-a-uuid', id(701)), code('invalid_identifier'))
    await assert.rejects(repo.list(owner, 101), code('invalid_request'))
    assert.equal(calls, 0)
    await assert.rejects(repo.get(owner, id(701)), error => error.code === 'cloud_draft_unavailable' && !JSON.stringify(error).includes('PRIVATE_DATABASE_DETAIL') && !error.message.includes('PRIVATE_DATABASE_DETAIL'))
    assert.equal(calls, 1)
    assert.throws(() => createCloudDraftRepository({ client: fake, confirmationSecret: 'short' }), /private_cloud_draft_dependencies_required/)
    const unavailable = createCloudDraftRepository({ client: { rpc: async () => { throw new Error('PRIVATE_AUTH_VALUE') } }, confirmationSecret: 'synthetic-local-confirmation-secret-123456789' })
    await assert.rejects(unavailable.get(owner, id(701)), error => error.code === 'cloud_draft_unavailable' && !error.message.includes('PRIVATE_AUTH_VALUE'))
    const malformed = createCloudDraftRepository({ client: { rpc: async () => ({ data: { userId: other }, error: null }) }, confirmationSecret: 'synthetic-local-confirmation-secret-123456789' })
    await assert.rejects(malformed.get(owner, id(701)))
  })
})
