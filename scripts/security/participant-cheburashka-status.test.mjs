// Offline PostgreSQL checks. Synthetic users only; no Supabase connection.
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import ts from 'typescript'
import vm from 'node:vm'

const source = await readFile(new URL('../../src/lib/participantStatus.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { exports: module.exports, module })
const catalog = module.exports
const sql = await readFile(new URL('../../supabase/migrations/202610140005_participant_cheburashka_status.sql', import.meta.url), 'utf8')
const db = new PGlite()
const paid = '00000000-0000-4000-8000-000000000001'
const free = '00000000-0000-4000-8000-000000000002'
const token = 'sticker:cheburashka'

async function asUser(userId, statement, params = []) {
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId || ''])
  try { return await db.query(statement, params) }
  finally { await db.exec('reset role'); await db.exec('reset "request.jwt.claim.sub"') }
}
async function save(userId, emoji, text = 'На своєму вайбі') {
  return asUser(userId, 'select public.xelay_set_participant_status($1,$2)', [text, emoji])
}

before(async () => {
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated;
    create table public.premium_preferences(user_id uuid primary key,status_text text,emoji_status text,updated_at timestamptz default now());
    alter table public.premium_preferences enable row level security;
    create function public.xelay_has_participant_access(uuid) returns boolean language sql stable as $$
      select $1='${paid}'::uuid $$;
    create function public.xelay_set_participant_status(text,text) returns void language sql as $$ select $$;
    revoke all on function public.xelay_set_participant_status(text,text) from public,anon;
    grant execute on function public.xelay_set_participant_status(text,text) to authenticated;
  `)
  await db.exec(sql)
})
after(() => db.close())

test('client catalog preserves every legacy RPC token, including hippo and Cheburashka', () => {
  const allowed = [...sql.match(/v_allowed text\[\] := array\[([^;]+)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.ok(allowed.every(token => catalog.PARTICIPANT_STATUS_EMOJIS.includes(token)))
  assert.equal(catalog.PARTICIPANT_CHEBURASHKA_STATUS, token)
  assert.equal(catalog.participantStatusEmojiLabel(token), 'Чебурашка з сердечком')
  assert.equal(catalog.PARTICIPANT_STATUS_EMOJIS.filter(item => item === token).length, 1)
  assert.ok(allowed.includes('🦛'))
})
test('paid user saves sticker alongside two native emojis and text', async () => {
  await save(paid, `${token} 🦛 ❤️`)
  const { rows } = await db.query('select * from premium_preferences where user_id=$1', [paid])
  assert.equal(rows[0].emoji_status, `${token} 🦛 ❤️`)
  assert.equal(rows[0].status_text, 'На своєму вайбі')
})
test('free or unauthenticated users cannot set the sticker', async () => {
  await assert.rejects(save(free, token), /PARTICIPANT_REQUIRED/)
  await assert.rejects(save(null, token), /PARTICIPANT_REQUIRED/)
  const { rows } = await db.query('select count(*)::int as n from premium_preferences')
  assert.equal(rows[0].n, 1)
})
test('sticker remains subject to three unique tokens and an exact catalog', async () => {
  for (const value of [`${token} ${token}`, `${token} 🦛 ❤️ 😊`, `${token}  ❤️`, 'sticker:unknown', 'https://example.test/image.png']) {
    await assert.rejects(save(paid, value), /INVALID_PARTICIPANT_STATUS_EMOJI/)
  }
  await assert.rejects(save(paid, token, 'x'.repeat(49)), /INVALID_PARTICIPANT_STATUS_TEXT/)
})
test('status can be cleared and legacy hippo/native statuses stay valid', async () => {
  await save(paid, '🦛 😊')
  await save(paid, null, null)
  const { rows } = await db.query('select status_text,emoji_status from premium_preferences where user_id=$1', [paid])
  assert.equal(rows[0].status_text, null)
  assert.equal(rows[0].emoji_status, null)
})
test('migration can be reapplied without changing existing function ACLs', async () => {
  const query = `select has_function_privilege('authenticated','public.xelay_set_participant_status(text,text)','execute') as allowed,
    has_function_privilege('anon','public.xelay_set_participant_status(text,text)','execute') as anonymous,
    has_table_privilege('authenticated','public.premium_preferences','insert,update,delete') as direct_write`
  const previous = (await db.query(query)).rows[0]
  await db.exec(sql)
  assert.deepEqual((await db.query(query)).rows[0], previous)
  assert.deepEqual(previous, { allowed: true, anonymous: false, direct_write: false })
})
test('sticker assets have an alpha channel, fixed dimensions and a small payload', async () => {
  for (const name of ['cheburashka-20261014.png', 'cheburashka-heart-20261014.png']) {
    const png = await readFile(new URL(`../../src/assets/status/${name}`, import.meta.url))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.equal(png.readUInt32BE(16), 128)
    assert.equal(png.readUInt32BE(20), 128)
    assert.equal(png[25], 6, 'RGBA PNG preserves generated alpha')
    assert.ok(png.length < 30_000)
  }
})
test('reduced motion uses the first frame; premium visibility stays centralized', async () => {
  const css = await readFile(new URL('../../src/components/ParticipantStatusEmoji.css', import.meta.url), 'utf8')
  const badge = await readFile(new URL('../../src/components/PremiumBadge.tsx', import.meta.url), 'utf8')
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /animation: none !important/)
  assert.match(css, /\.participant-status-sticker__heart\s*\{\s*display: none/)
  assert.match(badge, /if \(!premium\) return null/)
})
