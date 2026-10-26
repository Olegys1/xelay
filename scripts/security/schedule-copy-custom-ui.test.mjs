// Real full copy component with its pure helpers and an in-memory adapter.
// Provider calls are a throwing stub: no Auth, Supabase client, fetch or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8')
function load(source, imports) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Date, Intl, setTimeout, require(name) { assert.ok(name in imports, 'Unexpected live import: ' + name); return imports[name] } })
  return module.exports
}
const pure = load(await read('src/lib/scheduleCopyTimes.ts'), {})
const blockedProvider = { supabase: { rpc() { throw new Error('LIVE_BACKEND_FORBIDDEN') } } }
const timetable = load(await read('src/lib/studyGroupTimetable.ts'), { './supabase': blockedProvider, './scheduleCopyTimes': pure })
const sequence = load(await read('src/lib/studyGroupScheduleSequence.ts'), { './supabase': blockedProvider, './studyGroupTimetable': timetable })
const local = load(await read('src/components/schedule/localScheduleCopyCustomRepository.ts'), { '../../lib/scheduleCopyTimes': pure })
const source = await read('src/components/GroupScheduleCopy.tsx')
const GROUP_1 = local.LOCAL_COPY_GROUPS[0].id, GROUP_2 = local.LOCAL_COPY_GROUPS[1].id
const TARGET = '2026-10-31'
const plain = value => JSON.parse(JSON.stringify(value))
const jsx = (type, props, key) => ({ type, props, key })
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const text = node => node == null || typeof node === 'boolean' ? '' : ['string', 'number'].includes(typeof node) ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : typeof node.type === 'function' && ['LessonCopyTime', 'FirstShiftMapping'].includes(node.type.name) ? text(node.type(node.props)) : text(node.props?.children)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]

function fixture(repository = local.createLocalScheduleCopyCustomRepository(), groupId = GROUP_1, targetDate = TARGET) {
  const cells = [], effects = [], calls = [], notices = []
  let cursor = 0, dirty = false, tree
  const hooks = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = cursor++; return cells[i] ??= { current: initial } },
    useId() { return 'local-test-' + cursor++ },
    useEffect(effect, deps) { const i = cursor++, previous = cells[i]; if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) { cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = effect() }) } },
  }
  const services = Object.fromEntries(Object.entries(repository.services).map(([name, method]) => [name, async (...args) => { calls.push({ name, args: plain(args) }); return method(...args) }]))
  const api = load(source, {
    react: hooks, 'react/jsx-runtime': runtime, 'lucide-react': new Proxy({}, { get: (_target, name) => String(name) }),
    '../context/ToastContext': { useToast: () => ({ notify: value => notices.push(value) }) },
    '../lib/studyGroupTimetable': timetable, '../lib/studyGroupScheduleSequence': sequence, '../lib/scheduleCopyTimes': pure,
  })
  const props = { groupId, targetDate, canEdit: true, services, onCopied: async () => true }
  function render() {
    for (let turn = 0; turn < 35; turn++) {
      dirty = false; cursor = 0
      const workspace = api.GroupScheduleCopy(props)
      tree = workspace.type(workspace.props)
      while (effects.length) effects.shift()()
      if (!dirty) return tree
    }
    throw new Error('Copy component did not settle')
  }
  async function flush() { for (let turn = 0; turn < 30; turn++) { await Promise.resolve(); render() } }
  const all = () => nodes(tree)
  const button = label => all().find(node => node.type === 'button' && text(node).trim() === label)
  const inputFor = label => { const wrapper = all().find(node => node.type === 'label' && text(node).includes(label)); return nodes(wrapper).find(node => node.type === 'input') }
  const mappings = () => all().filter(node => typeof node.type === 'function' && node.type.name === 'FirstShiftMapping')
  async function click(label) { const found = button(label); assert.ok(found, 'Missing button: ' + label); assert.equal(Boolean(found.props.disabled), false, 'Disabled button: ' + label); found.props.onClick(); await flush() }
  async function choose(value) { const radio = all().find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === value); assert.ok(radio, 'Missing radio: ' + value); radio.props.onChange({ target: { value, checked: true } }); await flush() }
  async function setInput(label, value) { const input = inputFor(label); assert.ok(input, 'Missing input: ' + label); input.props.onChange({ target: { value } }); await flush() }
  async function remember(checked) { const input = inputFor('Запам’ятати цей початок'); assert.ok(input); input.props.onChange({ target: { checked } }); await flush() }
  async function editMapping(at, patch, rowIndex = 0) {
    for (const [key, value] of Object.entries(patch)) {
      const mapping = mappings()[at]; assert.ok(mapping, 'Missing mapping: ' + at)
      const rendered = mapping.type(mapping.props)
      const input = key === 'target_lesson_number' ? nodes(rendered).filter(node => node.type === 'select')[rowIndex]
        : nodes(rendered).filter(node => node.type === 'input' && node.props.type === 'time')[rowIndex * 2 + (key === 'target_ends_at' ? 1 : 0)]
      assert.ok(input, 'Missing actual row control: ' + key)
      if (input.props.type === 'time') assert.ok(input.props.value.length <= 5, 'Canonical response seconds must not enter a time input')
      input.props.onChange({ target: { value } }); await flush()
    }
  }
  render()
  return { repository, calls, notices, render, flush, all, button, inputFor, mappings, click, choose, setInput, remember, editMapping, text: () => text(tree), get tree() { return tree }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
}

test('actual form loads distinct group defaults, previews08:30 and keeps untouched original-time path', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const first = fixture(repository); await first.click('Скопіювати розклад')
  assert.ok(first.calls.some(call => call.name === 'copyDay' && call.args[5] === 'original' && call.args.length === 7))
  await first.choose('first_shift')
  assert.equal(first.inputFor('Початок першої пари').props.value, '08:00')
  await first.setInput('Початок першої пари', '08:30')
  assert.match(first.text(), /08:30/); assert.ok(first.mappings().length)
  const preview = first.calls.filter(call => call.name === 'copyDay').at(-1)
  assert.deepEqual(preview.args[7], { firstShiftStart: '08:30', rememberFirstShiftStart: false })
  assert.equal(first.button('Скопіювати').props.disabled, false)
  first.unmount()
  const second = fixture(repository, GROUP_2); await second.click('Скопіювати розклад'); await second.choose('first_shift')
  assert.equal(second.inputFor('Початок першої пари').props.value, '08:30'); second.unmount()
})

test('per-row custom times appear in the actual preview; overlaps disable copy and editing recovers', async () => {
  const fx = fixture(); await fx.click('Скопіювати розклад'); await fx.choose('first_shift'); await fx.setInput('Початок першої пари', '08:30')
  await fx.editMapping(0, { target_starts_at: '08:35', target_ends_at: '09:45' })
  assert.match(fx.text(), /08:35/)
  const reviewed = fx.calls.filter(call => call.name === 'copyDay').at(-1).args[6]
  assert.equal(reviewed[0].target_starts_at.slice(0, 5), '08:35')
  await fx.editMapping(0, { target_starts_at: '09:50', target_ends_at: '10:30' }, 1)
  assert.equal(fx.button('Скопіювати').props.disabled, false)
  await fx.editMapping(0, { target_starts_at: '09:30', target_ends_at: '10:30' }, 1)
  assert.equal(fx.button('Скопіювати').props.disabled, true)
  assert.match(fx.text(), /не мають перетинатися/)
  await fx.editMapping(0, { target_starts_at: '10:10', target_ends_at: '11:15' }, 1)
  assert.equal(fx.button('Скопіювати').props.disabled, false); fx.unmount()
})

test('remember is atomic with successful copy, reopens for its own group and does not leak to another group', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const fx = fixture(repository); await fx.click('Скопіювати розклад'); await fx.choose('first_shift'); await fx.setInput('Початок першої пари', '09:00'); await fx.remember(true)
  assert.equal((await repository.services.loadSettings(GROUP_1)).first_shift_start, '08:00')
  repository.armFailure(); await fx.click('Скопіювати')
  assert.equal(repository.snapshot().records.length, 0)
  assert.equal((await repository.services.loadSettings(GROUP_1)).first_shift_start, '08:00')
  await fx.click('Оновити перегляд'); await fx.click('Скопіювати')
  assert.equal((await repository.services.loadSettings(GROUP_1)).first_shift_start, '09:00')
  await fx.click('Скопіювати розклад')
  assert.equal(fx.inputFor('Початок першої пари').props.value, '09:00')
  assert.equal(fx.inputFor('Запам’ятати цей початок').props.checked, false)
  assert.equal((await repository.services.loadSettings(GROUP_2)).first_shift_start, '08:30'); fx.unmount()
})

test('changed source cannot copy or remember until an actual new preview is reviewed and reconfirmed', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const fx = fixture(repository); await fx.click('Скопіювати розклад'); await fx.choose('first_shift'); await fx.setInput('Початок першої пари', '08:30'); await fx.remember(true)
  const oldSignature = fx.calls.filter(call => call.name === 'copyDay').at(-1)
  repository.armSourceChange(); await fx.click('Скопіювати')
  assert.equal(repository.snapshot().records.length, 0)
  assert.equal((await repository.services.loadSettings(GROUP_1)).first_shift_start, '08:00')
  assert.equal(fx.button('Скопіювати').props.disabled, true); assert.match(fx.text(), /Розклад.*змінилися/)
  await fx.click('Оновити перегляд')
  assert.match(fx.text(), /оновлено/); assert.equal(fx.button('Скопіювати').props.disabled, false)
  await fx.click('Скопіювати')
  const commit = fx.calls.filter(call => call.name === 'copyDay' && call.args[3] === false).at(-1)
  assert.ok(commit.args[4]); assert.equal(oldSignature.args[4], null)
  assert.equal(repository.snapshot().records.length, 3); fx.unmount()
})

test('one-Saturday and many-Saturday sequences use target-date maps and keep independent custom times', async () => {
  const fx = fixture(); await fx.click('Скопіювати розклад'); await fx.choose('sequence'); await fx.choose('first_shift')
  await fx.setInput('Копіювати до дати включно', TARGET)
  assert.equal(fx.mappings().length, 1)
  await fx.setInput('Копіювати до дати включно', '2026-11-14')
  assert.equal(fx.mappings().length, 3)
  await fx.editMapping(1, { target_starts_at: '08:05', target_ends_at: '09:15' })
  const request = fx.calls.filter(call => call.name === 'copySequence').at(-1)
  assert.ok(request.args[5]['2026-11-07'])
  assert.equal(request.args[5]['2026-11-07'][0].target_starts_at.slice(0, 5), '08:05')
  assert.equal(request.args[5]['2026-10-31'], undefined)
  assert.match(fx.text(), /Дат:\s+3/)
  await fx.click('Скопіювати всі дати')
  assert.equal(fx.repository.snapshot().records.length, 9)
  assert.equal(fx.repository.snapshot().records.find(row => row.targetDate === '2026-10-31').startsAt.slice(0, 5), '08:00')
  assert.equal(fx.repository.snapshot().records.find(row => row.targetDate === '2026-11-07').startsAt.slice(0, 5), '08:05'); fx.unmount()
})

test('Sunday starts separately at08:00 and cannot remember the Saturday preference', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const fx = fixture(repository, GROUP_2, '2026-11-01'); await fx.click('Скопіювати розклад'); await fx.choose('first_shift')
  assert.equal(fx.inputFor('Початок першої пари').props.value, '08:00')
  assert.equal(fx.inputFor('Запам’ятати цей початок').props.disabled, true)
  await fx.click('Скопіювати')
  assert.equal((await repository.services.loadSettings(GROUP_2)).first_shift_start, '08:30'); fx.unmount()
})

test('memory adapter supports exact retry after remembered-setting revision bump without duplicate rows', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const args = [GROUP_1, '2026-10-26', TARGET, true, null, 'first_shift', [], { firstShiftStart: '08:30', rememberFirstShiftStart: true }]
  const preview = await repository.services.copyDay(...args)
  const first = await repository.services.copyDay(...[...args.slice(0, 3), false, preview.source_signature, ...args.slice(5)])
  const retry = await repository.services.copyDay(...[...args.slice(0, 3), false, preview.source_signature, ...args.slice(5)])
  assert.equal(first.copied, 3); assert.equal(retry.copied, 0); assert.equal(retry.skipped, 3)
  assert.equal(repository.snapshot().records.length, 3)
  assert.equal((await repository.services.loadSettings(GROUP_1)).revision, 1)
})

test('a newer remembered copy rejects stale earlier approval without rewinding settings; same-value copies keep the latest change receipt', async () => {
  const repository = local.createLocalScheduleCopyCustomRepository()
  const first = fixture(repository)
  await first.click('Скопіювати розклад'); await first.choose('first_shift'); await first.setInput('Початок першої пари', '08:30'); await first.remember(true); await first.click('Скопіювати')
  const approvalA = first.calls.filter(call => call.name === 'copyDay' && call.args[3] === false).at(-1).args
  first.unmount()

  const second = fixture(repository, GROUP_1, '2026-11-07')
  await second.click('Скопіювати розклад'); await second.choose('first_shift')
  assert.equal(second.inputFor('Початок першої пари').props.value, '08:30')
  await second.setInput('Початок першої пари', '09:00'); await second.remember(true); await second.click('Скопіювати')
  const approvalB = second.calls.filter(call => call.name === 'copyDay' && call.args[3] === false).at(-1).args
  assert.deepEqual(plain(await repository.services.loadSettings(GROUP_1)), { first_shift_start: '09:00', revision: 2 })
  const beforeStaleRetry = repository.snapshot()
  await assert.rejects(repository.services.copyDay(...approvalA), /TIMETABLE_COPY_SOURCE_CHANGED/)
  assert.deepEqual(repository.snapshot(), beforeStaleRetry)
  second.unmount()

  const options = { firstShiftStart: '09:00', rememberFirstShiftStart: true }
  const previewC = await repository.services.copyDay(GROUP_1, '2026-11-09', '2026-11-14', true, null, 'first_shift', [], options)
  await repository.services.copyDay(GROUP_1, '2026-11-09', '2026-11-14', false, previewC.source_signature, 'first_shift', [], options)
  assert.equal((await repository.services.loadSettings(GROUP_1)).revision, 2)
  const retryB = await repository.services.copyDay(...approvalB)
  assert.equal(retryB.source_signature, approvalB[4]); assert.equal(retryB.copied, 0); assert.equal(retryB.skipped, 3)
  assert.equal(repository.snapshot().records.length, 9)
  await assert.rejects(repository.services.copyDay(...approvalA), /TIMETABLE_COPY_SOURCE_CHANGED/)
  assert.deepEqual(plain(await repository.services.loadSettings(GROUP_1)), { first_shift_start: '09:00', revision: 2 })

  repository.armSourceChange()
  await assert.rejects(repository.services.copyDay(...approvalB), /TIMETABLE_COPY_SOURCE_CHANGED/)
  assert.equal(repository.snapshot().records.length, 9)
  assert.equal((await repository.services.loadSettings(GROUP_1)).first_shift_start, '09:00')
})
