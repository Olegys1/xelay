// Exercise real workspace handlers with fictional accounts and counted transports.
// No production calls or private data are used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const load = (source, extras = {}) => {
  const module = { exports: {} }
  runInNewContext(compile(source), { module, exports: module.exports, AbortController, DOMException, Promise, Map, Set, JSON, ...extras })
  return module.exports
}
const helpers = load(read('src/lib/chatReadCoordinator.ts'))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const space = id => ({ id, name: id === 'a' ? 'Alpha' : id === 'b' ? 'Beta' : 'Faculty', kind: 'group', visibility: 'public', owner_id: null, avatar_path: null, username: null, description: '', comments_enabled: true, history_visible: true, join_approval: false, member_count: 1, my_role: 'member' })
const member = (id, userId = 'u1', patch = {}) => ({ space_id: id, user_id: userId, status: 'active', role: 'member', visible_from: null, muted: false, last_read_at: null, ...patch })
const detail = (id, userId = 'u1', patch = {}) => ({ space: space(id), my_membership: member(id, userId), members: [], invitations: [], join_requests: [], invite_links: [], pins: [], ...patch })

function fixture(options = {}) {
  const cells = [], effects = [], calls = [], channels = [], timers = new Map(), listeners = new Map()
  let index = 0, dirty = false, tree, mounted = true, clock = 0, nextTimer = 0
  const userId = options.userId || 'u1'
  const auth = { authUser: { id: userId }, xelayUser: {}, authReadEpoch: 1, authReadBlocked: false }
  const props = { kind: 'group', userId, platformAdmin: false, initialSpaceId: options.initialSpaceId, ...options.props }
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { if (!mounted) return; const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, fn }; return cells[i].fn },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const jsx = (type, props, key) => ({ type, props: { ...props, key } })
  const eventTarget = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn) },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event) },
  }
  const document = { visibilityState: 'visible', ...eventTarget }
  const addTimer = (fn, delay, repeat = false) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay, repeat: repeat ? delay : 0 }); return id }
  const rpc = async (name, args, signal) => {
    const call = { name, args: plain(args || {}), signal }; calls.push(call)
    const supplied = options.rpc?.(name, args, signal, calls)
    let result
    if (supplied !== undefined) result = await supplied
    else if (name === 'xelay_chat_inbox') result = { spaces: [space('a'), space('b')], invitations: [] }
    else if (name === 'xelay_chat_get') result = detail(args.p_space_id, userId)
    else if (name === 'xelay_chat_link_preview') result = { space: space('a'), my_membership: null }
    else if (name === 'xelay_chat_faculty') result = { space: space('faculty'), my_membership: member('faculty', userId) }
    else if (name === 'xelay_chat_join') result = 'active'
    else if (name === 'xelay_chat_invitation') result = 'a'
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return result
  }
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@tanstack/react-router': { Link: 'Link' }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
    '../context/AuthContext': { useAuth: () => auth },
    '../lib/chatReadCoordinator': helpers,
    '../lib/supabase': { supabase: {
      from(table) {
        const args = {}
        const query = { select() { return query }, eq(key, value) { args[key] = value; return query }, abortSignal(signal) { query.signal = signal; return query }, async maybeSingle() {
          calls.push({ name: table + (table === 'chat_members' ? ':membership' : ':profile'), args, signal: query.signal })
          if (table === 'chat_members') {
            const supplied = options.membership?.(args, query.signal)
            return { data: supplied === undefined ? member(args.space_id, args.user_id) : await supplied, error: null }
          }
          return { data: { university_id: 'university', academic_unit_id: 'faculty' }, error: null }
        } }
        return query
      },
      channel(name) { const channel = { name, subscriptions: [], closed: false,
        on(_event, filter, callback) { channel.subscriptions.push({ ...filter, callback }); return channel },
        subscribe(callback) { channel.status = callback; callback?.('SUBSCRIBED'); channels.push(channel); return channel },
      }; return channel },
      async removeChannel(channel) { channel.closed = true },
    } },
    '../lib/chatSpaces': {
      chatRpc: rpc, chatError: error => String(error?.message || error), clearChatMediaCache() { calls.push({ name: 'clearMedia' }) },
      signChatSpaces: async spaces => options.sign ? options.sign(spaces) : spaces,
      loadChatProfiles: async (ids, signal) => { calls.push({ name: 'profiles', ids, signal }); return Object.fromEntries(ids.map(id => [id, { id, full_name: id }])) },
      loadFacultyChat: (rejoin = false, signal) => rpc('xelay_chat_faculty', { p_rejoin: rejoin }, signal),
      announceChatUpdate: () => eventTarget.dispatchEvent({ type: 'xelay-chat-updated' }),
    },
    './CommunityChatPrimitives': { ChatAvatar: 'ChatAvatar', ChatDialog: 'ChatDialog', ChatPerson: 'ChatPerson', ChatSpinner: 'ChatSpinner', chatButton: 'button', chatIcon: 'icon', chatInput: 'input', chatPrimary: 'primary' },
    './CommunityChatSettings': { CommunityChatEditor: 'CommunityChatEditor', CommunityChatManagement: 'CommunityChatManagement' },
    './CommunityChatTimeline': { CommunityChatTimeline: 'CommunityChatTimeline' }, './AuthModal': { AuthModal: 'AuthModal' },
  }
  const exported = load((options.source || read('src/components/CommunityChats.tsx')) + '\nexport { CommunityChatsWorkspace }\n', {
    require(name) { assert.ok(name in imports, 'Known import ' + name); return imports[name] },
    window: eventTarget, document,
    setTimeout: (fn, delay) => addTimer(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => addTimer(fn, delay, true), clearInterval: id => timers.delete(id),
  })
  const render = () => { for (let pass = 0; pass < 50; pass++) { index = 0; dirty = false; tree = exported.CommunityChatsWorkspace(props); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Hooks did not settle') }
  render()
  const f = {
    calls, channels, auth, props, render, document,
    get tree() { return tree },
    view() { return nodes(tree).find(node => node.type === 'CommunityChatTimeline')?.props.detail || null },
    count(name) { return calls.filter(call => call.name === name).length },
    find(predicate) { const result = nodes(tree).find(predicate); assert.ok(result, 'Rendered node must exist'); return result },
    button(label) { return this.find(node => node.type === 'button' && text(node).trim().replace(/\s+/g, ' ') === label) },
    open(id) { this.find(node => node.type === 'button' && node.props.key === id).props.onClick(); render() },
    emit(table, payload) { for (const channel of channels.filter(item => !item.closed)) for (const subscription of channel.subscriptions.filter(item => item.table === table)) { const [field, value] = (subscription.filter || '').split('=eq.'); const rowValue = payload.new?.[field] ?? payload.old?.[field]; if (value && rowValue !== undefined && rowValue !== value) continue; subscription.callback(payload) } render() },
    event(type) { eventTarget.dispatchEvent({ type }); render() },
    async settle() { for (let i = 0; i < 80; i++) { await Promise.resolve(); render() } },
    async advance(ms) { const until = clock + ms; for (let pass = 0; pass < 500; pass++) { const first = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!first) { clock = until; await this.settle(); return } const [id, timer] = first; clock = timer.at; if (timer.repeat) timer.at += timer.repeat; else timers.delete(id); timer.fn(); await this.settle() } throw Error('Timers did not settle') },
    replace(next) { Object.assign(props, next); render() },
    wrapper() { index = 0; return exported.CommunityChats(props) },
    unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()) },
  }
  return f
}


export { fixture, helpers, deferred, plain, text, nodes, space, member, detail, load, read }
