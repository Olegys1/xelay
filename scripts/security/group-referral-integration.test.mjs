import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createSupabaseGroupReferralRepository, parseGroupReferralWorkspace, observeGroupReferralRead } from '../../src/lib/groupReferralRepository.ts'
import { normalizeGroupReferralCode, rememberGroupReferralInvitation, groupReferralCreationDestination } from '../../src/lib/groupReferralInvitation.ts'

const USER = '01000000-0000-4000-8000-000000000001', OTHER = '01000000-0000-4000-8000-000000000002'
const empty = actor => ({ campaign: null, actor: actor ? { id: actor, verified: true, alias: 'Вигаданий учасник', canAdmin: false } : null, ownLink: null, ownGroups: [], candidateGroups: [], ownTickets: 0, nextCursor: null, candidateNextCursor: null, winners: [] })
function fakeClient(actor = USER, response = empty(actor)) {
  const listeners = new Set(), calls = []
  const state = { actor, response, calls, change(next) { this.actor = next; for (const listener of listeners) listener('SIGNED_IN', next ? { user: { id: next } } : null) } }
  state.client = { auth: { async getSession() { return { data: { session: state.actor ? { user: { id: state.actor } } : null }, error: null } }, onAuthStateChange(listener) { listeners.add(listener); return { data: { subscription: { unsubscribe() { listeners.delete(listener) } } } } } },
    rpc(name, args) { calls.push({ name, args }); return { async abortSignal() { if (state.beforeReturn) await state.beforeReturn(); return { data: state.response, error: null } } } } }
  return state
}
test('invitation code cannot become a URL or cross-account attribution', () => {
  const storage = { data: '', setItem(_key, value) { this.data = value }, getItem() { return this.data }, removeItem() { this.data = '' } }
  for (const bad of ['https://evil.test/', '<script>', 'short', 'abc?code=123', 'aaa\nBBB']) assert.equal(normalizeGroupReferralCode(bad), undefined)
  rememberGroupReferralInvitation(USER, 'local-abcd-2026', storage)
  assert.equal(groupReferralCreationDestination(USER, storage), '/referrals?code=LOCAL-ABCD-2026')
  assert.equal(groupReferralCreationDestination(OTHER, storage), null)
  assert.equal(groupReferralCreationDestination(USER, storage, true), '/referrals?code=LOCAL-ABCD-2026')
  assert.equal(groupReferralCreationDestination(USER, storage), null)
  storage.data = JSON.stringify({ actorId: USER, code: 'LOCAL-AAAA', at: Date.now() - 25 * 3600_000 })
  assert.equal(groupReferralCreationDestination(USER, storage), null)
})
test('workspace strips unknown fields and rejects another account or private guest projection', () => {
  assert.deepEqual(parseGroupReferralWorkspace({ ...empty(USER), secret: 'never return' }, USER), empty(USER))
  assert.throws(() => parseGroupReferralWorkspace(empty(OTHER), USER), /AUTH_REQUIRED/)
  assert.throws(() => parseGroupReferralWorkspace({ ...empty(null), ownTickets: 1 }, null))
  assert.throws(() => parseGroupReferralWorkspace({ ...empty(USER), admin: {} }, USER), /ADMIN_REQUIRED/)
  const winner = { id: crypto.randomUUID(), rank: 1, alias: 'Публічний псевдонім', prize: { rank: 1, label: 'ChatGPT Pro', months: 1 }, version: 1, isOwn: false }
  assert.equal(parseGroupReferralWorkspace({ ...empty(USER), winners: [winner] }, USER).winners[0].alias, winner.alias)
  assert.throws(() => parseGroupReferralWorkspace({ ...empty(USER), winners: [{ ...winner, organizerId: OTHER }] }, USER))
  assert.throws(() => parseGroupReferralWorkspace({ ...empty(USER), winners: [{ ...winner, isOwn: true, organizerId: OTHER }] }, USER))
})
test('mutations carry server-side actor binding and stable command identity', async () => {
  const state = fakeClient(), repository = createSupabaseGroupReferralRepository(state.client, USER)
  const command = { requestId: crypto.randomUUID(), campaignId: crypto.randomUUID(), alias: 'Учасник', acceptRules: true }
  await repository.action('create_link', command)
  await repository.action('create_link', command)
  assert.equal(state.calls[0].name, 'xelay_group_referral_action')
  assert.equal(state.calls[0].args.p_expected_user_id, USER)
  assert.deepEqual(state.calls[0].args.p_payload, command)
  assert.deepEqual(state.calls[1].args, state.calls[0].args)
  await assert.rejects(repository.action('create_link', { ...command, requestId: 'invalid' }))
  assert.equal(state.calls.length, 2)
})
test('account changes during a request discard the old result', async () => {
  const state = fakeClient(), repository = createSupabaseGroupReferralRepository(state.client, USER)
  state.beforeReturn = () => state.change(OTHER)
  await assert.rejects(repository.load(), /AUTH_REQUIRED|SOURCE_UNAVAILABLE/)
})
test('guest reads are allowed but guest mutations never call the server', async () => {
  const state = fakeClient(null), repository = createSupabaseGroupReferralRepository(state.client, null)
  assert.equal((await repository.load()).actor, null)
  assert.equal(state.calls[0].args.p_slug, 'bring-your-group')
  await assert.rejects(repository.action('register_group', {}), /AUTH_REQUIRED/)
  assert.equal(state.calls.length, 1)
})
test('activity observation sends only IDs and kind and coalesces repeated visible reads', async () => {
  const state = fakeClient(USER, { counted: true }), input = { groupId: crypto.randomUUID(), resourceId: crypto.randomUUID(), kind: 'schedule' }
  await Promise.all([observeGroupReferralRead(state.client, USER, input), observeGroupReferralRead(state.client, USER, input)])
  await observeGroupReferralRead(state.client, USER, input)
  assert.equal(state.calls.length, 1)
  assert.deepEqual(state.calls[0].args, { p_group_id: input.groupId, p_kind: 'schedule', p_resource_id: input.resourceId, p_expected_user_id: USER })
  await observeGroupReferralRead(state.client, USER, { ...input, groupId: 'invalid' })
  assert.equal(state.calls.length, 1)
})
test('production entry never imports synthetic identities and route remains outside sitemap', async () => {
  const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
  const [page, app, seo, config, preview, marker] = await Promise.all(['src/pages/GroupReferralPage.tsx', 'src/App.tsx', 'src/lib/seo.ts', 'vercel.json', 'scripts/preview-group-referral.mjs', 'src/components/GroupReferralReadMarker.tsx'].map(read))
  assert.doesNotMatch(page + app, /localGroupReferral|GroupReferralPreviewSeed|LocalGroupReferralPreview/)
  assert.match(app, /path: '\/referrals'/)
  assert.match(seo, /PRIVATE_SPA_PATHS[^\n]*'\/referrals'/)
  assert.ok(JSON.parse(config).rewrites.some(item => item.source === '/referrals' && item.destination === '/seo/referrals.html'))
  assert.match(preview, /host: '127\.0\.0\.1'/)
  assert.match(marker, /IntersectionObserver/); assert.match(marker, /visibilityState === 'visible'/)
})
