// Actual React handlers with synthetic hooks and repositories only. No network,
// browser account, local storage, private files, or production database writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = file => readFile(new URL(file, root), 'utf8')
function load(source, imports, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, URL, Intl, Date, Error, ...globals, require(name) { assert.ok(name in imports, 'Known import ' + name); return imports[name] } })
  return module.exports
}
const labels = load(await read('src/lib/resourceLinkLabels.ts'), {})
const teaching = load(await read('src/lib/teaching.ts'), {
  './supabase': { supabase: {} }, './seminarResources': { validateSeminarFile() {} }, './homeworkResources': { HOMEWORK_FILE_ACCEPT: '' },
  './seminars': { kyivToday: () => '2026-10-18', seminarStartMilliseconds: ({ lesson_date, starts_at }) => Date.parse(`${lesson_date}T${starts_at}:00+03:00`) },
  './resourceLinkLabels': labels,
})
const source = await read('src/components/teaching/TeachingPublications.tsx')
const draftSource = await read('src/lib/teachingPublicationDraft.ts')
const directory = load(await read('src/lib/teachingGroupDirectory.ts'), {})
const groupVisibility = load(await read('src/lib/studyGroupVisibility.ts'), {})
const plain = value => JSON.parse(JSON.stringify(value))
const baseItem = overrides => ({ id: 'item', course_id: 'course', title: 'Ринкова рівновага', body: '', links: [], attachments: [], targets: [{ group_id: 'group' }], status: 'draft', published_at: null, created_by: 'teacher', author_name: 'Викладач', version: 1, ...overrides })
const baseSnapshot = overrides => ({ course: { id: 'course', title: 'Економіка', starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null, permissions: ['assignments', 'materials', 'grades'], grading_rules: { categories: [] } }, groups: [{ group_id: 'group', group_name: 'МА-2', status: 'accepted' }, { group_id: 'other', group_name: 'МА-3', status: 'accepted' }], assignments: [], materials: [], ...overrides })
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (Array.isArray(tree)) return tree.map(text).join('')
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree)
}
function fixture(component = 'PublicationEditor', overrides = {}) {
  let index = 0, tree, closes = 0, refreshes = 0
  const cells = [], effects = [], listeners = new Map(), calls = []
  const storage = overrides.storage || new Map()
  const window = { sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, addEventListener: (event, listener) => listeners.set(event, listener), removeEventListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event) } }
  const drafts = load(draftSource, {}, { window })
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useRef(initial) { const i = index++; if (!cells[i]) cells[i] = { current: initial }; return cells[i] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const ui = Object.fromEntries(['TeachingButton', 'TeachingEmpty', 'TeachingField', 'TeachingModal'].map(name => [name, name])); ui.teachingInput = 'input'
  const icons = Object.fromEntries(['Copy', 'Download', 'ExternalLink', 'FileText', 'Info', 'Loader2', 'Pencil', 'Plus', 'Send', 'Trash2', 'UsersRound', 'X'].map(name => [name, name]))
  const api = load(source + '\nexport { PublicationEditor, AssignmentCopyEditor };', {
    react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'lucide-react': icons, '../../lib/teaching': teaching, '../../lib/resourceLinkLabels': labels, './TeachingUI': ui,
    '../../lib/teachingPublicationDraft': drafts, '../../lib/teachingGroupDirectory': directory,
    '../../lib/studyGroupVisibility': groupVisibility,
    './TeachingSubmissionReview': { TeachingSubmissionReview: 'TeachingSubmissionReview' },
  }, { crypto: { randomUUID }, window })
  const repository = { classroomMutate: async (action, payload) => { calls.push({ action, payload }); return {} }, mutate: async (action, payload) => { calls.push({ action, payload }); return {} }, upload: async () => { throw Error('No uploads expected') } }
  const props = { kind: 'assignment', initial: null, groupId: 'group', snapshot: baseSnapshot(), publication: baseItem({}), repository, userId: 'teacher', onClose: () => closes++, onRefresh: async () => { refreshes++ }, ...overrides }
  function render() { index = 0; tree = api[component](props); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { render, calls, listeners, props, storage, get tree() { return tree }, get closes() { return closes }, get refreshes() { return refreshes },
    find(predicate) { const result = nodes(tree).find(predicate); assert.ok(result, 'Expected rendered element'); return result },
    input(name, value) { this.find(node => node.props?.name === name).props.onChange({ target: { value } }); render() },
    button(label) { return this.find(node => ['TeachingButton', 'button'].includes(node.type) && text(node) === label) },
    closeModal() { this.find(node => node.type === 'TeachingModal').props.onClose(); render() },
    async save(status = 'draft') { await this.find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, nativeEvent: { submitter: { getAttribute: () => status } } }); for (let i = 0; i < 20; i++) await Promise.resolve(); render() },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('publication link names preserve legacy string URLs and stay attached after reorder/removal', () => {
  const lecture = 'https://example.test', seminar = 'https://example.test/seminar'
  assert.deepEqual(plain(teaching.validateTeachingPublicationLinks([lecture, seminar, ` ${lecture} `], [' Лекція ', 'Семінар', 'Duplicate'])), { links: [lecture, seminar], link_labels: { [lecture]: 'Лекція', [seminar]: 'Семінар' } })
  assert.deepEqual(plain(teaching.validateTeachingPublicationLinks([seminar], [''])), { links: [seminar], link_labels: {} })
  assert.equal(teaching.validateTeachingPublicationLinks([lecture], ['🦛'.repeat(80)]).link_labels[lecture], '🦛'.repeat(80))
  for (const title of ['x'.repeat(81), 'line\nbreak', 'control\u0085']) assert.throws(() => teaching.validateTeachingPublicationLinks([lecture], [title]))
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test']) assert.throws(() => teaching.validateTeachingPublicationLinks([url], ['Назва']))
})

test('resources display names safely, legacy fallback remains and unsafe URLs stay unclickable', () => {
  const a = 'https://example.test/lecture', b = 'https://example.test/notes'
  const fx = fixture('TeachingResources', { publication: baseItem({ links: [a, b, 'javascript:alert(1)'], link_labels: { [a]: '<b>Лекція</b>' } }) })
  const anchors = nodes(fx.tree).filter(node => node.type === 'a')
  assert.equal(anchors.length, 2); assert.equal(text(anchors[0]), '<b>Лекція</b>'); assert.equal(text(anchors[1]), 'Посилання 2')
  assert.equal(anchors[0].props.dangerouslySetInnerHTML, undefined)
})

test('unchanged editor closes immediately; changes require explicit discard and preserve every field', () => {
  const clean = fixture(); clean.closeModal(); assert.equal(clean.closes, 1); assert.equal(clean.listeners.size, 0)
  const fx = fixture(); fx.input('publication-title', 'Незбережена назва'); fx.input('publication-body', 'Великий текст завдання')
  assert.ok(fx.listeners.has('beforeunload'))
  fx.closeModal(); assert.equal(fx.closes, 0); assert.ok(text(fx.tree).includes('Зміни ще не збережено'))
  fx.button('Продовжити редагування').props.onClick(); fx.render()
  assert.equal(fx.find(node => node.props?.name === 'publication-body').props.value, 'Великий текст завдання')
  fx.button('Скасувати').props.onClick(); fx.render(); assert.equal(fx.closes, 0)
  fx.button('Закрити без збереження').props.onClick(); assert.equal(fx.closes, 1)
  let prevented = false; const event = { preventDefault() { prevented = true } }; fx.listeners.get('beforeunload')(event)
  assert.equal(prevented, true); assert.equal(event.returnValue, '')
  fx.unmount(); assert.equal(fx.listeners.size, 0)
})

test('reverting an edit removes dirty protection; changing a link name marks the editor dirty', () => {
  const fx = fixture('PublicationEditor', { initial: baseItem({}) })
  fx.input('publication-title', 'Інше'); fx.input('publication-title', 'Ринкова рівновага')
  assert.equal(fx.listeners.has('beforeunload'), false)
  fx.input('publication-link-title-0', 'Лекція'); fx.closeModal(); assert.equal(fx.closes, 0)
})

test('copied unassigned drafts are visible only to editors and show an assignment action', () => {
  const item = baseItem({ targets: [] }), snapshot = baseSnapshot({ assignments: [item] })
  const fx = fixture('TeachingPublications', { snapshot })
  assert.ok(text(fx.tree).includes(item.title)); assert.ok(text(fx.tree).includes('Ще не додано до групи'))
  assert.ok(fx.button('Додати до цієї групи'))
  assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingButton' && text(node) === 'Здані роботи'))
  const reader = fixture('TeachingPublications', { snapshot, readonly: true })
  assert.ok(!text(reader.tree).includes(item.title))
  const colleague = fixture('TeachingPublications', { snapshot: { ...snapshot, course: { ...snapshot.course, permissions: ['grades'] } } })
  assert.ok(!text(colleague.tree).includes(item.title))
})

test('unassigned semester draft saves to selected accepted group with link names and original version', async () => {
  const fx = fixture('PublicationEditor', { initial: baseItem({ targets: [], links: ['https://example.test/lecture'], link_labels: { 'https://example.test/lecture': 'Лекція' } }) })
  await fx.save('published')
  assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].action, 'save_group_assignment')
  const payload = plain(fx.calls[0].payload)
  assert.equal(payload.id, 'item'); assert.equal(payload.version, 1)
  assert.deepEqual(payload.targets, [{ group_id: 'group', due_at: null }]); assert.equal(payload.status, 'published')
  assert.deepEqual(payload.links, ['https://example.test/lecture']); assert.deepEqual(payload.link_labels, { 'https://example.test/lecture': 'Лекція' })
  assert.equal(fx.closes, 1); assert.equal(fx.refreshes, 1); assert.equal(fx.listeners.has('beforeunload'), false)
})

test('material editor saves named URLs while keeping all other material targets', async () => {
  const fx = fixture('PublicationEditor', { kind: 'material', initial: baseItem({ targets: [{ group_id: 'group' }, { group_id: 'other' }] }) })
  fx.input('publication-link-0', 'https://example.test/slides'); fx.input('publication-link-title-0', 'Презентація')
  await fx.save()
  assert.equal(fx.calls[0].action, 'save_material')
  assert.deepEqual(plain(fx.calls[0].payload.targets), [{ group_id: 'other' }, { group_id: 'group', due_at: null }])
  assert.deepEqual(plain(fx.calls[0].payload.link_labels), { 'https://example.test/slides': 'Презентація' })
})

test('SPA back/unmount preserves a scoped recoverable draft; explicit discard clears it', () => {
  const storage = new Map(), fx = fixture('PublicationEditor', { storage })
  fx.input('publication-title', 'Чернетка після Назад'); fx.input('publication-body', 'Зберегти цей довгий текст')
  fx.input('publication-link-0', 'https://example.test/lecture'); fx.input('publication-link-title-0', 'Лекція')
  assert.equal(storage.size, 1); fx.unmount()
  const reopened = fixture('PublicationEditor', { storage })
  assert.equal(reopened.find(node => node.props?.name === 'publication-title').props.value, 'Чернетка після Назад')
  assert.equal(reopened.find(node => node.props?.name === 'publication-body').props.value, 'Зберегти цей довгий текст')
  assert.equal(reopened.find(node => node.props?.name === 'publication-link-title-0').props.value, 'Лекція')
  assert.ok(text(reopened.tree).includes('Відновлено незбережені зміни'))
  for (const context of [{ userId: 'other' }, { groupId: 'other' }, { kind: 'material' }, { snapshot: baseSnapshot({ course: { ...baseSnapshot().course, id: 'other-course' } }) }]) {
    const unrelated = fixture('PublicationEditor', { storage, ...context })
    assert.equal(unrelated.find(node => node.props?.name === 'publication-title').props.value, '', 'No cross-account/group/course draft restore')
  }
  reopened.closeModal(); reopened.button('Закрити без збереження').props.onClick(); assert.equal(storage.size, 0)
})

test('confirmed save clears the session draft; browser-blocked storage remains safe', async () => {
  const storage = new Map(), fx = fixture('PublicationEditor', { storage })
  fx.input('publication-title', 'Збережений текст'); assert.equal(storage.size, 1)
  await fx.save(); assert.equal(storage.size, 0)
  const blocked = { get() { throw Error('Storage blocked') }, set() { throw Error('Storage blocked') }, delete() { throw Error('Storage blocked') } }
  const unavailable = fixture('PublicationEditor', { storage: blocked })
  unavailable.input('publication-title', 'Текст без сховища'); unavailable.render()
  assert.ok(text(unavailable.tree).includes('Браузер не дозволяє відновлення чернетки'))
  unavailable.closeModal(); assert.equal(unavailable.closes, 0)
})

test('unuploaded files are named on restore and cannot silently disappear from a submitted draft', async () => {
  const storage = new Map(), fx = fixture('PublicationEditor', { storage })
  fx.input('publication-title', 'З файлом')
  fx.find(node => node.props?.name === 'publication-files').props.onChange({ target: { files: [{ name: 'lecture.pdf', size: 20 }], value: 'file' } }); fx.render(); fx.unmount()
  const reopened = fixture('PublicationEditor', { storage })
  assert.ok(text(reopened.tree).includes('lecture.pdf'))
  await reopened.save(); assert.equal(reopened.calls.length, 0)
  assert.ok(text(reopened.tree).includes('Повторно додайте незавантажені файли'))
  reopened.button('Продовжити без цих файлів').props.onClick(); reopened.render()
  await reopened.save(); assert.equal(reopened.calls.length, 1); assert.equal(storage.size, 0)
})

test('draft reader rejects malformed/oversized data and a newer server version', () => {
  const drafts = load(draftSource, {}), store = new Map(), storage = { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
  const fields = { selectedGroup: 'group', title: 'Draft', body: '', links: ['https://example.test'], linkTitles: ['Лекція'], attachments: [], deadline: '', assessed: false, maxPoints: '10', category: '' }
  const value = { version: 1, source_version: 2, editor_id: randomUUID(), fields, pending_file_names: [] }
  assert.equal(drafts.writeTeachingPublicationDraft('key', value, storage), true)
  assert.equal(drafts.readTeachingPublicationDraft('key', 2, storage).fields.title, 'Draft')
  assert.equal(drafts.readTeachingPublicationDraft('key', 3, storage), null)
  for (const raw of ['{invalid', 'x'.repeat(200001), JSON.stringify({ ...value, fields: { ...fields, links: {} } }), JSON.stringify({ ...value, editor_id: '../../other' })]) {
    store.set('key', raw); assert.equal(drafts.readTeachingPublicationDraft('key', 2, storage), null)
  }
})
