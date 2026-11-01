// Real HTTP boundary + cloud service + repository + exact journal SQL, with
// only the user/RLS business transport faked. No network or real account keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createCloudDraftRepository } from '../../server/assistant-v2/cloudDraftRepository.ts'
import { createCloudConfirmedAssistantWrites } from '../../server/assistant-v2/cloudWrites.ts'
import { createAssistantCloudHandler } from '../../server/assistant-v2/cloudHandler.ts'

const migration = await readFile(new URL('../../supabase/migrations/202610310002_assistant_cloud_drafts.sql', import.meta.url), 'utf8')
const id = value => `20000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const USER = id(1), OTHER = id(2), GROUP = id(101), LESSON = id(201), HOMEWORK = id(301)
const CREDENTIAL = 'synthetic-caller-only-credential-no-network'
const secret = 'synthetic-stable-cross-instance-confirmation-secret-only'
const NOW = Date.now(), scope = { groupId: GROUP, date: '2026-11-03' }
const bind = draft => ({ id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken })

function callerTransport() {
  const state = { userId: USER, writes: [], reads: [], rights: ['schedule', 'homework'], failAfterWrite: false, tables: {
    study_group_schedule: [{ id: LESSON, group_id: GROUP, weekday: 2, starts_at: '08:30:00', ends_at: '09:50:00', subject: 'Synthetic math', teacher_name: '', lesson_type: 'lecture', location: '', valid_from: scope.date, valid_until: scope.date, week_pattern: 'every', week_anchor_date: null, excluded_dates: [], updated_at: new Date(NOW - 60000).toISOString(), created_by: USER }],
    study_group_homework: [{ id: HOMEWORK, group_id: GROUP, schedule_item_id: LESSON, lesson_date: scope.date, lesson_topic: 'Before', body: 'Before body', updated_at: new Date(NOW - 60000).toISOString(), created_by: OTHER, url: 'https://example.com/existing', resource_links: ['https://example.com/existing'], resource_link_labels: {}, attachments: [{ path: 'synthetic-resource-only' }] }],
  } }
  class Query {
    constructor(table) { this.table = table; this.filters = {}; this.op = 'read'; this.maximum = 1000; this.singular = false }
    select() { return this }
    eq(key, value) { this.filters[key] = value; return this }
    order() { return this }
    limit(value) { this.maximum = value; return this }
    single() { this.singular = true; return this }
    insert(value) { this.op = 'insert'; this.value = value; return this }
    update(value) { this.op = 'update'; this.value = value; return this }
    then(resolve, reject) { return this.execute().then(resolve, reject) }
    async execute() {
      assert.ok(Object.hasOwn(state.tables, this.table), 'only actual homework/schedule tables')
      const table = state.tables[this.table]
      const matches = row => Object.entries(this.filters).every(([key, value]) => row[key] === value)
      if (this.op === 'read') {
        state.reads.push({ table: this.table, filters: { ...this.filters } })
        return { data: structuredClone(table.filter(matches).slice(0, this.maximum)), error: null }
      }
      assert.equal(this.table, 'study_group_homework'); assert.equal(this.value.group_id, GROUP)
      assert.equal(state.userId, USER); assert.ok(state.rights.includes('homework'))
      const row = this.op === 'update' ? table.find(matches) : {}
      if (!row) return { data: null, error: { code: 'PGRST116' } }
      Object.assign(row, structuredClone(this.value), { updated_at: new Date(NOW + state.writes.length + 1).toISOString() })
      if (this.op === 'insert') table.push(row)
      state.writes.push({ table: this.table, op: this.op, id: row.id })
      if (state.failAfterWrite) throw new Error('SYNTHETIC_RAW_BACKEND_SECRET_DO_NOT_RETURN')
      return { data: { id: row.id }, error: null }
    }
  }
  const client = { from: table => new Query(table), async rpc(name, args) {
    assert.equal(name, 'xelay_study_group_permissions')
    return { data: args.p_group_id === GROUP ? state.rights : [], error: null }
  } }
  const verifySession = async credential => {
    assert.equal(credential, CREDENTIAL)
    return { userId: state.userId, accountActive: true, emailConfirmed: true, expiresAt: new Date(NOW + 7200000).toISOString(), sessionId: 'synthetic-same-session' }
  }
  return { state, client, verifySession }
}

test('the real cloud HTTP path persists, edits, confirms, restarts and safely handles an unknown outcome', { timeout: 120000 }, async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on function auth.role() to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
    create table public.profiles(id uuid primary key);
    insert into auth.users(id,email_confirmed_at) values('${USER}',now()),('${OTHER}',now());
    insert into profiles select id from auth.users;
  `)
  await db.exec(migration)
  let queue = Promise.resolve()
  const journalCalls = []
  const journalClient = { rpc(name, args) {
    const operation = async () => {
      assert.ok(name.startsWith('xelay_assistant_cloud_draft_'), 'service client is journal-only')
      assert.equal(args.p_user_id, USER, 'verified owner passed to the private journal')
      journalCalls.push(name)
      await db.exec("set role service_role;select set_config('request.jwt.claim.role','service_role',false)")
      try {
        const result = await db.query(`select public.${name}(${Object.values(args).map((_, index) => '$' + (index + 1)).join(',')}) result`, Object.values(args))
        return { data: result.rows[0].result, error: null }
      } catch (error) { return { data: null, error: { code: error.code, message: error.message } } }
      finally { await db.exec("reset role;select set_config('request.jwt.claim.role','',false)") }
    }
    const result = queue.then(operation); queue = result.catch(() => {}); return result
  } }
  const caller = callerTransport()
  const instance = () => {
    const journal = createCloudDraftRepository({ client: journalClient, confirmationSecret: secret })
    const writes = createCloudConfirmedAssistantWrites({ journal, verifySession: caller.verifySession,
      createCallerClient: (session, credential) => { assert.equal(session.userId, USER); assert.equal(credential, CREDENTIAL); return caller.client }, now: () => NOW })
    return createAssistantCloudHandler({ enabled: true, now: () => NOW, ports: { verifySession: caller.verifySession, writes,
      catalog: async () => ({ userId: USER }), read: async () => ({ userId: USER, rows: [] }) } })
  }
  const request = async (handler, route, body) => {
    const res = new EventEmitter(); res.writableEnded = false; res.destroyed = false
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
    res.end = raw => { res.writableEnded = true; res.raw = raw; res.value = JSON.parse(raw) }
    await handler({ method: body ? 'POST' : 'GET', url: '/api/assistant?route=' + route,
      headers: { authorization: 'Bearer ' + CREDENTIAL, origin: 'https://www.xelay.ink', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, ...(body ? { body } : {}) }, res)
    assert.equal(res.headers['cache-control'], 'private, no-store, max-age=0')
    for (const forbidden of ['SYNTHETIC_RAW_BACKEND_SECRET_DO_NOT_RETURN', CREDENTIAL, '"plan"', '"fingerprint"', '"recordId"', '"document"', '"claimToken"']) assert.ok(!res.raw.includes(forbidden), 'no private data in HTTP: ' + forbidden)
    return res
  }
  const payload = topic => ({ lessonId: LESSON, date: scope.date, topic, body: 'Synthetic body with an existing attachment' })
  const first = instance()
  let res = await request(first, 'drafts/prepare', { action: 'homework.upsert', scope, payload: payload('Prepared') })
  assert.equal(res.status, 200); const original = res.value.draft
  assert.equal(caller.state.writes.length, 0)
  res = await request(instance(), 'drafts/edit', { ...bind(original), payload: payload('Reviewed and edited') })
  assert.equal(res.status, 200); const edited = res.value.draft
  assert.equal(edited.revision, 2); assert.notEqual(edited.confirmationToken, original.confirmationToken)
  assert.equal((await request(instance(), 'drafts/confirm', bind(original))).value.error, 'draft_changed')
  res = await request(instance(), 'drafts/confirm', bind(edited))
  assert.equal(res.status, 200); assert.equal(res.value.status, 'confirmed'); const receipt = res.value.receipt
  assert.equal(caller.state.tables.study_group_homework[0].lesson_topic, 'Reviewed and edited')
  assert.equal(caller.state.tables.study_group_homework[0].created_by, OTHER)
  assert.equal(caller.state.tables.study_group_homework[0].attachments.length, 1)
  // A new repository and cloud handler with the same secret recover one receipt.
  res = await request(instance(), 'drafts/confirm', bind(edited))
  assert.deepEqual(res.value.receipt, receipt); assert.equal(caller.state.writes.length, 1)
  const listed = await request(instance(), 'drafts')
  assert.equal(listed.value.drafts[0].draft.confirmationToken, edited.confirmationToken)
  assert.equal(listed.value.drafts[0].receipt.draftId, edited.id)
  const stored = (await db.query('select document,confirmation_hash,claim_hash,status from assistant_cloud_drafts where id=$1', [edited.id])).rows[0]
  assert.equal(stored.status, 'confirmed'); assert.equal(stored.confirmation_hash.length, 64)
  assert.ok(stored.document.plan); assert.equal(stored.document.confirmationToken, undefined)

  const uncertain = (await request(instance(), 'drafts/prepare', { action: 'homework.upsert', scope, payload: payload('Unknown write') })).value.draft
  caller.state.failAfterWrite = true
  res = await request(instance(), 'drafts/confirm', bind(uncertain))
  assert.equal(res.value.status, 'unknown'); assert.equal(caller.state.writes.length, 2)
  caller.state.failAfterWrite = false
  assert.equal((await request(instance(), 'drafts/confirm', bind(uncertain))).value.status, 'unknown')
  assert.equal(caller.state.writes.length, 2)
  assert.equal((await db.query('select status from assistant_cloud_drafts where id=$1', [uncertain.id])).rows[0].status, 'unknown')
  assert.ok(journalCalls.includes('xelay_assistant_cloud_draft_claim')); assert.ok(journalCalls.includes('xelay_assistant_cloud_draft_finish'))
})
