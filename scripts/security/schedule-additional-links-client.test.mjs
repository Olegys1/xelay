import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read = file => readFile(new URL('../../' + file, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function load(source, imports = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, URL, require(name) { assert.ok(name in imports, name); return imports[name] } })
  return module.exports
}
const links = load(await read('src/lib/studyGroupLinks.ts'))
const extra = [{ url: 'https://example.test/third', label: 'Резервний Zoom' }, { url: 'https://example.test/fourth', label: '' }]
test('many named links preserve the first two established links and independent conference credentials', () => {
  const lesson = { online_url: 'https://example.test/one', online_url_secondary: 'https://example.test/two', online_url_label: 'Основне', online_url_secondary_label: 'Запасне', online_links_extra: extra, conference_id: '123 456', conference_access_code: '000067' }
  assert.deepEqual(plain(links.getStudyGroupLessonLinks(lesson)), [
    { slot: 1, url: lesson.online_url, label: 'Основне' }, { slot: 2, url: lesson.online_url_secondary, label: 'Запасне' },
    { slot: 3, ...extra[0] }, { slot: 4, url: extra[1].url, label: 'Посилання 4' },
  ])
  assert.deepEqual(plain(links.normalizeScheduleConferenceAccess(lesson)), { conference_id: '123 456', conference_access_code: '000067' })
  assert.equal(links.normalizeScheduleExtraLinks(Array.from({ length: 18 }, (_, i) => ({ url: `https://example.test/${i}`, label: String(i) }))).length, 18)
})
test('extra link validation rejects unsafe, spoofed, oversized and malformed payloads without truncating user input', () => {
  for (const invalid of [{}, 'https://example.test', Array(19).fill(extra[0]), [null], [['x']], [{ url: 4 }], [{ url: extra[0].url, unknown: 'x' }], [{ url: '', label: 'No URL' }], [{ url: 'javascript:alert(1)' }], [{ url: 'data:text/html,hello' }], [{ url: 'https://user:password@example.test/x' }], [{ url: 'https://example.test/\nspoof' }], [{ url: extra[0].url, label: 'bad\u202Etext' }], [{ url: extra[0].url, label: 'x'.repeat(81) }], [{ url: 'https://example.test/' + 'x'.repeat(2000) }]]) assert.throws(() => links.normalizeScheduleExtraLinks(invalid))
  assert.deepEqual(plain(links.normalizeScheduleExtraLinks([{ url: '  https://example.test/hello  ', label: '  Резерв  ' }, { url: '', label: '' }])), [{ url: 'https://example.test/hello', label: 'Резерв' }])
  assert.deepEqual(plain(links.getStudyGroupLessonLinks({ online_url: 'https://example.test/one', online_links_extra: [{ url: 'javascript:alert(1)' }, ...extra] })).map(({ slot, url }) => [slot, url]), [[1, 'https://example.test/one'], [3, extra[0].url], [4, extra[1].url]])
})
const home = load(await read('src/lib/homeLessonConference.ts'), { './homeDashboardModel': {}, './studyGroupLinks': links })
test('home joins the first explicitly provided valid URL, including extras-only lessons, without guessing a provider', () => {
  assert.equal(home.homeLessonConference({ online_links_extra: extra }).href, extra[0].url)
  assert.equal(home.homeLessonConference({ online_url: 'https://example.test/one', online_links_extra: extra }).href, 'https://example.test/one')
  assert.equal(home.homeLessonConference({ online_url: 'javascript:bad', online_url_secondary: 'https://example.test/two', online_links_extra: extra }).href, 'https://example.test/two')
  assert.deepEqual(plain(home.homeLessonConference({ online_links_extra: [{ url: 'javascript:bad' }], conference_id: '123', conference_access_code: '000067' })), { meetingId: '123', passcode: '000067' })
  assert.equal(home.homeLessonConference({ online_links_extra: [{ url: 'javascript:bad' }] }), undefined)
})
const jsx = (type, props) => ({ type, props: props || {} })
const fields = load(await read('src/components/schedule/ScheduleAdditionalLinksFields.tsx'), { 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { Plus: 'Plus', Trash2: 'Trash' }, '../../lib/studyGroupLinks': links })
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
const card = load(await read('src/components/StudyGroupLessonLinks.tsx'), { react: { useState: initial => [initial, () => {}] }, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': { Copy: 'Copy', Check: 'Check', ExternalLink: 'ExternalLink' }, '../lib/studyGroupLinks': links })
test('actual lesson card renders every validated link with safe external attributes and separate meeting credentials', () => {
  const tree = nodes(card.StudyGroupLessonLinks({ lesson: { online_url: 'https://example.test/one', online_url_secondary: 'https://example.test/two', online_links_extra: extra, conference_id: '123', conference_access_code: '000067' } }))
  const anchors = tree.filter(node => node.type === 'a')
  assert.deepEqual(anchors.map(node => node.props.href), ['https://example.test/one', 'https://example.test/two', ...extra.map(item => item.url)])
  assert.ok(anchors.every(node => node.props.target === '_blank' && node.props.rel.includes('noopener')))
  assert.equal(tree.filter(node => node.type === 'button').length, 2)
})
test('actual controlled form adds, labels, edits and removes third/fourth links while respecting disabled state and maximum', () => {
  let value = extra
  const render = (disabled = false) => nodes(fields.ScheduleAdditionalLinksFields({ links: value, disabled, onChange: next => { value = next } }))
  const add = tree => tree.find(node => node.type === 'button' && !node.props['aria-label'])
  add(render()).props.onClick(); assert.equal(value.length, 3)
  const inputs = render().filter(node => node.type === 'input')
  inputs[4].props.onChange({ target: { value: 'https://example.test/five' } }); assert.equal(value[2].url, 'https://example.test/five')
  render().find(node => node.props['aria-label'] === 'Прибрати посилання 4').props.onClick(); assert.equal(value.length, 2); assert.equal(value[1].url, 'https://example.test/five')
  assert.ok(render(true).filter(node => node.type === 'button' || node.type === 'input').every(node => node.props.disabled))
  value = Array.from({ length: 18 }, () => extra[0]); assert.equal(add(render()).props.disabled, true)
})
