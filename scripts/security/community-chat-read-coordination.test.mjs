// Real workspace handlers, fictional RPCs, no production.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, helpers, deferred, text, member, detail, load, read } from './community-chat-ui-fixture.mjs'

test('opening a selected chat uses one detail request, including route reflection', async () => {
  const f = fixture(); await f.settle()
  const initial = f.count('xelay_chat_get')
  f.open('a'); await f.settle()
  assert.equal(f.count('xelay_chat_get') - initial, 1)
  assert.equal(f.view().space.id, 'a')
  f.replace({ initialSpaceId: 'a' }); await f.settle()
  assert.equal(f.count('xelay_chat_get') - initial, 1)
  f.open('a'); await f.settle(); assert.equal(f.count('xelay_chat_get') - initial, 1)
  f.unmount()
})

test('initial deep-link bootstrap does not reread detail after inbox finishes', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  assert.equal(f.count('xelay_chat_get'), 1)
  assert.equal(f.count('xelay_chat_inbox'), 1)
  assert.equal(f.view().space.id, 'a'); f.unmount()
})

test('a post in another known chat refreshes the inbox once, not current detail or faculty', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  const before = Object.fromEntries(['xelay_chat_get', 'xelay_chat_inbox', 'xelay_chat_faculty', 'profiles:profile'].map(name => [name, f.count(name)]))
  for (let i = 0; i < 5; i++) f.emit('chat_posts', { eventType: 'INSERT', new: { id: 'post-' + i, space_id: 'b' } })
  await f.advance(400)
  assert.equal(f.count('xelay_chat_inbox') - before.xelay_chat_inbox, 1)
  assert.equal(f.count('xelay_chat_get') - before.xelay_chat_get, 0)
  assert.equal(f.count('xelay_chat_faculty') - before.xelay_chat_faculty, 0)
  assert.equal(f.count('profiles:profile') - before['profiles:profile'], 0)
  assert.equal(f.count('chat_members:membership'), 1)
  f.unmount()
})

test('selected post changes coalesce and a sparse DELETE conservatively rechecks access', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  const before = f.count('xelay_chat_get')
  for (let i = 0; i < 4; i++) f.emit('chat_posts', { eventType: 'UPDATE', new: { space_id: 'a' } })
  await f.advance(400); assert.equal(f.count('xelay_chat_get') - before, 1)
  f.emit('chat_posts', { eventType: 'DELETE', old: { id: 'unknown-scope-post' } })
  await f.advance(400); assert.equal(f.count('xelay_chat_get') - before, 2)
  f.unmount()
})

test('events during an in-flight read queue one follow-up, never parallel same-scope reads', async () => {
  const pending = deferred(); let gets = 0
  const f = fixture({ initialSpaceId: 'a', rpc(name) { if (name === 'xelay_chat_get' && ++gets === 1) return pending.promise } })
  await f.settle(); assert.equal(f.count('xelay_chat_get'), 1)
  f.event('focus'); f.event('online')
  for (let i = 0; i < 5; i++) f.emit('chat_posts', { eventType: 'UPDATE', new: { space_id: 'a' } })
  await f.advance(400); assert.equal(f.count('xelay_chat_get'), 1)
  pending.resolve(detail('a')); await f.settle()
  assert.equal(f.count('xelay_chat_get'), 2); assert.equal(f.view().space.id, 'a')
  f.unmount()
})

test('switching chats aborts an old request and its late response cannot replace the new chat', async () => {
  const pending = deferred()
  const f = fixture({ rpc(name, args) { if (name === 'xelay_chat_get' && args.p_space_id === 'a') return pending.promise } })
  await f.settle(); f.open('a'); await f.settle()
  const old = f.calls.find(call => call.name === 'xelay_chat_get')
  f.open('b'); await f.settle()
  assert.equal(old.signal.aborted, true); assert.equal(f.view().space.id, 'b')
  pending.resolve(detail('a', 'u1', { pins: [{ body: 'Old private pin' }] })); await f.settle()
  assert.equal(f.view().space.id, 'b'); assert.equal(f.view().pins.length, 0)
  f.unmount()
})

test('own read receipts recheck only own membership without reloading full detail or remounting the timeline', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  const before = f.count('xelay_chat_get')
  f.event('xelay-chat-updated')
  assert.equal(f.view().space.id, 'a')
  await f.advance(400); assert.equal(f.count('xelay_chat_get'), before)
  assert.equal(f.count('chat_members:membership'), 1)
  assert.equal(f.view().space.id, 'a'); f.unmount()
})

test('an authoritative own-membership revocation clears content and invalidates a stale detail response', async () => {
  let blocked = false, banned = false, pending
  const f = fixture({ initialSpaceId: 'a', membership() { return member('a', 'u1', { status: banned ? 'banned' : 'active' }) }, rpc(name) { if (name === 'xelay_chat_get' && blocked) return pending.promise } })
  await f.settle(); assert.equal(f.view().space.id, 'a')
  blocked = true; pending = deferred(); f.event('focus'); await f.advance(400)
  const lastRead = f.calls.filter(call => call.name === 'xelay_chat_get').at(-1)
  banned = true
  f.emit('chat_posts', { eventType: 'INSERT', new: { space_id: 'b' } }); await f.advance(400)
  assert.equal(f.view(), null); assert.equal(lastRead.signal.aborted, true)
  pending.resolve(detail('a')); await f.settle()
  assert.equal(f.view(), null); f.unmount()
})

test('silent removal is caught by the visible access backstop without publishing membership associations', async () => {
  let removed = false
  const f = fixture({ initialSpaceId: 'a', membership() { return removed ? null : member('a') } })
  await f.settle()
  assert.equal(f.channels.flatMap(channel => channel.subscriptions).some(subscription => subscription.table === 'chat_members'), false)
  const before = f.count('xelay_chat_get')
  removed = true
  await f.advance(60_000)
  assert.equal(f.view(), null)
  assert.equal(f.count('xelay_chat_get'), before)
  assert.equal(f.count('chat_members:membership'), 1)
  assert.equal(f.count('xelay_chat_inbox'), 2)
  f.unmount()
})

test('a changed own role clears old privileges before protected detail is reloaded', async () => {
  let changed = false, paused = false
  const pending = deferred()
  const f = fixture({ initialSpaceId: 'a', membership() { return member('a', 'u1', { role: changed ? 'member' : 'admin' }) }, rpc(name, args) {
    if (name === 'xelay_chat_get') return paused ? pending.promise : detail(args.p_space_id, 'u1', { my_membership: member(args.p_space_id, 'u1', { role: 'admin' }), is_admin: true })
  } })
  await f.settle(); assert.equal(f.view().is_admin, true)
  changed = paused = true
  f.emit('chat_posts', { eventType: 'INSERT', new: { space_id: 'b' } }); await f.advance(400)
  assert.equal(f.view(), null)
  assert.equal(f.count('xelay_chat_get'), 2)
  pending.resolve(detail('a', 'u1', { is_admin: false })); await f.settle()
  assert.equal(f.view().is_admin, false)
  f.unmount()
})

test('an own-access transport failure cannot retain private content or leak an unhandled rejection', async () => {
  let failed = false
  const f = fixture({ initialSpaceId: 'a', membership() { if (failed) throw Error('Access verification unavailable'); return member('a') } })
  await f.settle(); assert.ok(f.view())
  failed = true
  f.event('xelay-chat-updated'); await f.advance(400)
  assert.equal(f.view(), null)
  assert.match(text(f.tree), /Access verification unavailable/)
  f.unmount()
})

test('platform role and profile-scope events clear loaded private content before any refresh', async () => {
  for (const table of ['user_roles', 'profiles']) {
    const f = fixture({ initialSpaceId: 'a' }); await f.settle(); assert.ok(f.view())
    f.emit(table, { eventType: 'UPDATE', new: table === 'profiles' ? { id: 'u1' } : { user_id: 'u1' } })
    assert.equal(f.view(), null)
    await f.advance(400); assert.ok(f.view()); f.unmount()
  }
})

test('unmount aborts old-session work and a new account cannot receive its result', async () => {
  const pending = deferred()
  const old = fixture({ initialSpaceId: 'a', rpc(name) { if (name === 'xelay_chat_get') return pending.promise } })
  await old.settle(); const request = old.calls.find(call => call.name === 'xelay_chat_get')
  old.unmount(); assert.equal(request.signal.aborted, true)
  const fresh = fixture({ userId: 'u2', initialSpaceId: 'b' }); await fresh.settle()
  pending.resolve(detail('a')); await old.settle(); await fresh.settle()
  assert.equal(fresh.view().space.id, 'b'); assert.equal(fresh.view().my_membership.user_id, 'u2')
  fresh.unmount()
})

test('timeline completion absorbs pending local inbox events instead of double-refreshing detail', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  const before = { inbox: f.count('xelay_chat_inbox'), detail: f.count('xelay_chat_get') }
  f.event('xelay-chat-updated')
  await f.find(node => node.type === 'CommunityChatTimeline').props.onRefresh()
  await f.settle(); await f.advance(400)
  assert.equal(f.count('xelay_chat_inbox') - before.inbox, 1)
  assert.equal(f.count('xelay_chat_get') - before.detail, 1)
  f.unmount()
})

test('a failed read can be retried; successful membership mutations still refresh and leave clears content', async () => {
  let fail = true
  const f = fixture({ initialSpaceId: 'a', rpc(name) { if (name === 'xelay_chat_get' && fail) throw Error('Temporary network failure') } })
  await f.settle(); assert.equal(f.view(), null)
  fail = false; f.button('Оновити').props.onClick(); await f.settle(); assert.ok(f.view())
  f.find(node => node.type === 'button' && node.props['aria-label'] === 'Вийти з чату').props.onClick(); f.render()
  await f.button('Вийти').props.onClick(); await f.settle()
  assert.equal(f.count('xelay_chat_leave'), 1); assert.equal(f.view(), null)
  f.unmount()
})

test('lost realtime uses a visible backstop; reconnect/focus/online coalesce', async () => {
  const f = fixture({ initialSpaceId: 'a' }); await f.settle()
  const channel = f.channels.find(item => item.name.startsWith('community-inbox:'))
  const before = f.count('xelay_chat_get')
  channel.status('CHANNEL_ERROR'); await f.advance(60_400)
  assert.equal(f.count('xelay_chat_get') - before, 1)
  channel.status('SUBSCRIBED'); f.event('focus'); f.event('online'); await f.advance(400)
  assert.equal(f.count('xelay_chat_get') - before, 2)
  f.unmount()
})

test('workspace identity includes verified auth epoch and blocked auth does not expose a workspace', async () => {
  const f = fixture(); await f.settle()
  const first = f.wrapper(); f.auth.authReadEpoch = 2
  const second = f.wrapper(); assert.notEqual(first.props.key, second.props.key)
  f.auth.xelayUser.isPlatformAdmin = true
  assert.notEqual(second.props.key, f.wrapper().props.key)
  f.auth.authReadBlocked = true
  const blocked = f.wrapper(); assert.equal(blocked.props.role, 'status')
  assert.doesNotMatch(text(blocked), /Alpha|Beta/)
  f.unmount()
})

test('a confirmed guest still sees login rather than a permanent access-checking screen', async () => {
  const f = fixture(); await f.settle()
  f.auth.authUser = null; f.auth.authReadBlocked = true
  const guest = f.wrapper()
  assert.match(text(guest), /Увійдіть у профіль/)
  assert.doesNotMatch(text(guest), /Перевіряємо доступ до чатів/)
  f.unmount()
})

test('opening an ordinary chat consumes the invitation without previewing the old token again', async () => {
  const f = fixture({ props: { inviteToken: 'fictional-invite' } }); await f.settle()
  const preview = f.count('xelay_chat_link_preview'), gets = f.count('xelay_chat_get')
  f.open('b'); await f.settle()
  assert.equal(f.view().space.id, 'b')
  assert.equal(f.count('xelay_chat_link_preview'), preview)
  assert.equal(f.count('xelay_chat_get') - gets, 1)
  f.replace({ initialSpaceId: 'b', inviteToken: undefined }); await f.settle()
  assert.equal(f.view().space.id, 'b')
  assert.equal(f.count('xelay_chat_get') - gets, 1)
  f.unmount()
})

test('an invitation preview still grants no private history without confirmed membership', async () => {
  const f = fixture({ props: { inviteToken: 'fictional-invite' }, rpc(name) { if (name === 'xelay_chat_inbox') return { spaces: [], invitations: [] } } })
  await f.settle()
  assert.equal(f.count('xelay_chat_link_preview'), 1)
  assert.equal(f.count('xelay_chat_get'), 0)
  assert.equal(f.view(), null)
  assert.match(text(f.tree), /Alpha/)
  f.unmount()
})

test('faculty-scope denial does not suppress an independently authorized inbox and private chat', async () => {
  for (const error of [Object.assign(Error('CHAT_FACULTY_SCOPE_REQUIRED'), { status: 403 }), Object.assign(Error('Faculty ACL unavailable'), { code: '42501' })]) {
    const f = fixture({ initialSpaceId: 'a', rpc(name) { if (name === 'xelay_chat_faculty') throw error } })
    await f.settle()
    assert.equal(f.count('xelay_chat_inbox'), 1)
    assert.equal(f.view().space.id, 'a')
    assert.equal(f.count('xelay_chat_faculty'), 1)
    f.unmount()
  }
})

test('an authoritative invalid session in faculty lookup still cancels private reads', async () => {
  const pending = deferred()
  const f = fixture({ initialSpaceId: 'a', rpc(name) {
    if (name === 'xelay_chat_faculty') throw Object.assign(Error('CHAT_AUTH_REQUIRED'), { status: 401 })
    if (name === 'xelay_chat_get') return pending.promise
  } })
  await f.settle()
  assert.equal(f.count('xelay_chat_inbox'), 0); assert.equal(f.view(), null)
  const request = f.calls.find(call => call.name === 'xelay_chat_get')
  assert.equal(request.signal.aborted, true)
  pending.resolve(detail('a')); await f.settle(); assert.equal(f.view(), null)
  f.unmount()
})

test('denial of a selected faculty chat clears its content and spinner while other chats still load', async () => {
  let denied = false
  const f = fixture({ initialSpaceId: 'faculty', rpc(name) {
    if (name === 'xelay_chat_faculty' && denied) throw Object.assign(Error('CHAT_FACULTY_SCOPE_REQUIRED'), { status: 403 })
  } })
  await f.settle(); assert.equal(f.view().space.id, 'faculty')
  denied = true
  f.find(node => node.type === 'button' && node.props['aria-label'] === 'Оновити список').props.onClick()
  await f.settle()
  assert.equal(f.view(), null); assert.equal(f.count('xelay_chat_inbox'), 2)
  assert.doesNotMatch(text(f.tree), /Перевіряємо доступ до чатів/)
  assert.match(text(f.tree), /CHAT_FACULTY_SCOPE_REQUIRED/)
  f.unmount()
})

test('a full focus refresh upgrades a pending message-only inbox read without losing faculty revalidation', async () => {
  let inboxReads = 0
  const pending = deferred()
  const f = fixture({ initialSpaceId: 'a', rpc(name) { if (name === 'xelay_chat_inbox' && ++inboxReads === 2) return pending.promise } })
  await f.settle()
  const facultyReads = f.count('xelay_chat_faculty')
  f.emit('chat_posts', { eventType: 'INSERT', new: { space_id: 'b' } }); await f.advance(400)
  assert.equal(f.count('xelay_chat_inbox'), 2)
  f.event('focus'); await f.advance(400)
  assert.equal(f.count('xelay_chat_faculty'), facultyReads)
  pending.resolve({ spaces: [], invitations: [] }); await f.settle()
  assert.equal(f.count('xelay_chat_faculty') - facultyReads, 1)
  assert.equal(f.count('xelay_chat_inbox'), 3)
  f.unmount()
})

test('coordinator has no settled cache and invalidation makes an old completion non-current', async () => {
  const reader = helpers.createChatReadCoordinator(), pending = deferred()
  let count = 0, stalePublished = false
  const first = reader.read('detail:a', async context => { count++; await pending.promise; stalePublished = context.current() })
  assert.equal(count, 1)
  assert.equal(reader.read('detail:a', async () => { count++ }), first)
  reader.invalidate('detail:'); pending.resolve(); await first
  assert.equal(stalePublished, false)
  await reader.read('detail:a', async () => { count++ }); assert.equal(count, 2)
})

test('the actual RPC wrapper forwards cancellation and rejects a late successful response after abort', async () => {
  const pending = deferred(), controller = new AbortController()
  let seenSignal, profileSignal
  const request = pending.promise
  request.abortSignal = signal => { seenSignal = signal; return request }
  const imports = {
    './supabase': { supabase: { rpc: () => request } },
    './privateMedia': {}, './profiles': { getPublicProfiles: async (_ids, signal) => { profileSignal = signal; return { data: [], error: null } } },
    './postgrestFilters': {}, './userSearch': {},
  }
  const transport = load(read('src/lib/chatSpaces.ts'), { require(name) { assert.ok(name in imports, name); return imports[name] } })
  const result = transport.chatRpc('xelay_chat_get', { p_space_id: 'a' }, controller.signal)
  assert.equal(seenSignal, controller.signal)
  controller.abort(); pending.resolve({ data: { private: 'must not publish' }, error: null })
  await assert.rejects(result, error => error.name === 'AbortError')
  await transport.loadChatProfiles(['fictional-user'], controller.signal)
  assert.equal(profileSignal, controller.signal)
})
