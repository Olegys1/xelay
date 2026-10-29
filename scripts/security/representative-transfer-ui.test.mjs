import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/components/representative-transfer/RepresentativeTransferPanel.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const groupId = 'synthetic-group', currentUserId = 'synthetic-self'
const members = [
  { id: currentUserId, groupId, name: 'Марія Приклад', username: 'maria.example', status: 'accepted' },
  { id: 'synthetic-sofia', groupId, name: 'Софія Приклад', username: 'sofia.example', status: 'accepted' },
  { id: 'synthetic-danylo', groupId, name: 'Данило Приклад', username: 'danylo.example', status: 'accepted' },
  { id: 'synthetic-pending', groupId, name: 'Pending Hidden', username: 'pending', status: 'pending' },
  { id: 'synthetic-invited', groupId, name: 'Invited Hidden', status: 'invited' },
  { id: 'synthetic-foreign', groupId: 'another-group', name: 'Foreign Hidden', status: 'accepted' },
]
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function nodes(node) { if (!node || typeof node !== 'object') return []; return Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)] }
function text(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); if (!node || typeof node !== 'object') return ''; return Array.isArray(node) ? node.map(text).join('') : text(node.props?.children) }

function fixture(t, overrides = {}) {
  const cells = [], effects = [], calls = [], pending = []
  let at = 0, dirty = false, tree, props
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const react = {
    useId: () => 'synthetic-transfer', useMemo: compute => compute(),
    useState(initial) { const index = at++; if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[index].value, next => { const value = typeof next === 'function' ? next(cells[index].value) : next; if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true } }] },
    useRef(initial) { const index = at++; cells[index] ||= { current: initial }; return cells[index] },
    useEffect(callback, deps) { const index = at++; if (!cells[index] || !equal(cells[index].deps, deps)) { const before = cells[index]; cells[index] = { deps }; effects.push(() => { before?.cleanup?.(); cells[index].cleanup = callback() }) } },
  }
  const modules = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }, 'lucide-react': new Proxy({}, { get: (_, name) => () => ({ type: 'test-icon', name }) }), './representativeTransfer.css': {} }
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, Error, require(name) { assert.ok(name in modules, 'Unexpected network or application dependency: ' + name); return modules[name] } })
  props = { groupId, groupName: 'ЕУБ-4', currentUserId, representativeId: currentUserId, members,
    onTransfer: target => { calls.push(target); const request = deferred(); pending.push(request); return request.promise }, ...overrides }
  const render = () => { for (let attempt = 0; attempt < 25; attempt++) { at = 0; dirty = false; tree = module.exports.RepresentativeTransferPanel(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Unexpected render loop') }
  const find = (type, test = () => true) => nodes(render()).find(node => node.type === type && test(node.props))
  const button = label => { const node = find('button', candidate => text(candidate.children).trim() === label); assert.ok(node, 'Missing button: ' + label); return node.props }
  const input = type => { const node = find('input', candidate => candidate.type === type); assert.ok(node, 'Missing input: ' + type); return node.props }
  render(); t.after(() => cells.forEach(cell => cell?.cleanup?.()))
  return { calls, pending, get tree() { return render() }, get text() { return text(render()) }, button, input,
    open() { button('Передати права').onClick(); render() },
    select(id = 'synthetic-sofia') { const node = find('input', candidate => candidate.type === 'radio' && candidate.value === id); assert.ok(node); node.props.onChange(); render() },
    review() { button('Продовжити').onClick(); render() },
    acknowledge() { input('checkbox').onChange({ target: { checked: true } }); render() },
    update(next) { props = { ...props, ...next }; render() },
    async settle() { await Promise.resolve(); await Promise.resolve(); render() },
  }
}

test('only accepted members of this group appear; self is disabled and nothing is preselected', t => {
  const fx = fixture(t); fx.open()
  assert.doesNotMatch(fx.text, /Pending Hidden|Invited Hidden|Foreign Hidden/)
  const radios = nodes(fx.tree).filter(node => node.type === 'input' && node.props.type === 'radio')
  assert.equal(radios.length, 3)
  assert.ok(radios.every(node => node.props.checked === false))
  assert.equal(radios.find(node => node.props.value === currentUserId).props.disabled, true)
  assert.equal(fx.button('Продовжити').disabled, true)
  fx.select(currentUserId)
  assert.equal(fx.button('Продовжити').disabled, true)
  assert.equal(fx.calls.length, 0)
})

test('search accepts Ukrainian names and @nicknames without changing roles', t => {
  const fx = fixture(t); fx.open()
  fx.input('search').onChange({ target: { value: 'СОФІЯ' } })
  assert.match(fx.text, /Софія Приклад/); assert.doesNotMatch(fx.text, /Данило Приклад/)
  fx.input('search').onChange({ target: { value: '@danylo' } })
  assert.match(fx.text, /Данило Приклад/); assert.doesNotMatch(fx.text, /Софія Приклад/)
  fx.input('search').onChange({ target: { value: 'no such member' } })
  assert.match(fx.text, /Нікого не знайдено/)
  assert.equal(fx.calls.length, 0)
})

test('review explains immediate transfer and preserved group; final acknowledgement is not checked for the user', t => {
  const fx = fixture(t); fx.open(); fx.select(); fx.review()
  assert.match(fx.text, /Підтвердьте нового старосту/)
  assert.match(fx.text, /одразу отримає/)
  assert.match(fx.text, /звичайний учасник/)
  assert.match(fx.text, /Розклад, ДЗ, матеріали та склад групи збережуться/)
  assert.equal(fx.input('checkbox').checked, false)
  assert.equal(fx.button('Передати права зараз').disabled, true)
  fx.button('Передати права зараз').onClick()
  assert.equal(fx.calls.length, 0)
})

test('one explicit final action runs once, stays busy and shows success only after acknowledgement', async t => {
  const fx = fixture(t); fx.open(); fx.select(); fx.review(); fx.acknowledge()
  const confirm = fx.button('Передати права зараз').onClick
  confirm(); confirm()
  assert.deepEqual(fx.calls, ['synthetic-sofia'])
  assert.equal(fx.button('Передати права зараз').disabled, true)
  assert.doesNotMatch(fx.text, /У групи новий староста/)
  assert.equal(fx.tree.props['aria-busy'], true)
  fx.pending[0].resolve(); await fx.settle()
  assert.match(fx.text, /У групи новий староста/)
  assert.match(fx.text, /Софія Приклад/)
  assert.match(fx.text, /Ви залишаєтеся учасником/)
  assert.equal(fx.tree.props['aria-busy'], false)
})

test('cancelling either step or pressing Escape never calls the transfer and resets acknowledgement', t => {
  const fx = fixture(t); fx.open(); fx.select(); fx.button('Скасувати').onClick()
  assert.equal(fx.calls.length, 0)
  fx.open(); fx.select(); fx.review(); fx.acknowledge()
  fx.tree.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(fx.calls.length, 0)
  fx.open(); fx.select(); fx.review()
  assert.equal(fx.input('checkbox').checked, false)
})

test('a mapped friendly failure unlocks retry without claiming that transfer succeeded', async t => {
  const fx = fixture(t); fx.open(); fx.select(); fx.review(); fx.acknowledge()
  fx.button('Передати права зараз').onClick()
  fx.pending[0].reject(new Error('Учасник більше не належить до групи. Оновіть список.')); await fx.settle()
  assert.match(fx.text, /Учасник більше не належить до групи/)
  assert.doesNotMatch(fx.text, /RAW_PROVIDER|У групи новий староста/)
  assert.equal(fx.tree.props['aria-busy'], false)
  fx.button('Передати права зараз').onClick()
  assert.equal(fx.calls.length, 2)
  fx.pending[1].resolve(); await fx.settle()
  assert.match(fx.text, /У групи новий староста/)
})

test('a removed or pending recipient cannot stay selected through the final confirmation', t => {
  const fx = fixture(t); fx.open(); fx.select(); fx.review(); fx.acknowledge()
  fx.update({ members: members.map(member => member.id === 'synthetic-sofia' ? { ...member, status: 'pending' } : member) })
  assert.match(fx.text, /учасник уже недоступний/)
  assert.equal(fx.button('Продовжити').disabled, true)
  assert.equal(fx.calls.length, 0)
})

test('ordinary members cannot open the controls and late success from another group cannot affect this one', async t => {
  const ordinary = fixture(t, { representativeId: 'someone-else' })
  assert.equal(ordinary.tree, null)
  const fx = fixture(t); fx.open(); fx.select(); fx.review(); fx.acknowledge(); fx.button('Передати права зараз').onClick()
  fx.update({ groupId: 'new-group', groupName: 'Нова група', members: members.map(member => ({ ...member, groupId: 'new-group' })) })
  assert.doesNotMatch(fx.text, /Софія Приклад|Остання перевірка|У групи новий староста/)
  fx.pending[0].resolve(); await fx.settle()
  assert.doesNotMatch(fx.text, /У групи новий староста/)
})

test('loading or globally disabled controls cannot begin a transfer', t => {
  for (const options of [{ loading: true }, { disabled: true }]) {
    const fx = fixture(t, options)
    assert.equal(fx.button('Передати права').disabled, true)
    assert.equal(fx.calls.length, 0)
  }
})
