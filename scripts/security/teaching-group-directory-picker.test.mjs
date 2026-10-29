// Actual directory helper and picker hooks; synthetic groups, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8')
function load(source, imports = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, require(name) { assert.ok(name in imports, name); return imports[name] } })
  return module.exports
}
const directory = load(await read('src/lib/teachingGroupDirectory.ts'))
const pickerSource = await read('src/components/teaching/TeachingGroupDirectoryPicker.tsx')
const group = (id, patch = {}) => ({ id, group_name: 'ЕУБ-4', study_year: 1, study_level: 'bachelor', university_slug: 'knu', academic_unit_slug: 'economics', academic_unit_name: 'Економічний факультет', specialty: 'Економіка та управління бізнесом (ЕУБ)', representative_name: 'Анастасія Прикладенко', identity_confirmed: true, identity_ready: true, ...patch })
const primary = group('year1'), second = group('year2', { study_year: 2, specialty: 'Економіка бізнесу (ЕБ)', group_name: 'ЕБ-4' }), fourth = group('year4', { study_year: 4 })
test('OP aliases work across Latin/Cyrillic mixtures only inside the verified KNU economics family, preserving original titles', () => {
  for (const query of ['ЕУБ 1 курс', 'EUB 1', 'EУБ 1', 'ЕУB 1', 'EB 1', 'EБ 1', 'ОП: eуб, курс: 1']) assert.equal(directory.teachingGroupDirectoryMatches(primary, query), true, query)
  for (const query of ['ЕУБ 2', 'EB 2 курс', 'EУБ 4 курс']) assert.equal(directory.teachingGroupDirectoryMatches(primary, query), false, query)
  for (const patch of [{ university_slug: 'another' }, { academic_unit_slug: 'mechanics', academic_unit_name: 'Механіко-математичний факультет' }, { specialty: 'Економічна кібернетика' }]) assert.equal(directory.teachingGroupDirectoryMatches(group('other', patch), 'EB 1'), false)
  const mixed = group('mixed', { specialty: 'Економіка та управління бізнесом (EУБ)' })
  assert.equal(directory.teachingGroupProgramKey(mixed), directory.teachingGroupProgramKey(primary))
  assert.equal(directory.teachingGroupProgramKey(primary), directory.teachingGroupProgramKey(second))
  assert.notEqual(directory.teachingGroupProgramKey(primary), directory.teachingGroupProgramKey(group('other', { university_slug: 'another' })))
  const options = directory.teachingGroupProgramOptions([primary, second, mixed])
  assert.equal(options.length, 1); assert.equal(options[0].label, 'ЕБ / ЕУБ · пошук за обома назвами')
  assert.ok(directory.teachingGroupDirectoryFullLabel(primary).includes(primary.specialty))
  assert.ok(directory.teachingGroupDirectoryFullLabel(second).includes(second.specialty))
})
test('group-code numbers remain group numbers with punctuation/dashes; separately supplied course filters are exact', () => {
  for (const query of ['ЕУБ-4', 'ЕУБ-4,', '(ЕУБ-4)', 'ЕУБ–4', 'EУБ-4; 1 курс', 'EB-4, 1 курс']) assert.equal(directory.teachingGroupDirectoryMatches(primary, query), true, query)
  assert.equal(directory.teachingGroupDirectoryMatches(second, 'ЕУБ-4,'), true)
  assert.equal(directory.teachingGroupDirectoryMatches(fourth, 'ЕУБ-4,'), true)
  for (const query of ['ЕУБ-3', 'ЕУБ-4 2 курс', 'ЕУБ-4, курс 4', 'ЕУБ 4']) assert.equal(directory.teachingGroupDirectoryMatches(primary, query), false, query)
  assert.equal(directory.teachingGroupMatchesFilters(primary, { query: 'ЕУБ-4,', course: '1', level: 'bachelor', program: directory.teachingGroupProgramKey(primary) }), true)
  assert.equal(directory.teachingGroupMatchesFilters(second, { query: 'ЕУБ-4,', course: '1', level: '', program: '' }), false)
})
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
function session(groups, groupId = '', disabled = false) {
  const state = [], changes = []; let cursor = 0, pending = [], dirty = false, tree, callbackTag = 'initial'
  let props = { groups, groupId, disabled }
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; dirty = true }] },
    useRef(value) { const index = cursor++; return state[index] ||= { current: value } },
    useMemo(fn, deps) { const index = cursor++; if (!state[index] || changed(state[index].deps, deps)) state[index] = { deps, value: fn() }; return state[index].value },
    useEffect(fn, deps) { const index = cursor++; if (!state[index] || changed(state[index].deps, deps)) { state[index] = { deps }; pending.push(fn) } },
  }
  const callback = () => { const tag = callbackTag; return id => { changes.push({ tag, id }); if (props.groupId !== id) { props = { ...props, groupId: id }; dirty = true } } }
  props.onSelect = callback()
  const jsx = (type, props) => ({ type, props: props || {} })
  const { TeachingGroupDirectoryPicker } = load(pickerSource, { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../../lib/teachingGroupDirectory': directory, './TeachingUI': { TeachingField: 'TeachingField', teachingInput: 'input' } })
  function render() { for (let turn = 0; turn < 15; turn++) { cursor = 0; dirty = false; pending = []; tree = TeachingGroupDirectoryPicker(props); for (const effect of pending) effect(); if (!dirty) return tree } throw Error('Picker hooks did not settle') }
  render()
  return { changes, get props() { return props }, nodes: () => nodes(tree), update(patch) { props = { ...props, ...patch }; return render() }, callback(tag) { callbackTag = tag; props = { ...props, onSelect: callback() }; render() }, change(name, value) { const field = nodes(tree).find(node => node.props.name === name); assert.ok(field, name); field.props.onChange({ target: { value } }); return render() } }
}
test('actual picker keeps compact choices and full selected identity, clears hidden selection after exact course/OP filter and resets filters', () => {
  const ui = session([primary, second], primary.id)
  const select = () => ui.nodes().find(node => node.props.name === 'group')
  assert.equal(select().props.value, primary.id)
  const selected = ui.nodes().find(node => node.props['aria-label'] === 'Вибрана група')
  assert.ok(selected); assert.ok(JSON.stringify(selected).includes(primary.specialty))
  const option = ui.nodes().find(node => node.type === 'option' && node.props.value === primary.id)
  assert.equal(option.props.children, directory.teachingGroupDirectoryLabel(primary)); assert.equal(option.props.title, directory.teachingGroupDirectoryFullLabel(primary))
  ui.change('group-directory-course', '2'); assert.equal(ui.props.groupId, ''); assert.equal(select().props.value, '')
  assert.equal(ui.nodes().some(node => node.type === 'option' && node.props.value === primary.id), false)
  ui.change('group', second.id); assert.equal(ui.props.groupId, second.id)
  ui.change('group-directory-search', 'ЕУБ 1 курс'); assert.equal(ui.props.groupId, ''); assert.equal(select().props.disabled, true)
  ui.nodes().find(node => node.type === 'button' && node.props.children === 'Скинути фільтри').props.onClick(); ui.update({}); assert.equal(select().props.disabled, false)
})
test('actual picker revalidates removed or newly unconfirmed selections, keeps latest callback and prevents unavailable/disabled target selection', () => {
  const waiting = group('waiting', { study_year: null, identity_confirmed: false })
  const ui = session([primary, second, waiting], primary.id)
  ui.callback('latest'); ui.update({ groups: [second, waiting] }); assert.equal(ui.props.groupId, ''); assert.deepEqual(ui.changes.slice(-1), [{ tag: 'latest', id: '' }])
  ui.change('group', waiting.id); assert.equal(ui.props.groupId, '')
  const unavailable = ui.nodes().find(node => node.type === 'option' && node.props.value === waiting.id); assert.equal(unavailable.props.disabled, true)
  ui.change('group', second.id); assert.equal(ui.props.groupId, second.id)
  ui.update({ groups: [{ ...second, identity_confirmed: false }] }); assert.equal(ui.props.groupId, '')
  ui.update({ groups: [primary], disabled: true }); const before = ui.changes.length
  ui.change('group', primary.id); ui.change('group-directory-search', 'anything'); assert.equal(ui.changes.length, before); assert.equal(ui.props.groupId, '')
  assert.equal(ui.nodes().find(node => node.props.name === 'group').props.disabled, true)
})
