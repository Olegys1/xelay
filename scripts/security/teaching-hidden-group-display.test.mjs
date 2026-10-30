// Actual material-editor handlers with synthetic state only. No network or storage.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const source = await read('src/components/teaching/TeachingMaterialLibraryEditor.tsx')
function load(text, imports = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Date, Intl, AbortController, ...globals, require(name) { assert.ok(name in imports, 'Known import: ' + name); return imports[name] } })
  return module.exports
}
const visibility = load(await read('src/lib/studyGroupVisibility.ts'))
const hidden = '445fcadc-95e2-4f8c-bfb3-6d0998030a01'
const real = 'd54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
const ordinary = 'a0000000-0000-4000-8000-000000000002'
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree)

function fixture() {
  const cells = [], writes = []
  let index = 0, tree
  const react = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useRef(value) { const i = index++; cells[i] ??= { current: value }; return cells[i] },
    useEffect() {},
  }
  const jsx = (type, props) => ({ type, props })
  const ui = Object.fromEntries(['TeachingButton', 'TeachingField', 'TeachingModal'].map(name => [name, name]))
  ui.teachingInput = 'input'
  const api = load(source, {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../../lib/teaching': { teachingError: error => error.message, localDeadline: () => '', TEACHING_FILE_ACCEPT: '', TEACHING_MAX_FILE_BYTES: 52428800, validateTeachingFile() {}, validateTeachingPublicationLinks: () => ({ links: [], link_labels: {} }) },
    '../../lib/teachingMaterialLibrary': { TEACHING_MATERIAL_TITLE_LIMIT: 240, TEACHING_MATERIAL_BODY_LIMIT: 65536 },
    '../../lib/teachingMaterialPreview': { canPreviewTeachingMaterial: () => true },
    '../../lib/studyGroupVisibility': visibility,
    '../../lib/resourceLinkLabels': { getResourceLinkTitles: links => links.map(() => ''), MAX_RESOURCE_LINK_LABEL_LENGTH: 80 },
    '../../lib/legal': {}, './TeachingPublicationTimingFields': { publicationTime: () => null, validatePublicationTiming() {} },
    './TeachingUI': ui, './teaching-material-library-editor.css': {},
  })
  const groups = Object.freeze([
    Object.freeze({ group_id: hidden, group_name: 'Hidden test group', status: 'accepted' }),
    Object.freeze({ group_id: real, group_name: 'ЕУБ-4', status: 'accepted' }),
    Object.freeze({ group_id: ordinary, group_name: 'МА-2', status: 'accepted' }),
  ])
  const targets = Object.freeze([hidden, real].map(group_id => Object.freeze({ group_id })))
  const material = Object.freeze({ id: 'material', course_id: 'course', version: 1, targets, title: 'Existing draft', body: '', links: [], attachments: [], status: 'draft', can_edit: true, can_manage_groups: true })
  const props = { material, data: { courses: [{ course: { id: 'course', permissions: ['materials'], archived_at: null }, groups }] }, userId: 'teacher', repository: { mode: 'local', async mutate(action, payload) { writes.push({ action, payload }) } }, onClose() {}, async onSaved() {} }
  function render() { index = 0; tree = api.TeachingMaterialLibraryEditor(props); return tree }
  render()
  return { groups, material, writes, get tree() { return tree },
    button(label) { const node = nodes(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(node); return node },
    click(label) { this.button(label).props.onClick(); render() },
    async save() { await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render() },
  }
}

test('material group picker hides test IDs while preserving original targets on an ordinary update', async () => {
  const fx = fixture()
  const boxes = nodes(fx.tree).filter(node => node.type === 'input' && String(node.props.name).startsWith('library-material-group-'))
  assert.deepEqual(boxes.map(node => node.props.name), [`library-material-group-${real}`, `library-material-group-${ordinary}`])
  assert.ok(text(fx.tree).includes('ЕУБ-4'))
  assert.ok(!text(fx.tree).includes('Hidden test group'))
  await fx.save()
  assert.equal(fx.writes.length, 1)
  assert.deepEqual(Array.from(fx.writes[0].payload.target_group_ids), [hidden, real])
  assert.equal(fx.material.targets.length, 2)
  assert.equal(fx.groups.length, 3)
})

test('material select-all and clear affect only listed groups, keeping hidden existing targets', async () => {
  const cleared = fixture()
  cleared.click('Прибрати вибір')
  await cleared.save()
  assert.deepEqual(Array.from(cleared.writes[0].payload.target_group_ids), [hidden])
  const selected = fixture()
  selected.click('Усі групи')
  await selected.save()
  assert.deepEqual(Array.from(selected.writes[0].payload.target_group_ids), [hidden, real, ordinary])
})
