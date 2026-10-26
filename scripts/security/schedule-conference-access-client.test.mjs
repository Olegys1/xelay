import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, URL, ...globals, require(key) { assert.ok(key in imports, key); return imports[key] } })
  return module.exports
}
const access = load(await read('src/lib/studyGroupLinks.ts'))
test('ID and leading-zero code work without a join URL and keep internal spaces', () => {
  assert.deepEqual(plain(access.normalizeScheduleConferenceAccess({ conference_id: ' 123 456 7890 ', conference_access_code: ' 001 234 ' })), { conference_id: '123 456 7890', conference_access_code: '001 234' })
  assert.deepEqual(plain(access.getStudyGroupLessonLinks({ conference_id: '123 456', conference_access_code: '001234' })), [])
})
test('old lessons and cleared access details remain valid and no code is required', () => {
  assert.deepEqual(plain(access.normalizeScheduleConferenceAccess({})), { conference_id: null, conference_access_code: null })
  assert.deepEqual(plain(access.normalizeScheduleConferenceAccess({ conference_id: '  ', conference_access_code: null })), { conference_id: null, conference_access_code: null })
  assert.deepEqual(plain(access.normalizeScheduleConferenceAccess({ conference_id: '123' })), { conference_id: '123', conference_access_code: null })
})
test('hidden controls, bidi overrides, non-text input, and excess characters are rejected', () => {
  for (const value of [123, {}, [], 'bad\ncode', 'bad\u0000code', 'bad\u202ecode', 'bad\u2067code', 'x'.repeat(121)]) {
    for (const field of ['conference_id', 'conference_access_code']) assert.throws(() => access.normalizeScheduleConferenceAccess({ [field]: value }))
  }
  assert.equal(access.normalizeScheduleConferenceAccess({ conference_id: 'x'.repeat(120) }).conference_id.length, 120)
})
test('URLs retain their validation and untrusted display text is never used as a link', () => {
  assert.deepEqual(plain(access.getStudyGroupLessonLinks({ online_url: 'javascript:alert(1)', conference_id: '<script>alert(1)</script>' })), [])
  assert.equal(access.getStudyGroupLessonLinks({ online_url: 'https://example.com/join', conference_id: '123' })[0].url, 'https://example.com/join')
})

const componentSource = await read('src/components/StudyGroupLessonLinks.tsx')
function componentFixture(clipboard) {
  const state = []
  const jsx = (type, props) => ({ type, props: props || {} })
  const ui = load(componentSource, {
    react: { useState: initial => [initial, next => state.push(next)] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': { Copy: 'CopyIcon', Check: 'CheckIcon', ExternalLink: 'LinkIcon' },
    '../lib/studyGroupLinks': access,
  }, { navigator: { clipboard } })
  const tree = ui.StudyGroupLessonLinks({ lesson: { subject: 'Вища математика', conference_id: '123 456', conference_access_code: '001234' } })
  function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
  return { tree, nodes: nodes(tree), state }
}
test('credential-only card copies ID and code separately and exactly', async () => {
  const writes = [], fx = componentFixture({ writeText: async text => writes.push(text) })
  assert.ok(fx.tree)
  assert.equal(fx.nodes.filter(node => node.type === 'a').length, 0)
  const buttons = fx.nodes.filter(node => node.type === 'button')
  assert.equal(buttons.length, 2)
  buttons[0].props.onClick(); await new Promise(setImmediate)
  buttons[1].props.onClick(); await new Promise(setImmediate)
  assert.deepEqual(writes, ['123 456', '001234'])
  assert.ok(fx.state.includes('Код доступу скопійовано'))
})
test('clipboard refusal leaves selectable credentials and gives an accessible fallback', async () => {
  const fx = componentFixture({ writeText: async () => { throw Error('clipboard unavailable') } })
  fx.nodes.find(node => node.type === 'button').props.onClick()
  await new Promise(setImmediate)
  assert.ok(fx.state.some(message => message.includes('скопіюйте вручну')))
  assert.ok(fx.nodes.some(node => node.type === 'span' && node.props.className?.includes('select-text')))
  assert.ok(fx.nodes.some(node => node.props.role === 'status' && node.props['aria-live'] === 'polite'))
})
