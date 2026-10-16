import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const page = await readFile(new URL('src/pages/MessagesPage.tsx', root), 'utf8')
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const addSource = page.slice(page.indexOf('  const addSelectedMedia ='), page.indexOf('  const handleMediaSelection ='))
assert.ok(addSource.includes('return true'), 'exercise the actual production attachment validator')
const constants = page.slice(page.indexOf('const MAX_MESSAGE_MEDIA_FILES'), page.indexOf('interface ConversationSummary'))

function mediaHarness(files = [], cachedBytes = 0) {
  const state = { files, error: '', writes: 0 }
  const context = {
    filesRef: { current: files }, selectedId: 'target',
    threadCache: { current: new Map([['other', { files: [{ size: cachedBytes }] }]]) },
    setError(value) { state.error = value },
    setSelectedMedia(value) { state.files = value; state.writes++ },
  }
  vm.createContext(context)
  vm.runInContext(compile(`${constants}\n${addSource}\nglobalThis.add = addSelectedMedia`), context)
  return { state, add: context.add }
}
const photo = (size = 500_000) => ({ name: 'xelay-dual-photo.jpg', type: 'image/jpeg', size })

test('dual photo uses the existing direct-message image validation and queues locally', () => {
  const { state, add } = mediaHarness()
  const file = photo()
  assert.equal(add([file]), true)
  assert.equal(state.files.length, 1)
  assert.equal(state.files[0], file)
  assert.equal(state.error, '')
  assert.equal(state.writes, 1)
  assert.doesNotMatch(addSource, /supabase|\.upload\(|\.rpc\(/)
})

test('direct-message file count, type and per-file size stay enforced', () => {
  for (const [existing, incoming, expected] of [
    [Array.from({ length: 5 }, () => photo()), photo(), /не більше 5/],
    [[], { ...photo(), type: 'image/svg+xml' }, /не підтримується/],
    [[], photo(25 * 1024 * 1024 + 1), /завеликий/],
  ]) {
    const { state, add } = mediaHarness(existing)
    assert.equal(add([incoming]), false)
    assert.match(state.error, expected)
    assert.equal(state.writes, 0)
  }
})

test('direct-message aggregate and cached-draft byte limits stay enforced', () => {
  const full = mediaHarness([photo(25 * 1024 * 1024), photo(25 * 1024 * 1024)])
  assert.equal(full.add([photo()]), false)
  assert.match(full.state.error, /50 МБ/)
  const cached = mediaHarness([], 100 * 1024 * 1024)
  assert.equal(cached.add([photo()]), false)
  assert.match(cached.state.error, /чернетках забагато/)
  assert.equal(cached.state.writes, 0)
})

test('rapid successive additions validate against the latest attachment draft', () => {
  const { state, add } = mediaHarness(Array.from({ length: 4 }, () => photo()))
  assert.equal(add([photo()]), true)
  assert.equal(add([photo()]), false)
  assert.equal(state.files.length, 5)
  assert.equal(state.writes, 1)
})

const handlerSource = page.slice(page.indexOf('onCapture={(file) => {') + 'onCapture={'.length, page.indexOf('}} />', page.indexOf('onCapture={(file) => {')) + 1)
assert.ok(handlerSource.includes('conversationSelectionVersion'), 'exercise actual guarded capture callback')
function captureHarness(overrides = {}) {
  const capture = { id: 'capture', userId: 'owner', conversationId: 'target', selectionVersion: 2 }
  const state = { queued: 0, closed: 0, focused: 0 }
  const context = {
    dualPhotoCapture: capture, dualPhotoCaptureRef: { current: capture },
    conversationSelectionVersion: { current: 2 }, mediaAvailable: true,
    isCurrent: (user, target) => user === 'owner' && target === 'target',
    addSelectedMedia: () => { state.queued++; return true },
    closeDualPhotoCapture: () => { state.closed++; context.dualPhotoCaptureRef.current = null },
    composerRef: { current: { focus: () => state.focused++ } },
    requestAnimationFrame: (callback) => callback(), ...overrides,
  }
  vm.createContext(context)
  vm.runInContext(compile(`globalThis.capture = ${handlerSource}`), context)
  return { state, capture: context.capture }
}

test('capture queues once for its original conversation; a late duplicate is ignored', () => {
  const { state, capture } = captureHarness()
  assert.equal(capture(photo()), true)
  assert.equal(capture(photo()), false)
  assert.deepEqual(state, { queued: 1, closed: 1, focused: 1 })
})

test('capture cannot cross accounts, destinations, selection epochs or closed sessions', () => {
  for (const overrides of [
    { isCurrent: () => false },
    { dualPhotoCaptureRef: { current: null } },
    { dualPhotoCaptureRef: { current: { id: 'replacement' } } },
    { conversationSelectionVersion: { current: 3 } },
    { mediaAvailable: false },
  ]) {
    const { state, capture } = captureHarness(overrides)
    assert.equal(capture(photo()), false)
    assert.deepEqual(state, { queued: 0, closed: 0, focused: 0 })
  }
})

test('a rejected attachment stays in review and cannot trigger sending', () => {
  const { state, capture } = captureHarness({ addSelectedMedia: () => false })
  assert.equal(capture(photo()), false)
  assert.deepEqual(state, { queued: 0, closed: 0, focused: 0 })
  assert.doesNotMatch(handlerSource, /sendMessage|\.upload\(|\.rpc\(/)
})

test('hosting permits only same-origin camera and keeps microphone disabled', async () => {
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'))
  const policy = config.headers.find((entry) => entry.source === '/(.*)').headers.find((entry) => entry.key === 'Permissions-Policy').value
  assert.match(policy, /^camera=\(self\), microphone=\(\)/)
  const generator = await readFile(new URL('scripts/security/update-headers.mjs', root), 'utf8')
  assert.ok(generator.includes(`'Permissions-Policy': '${policy}'`), 'header regeneration must retain the camera policy')
  assert.match(page, /label: 'Подвійне фото'.*onSelect: openDualPhotoCapture/)
})
