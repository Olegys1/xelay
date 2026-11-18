import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(path, imports, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, Blob, URL, AbortController, crypto: webcrypto,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unexpected import: ' + name); return imports[name] }, ...globals })
  return module.exports
}
const id = randomUUID(), ownerId = randomUUID(), file = { id, ownerId, path: `${ownerId}/company/${id}.pdf`, kind: 'company', name: 'test.pdf', size: 9, mime: 'application/pdf' }
const blob = () => new Blob(['%PDF-test'], { type: 'application/pdf' })
function client({ metadata = file, downloaded = blob(), error = null, beforeDownload } = {}) {
  const calls = []
  const supabase = {
    rpc(name, args) { calls.push({ name, args }); return { async abortSignal(signal) { calls.push({ signal }); return { data: metadata, error } } } },
    storage: { from(bucket) { return { async download(path, options, parameters) { calls.push({ bucket, path, options, parameters }); await beforeDownload?.(); return { data: downloaded, error: null } }, createSignedUrl() { throw Error('Signing must never be used') } } } },
  }
  return { calls, supabase, api: load('src/lib/opportunities/privateDocument.ts', { '../supabase': { supabase } }) }
}
test('each private document open reauthorizes, uses authenticated download without caching and validates bytes', async () => {
  const { api, calls } = client(), signal = new AbortController().signal
  for (let n = 0; n < 2; n++) { const result = await api.loadPrivateDocument(id, signal); assert.equal(result.file.id, id); assert.equal(await result.blob.text(), '%PDF-test') }
  assert.equal(calls.filter(c => c.name === 'xelay_opportunities_document_access').length, 2)
  const downloads = calls.filter(c => c.bucket)
  assert.equal(downloads.length, 2); assert.notEqual(downloads[0].options.cacheNonce, downloads[1].options.cacheNonce)
  for (const call of downloads) { assert.equal(call.bucket, 'opportunities-private'); assert.equal(call.path, file.path); assert.equal(call.parameters.cache, 'no-store'); assert.equal(call.parameters.signal, signal) }
})
test('malformed, foreign or unauthorized metadata never triggers a download', async () => {
  for (const metadata of [null, { ...file, id: randomUUID() }, { ...file, kind: 'resume' }, { ...file, path: 'https://foreign.test/private.pdf' }, { ...file, ownerId: undefined }, { ...file, size: 20 * 1024 * 1024 }, { ...file, mime: 'text/html' }]) {
    const { api, calls } = client({ metadata }); await assert.rejects(api.loadPrivateDocument(id, new AbortController().signal)); assert.equal(calls.filter(c => c.bucket).length, 0)
  }
  const { api, calls } = client(); await assert.rejects(api.loadPrivateDocument('../outside', new AbortController().signal)); assert.equal(calls.length, 0)
})
test('invalid PDF bytes, mismatched size and cancellation cannot render a document', async () => {
  for (const downloaded of [new Blob(['<html>bad'], { type: 'application/pdf' }), new Blob(['%PDF-too-large'], { type: 'application/pdf' }), new Blob(['%PDF-test'], { type: 'text/html' })]) {
    const { api } = client({ downloaded }); await assert.rejects(api.loadPrivateDocument(id, new AbortController().signal))
  }
  const controller = new AbortController(), { api } = client({ beforeDownload: () => controller.abort() })
  await assert.rejects(api.loadPrivateDocument(id, controller.signal), { name: 'AbortError' })
})
test('company link contains only a file ID; other attachment signing keeps its existing expiry', async () => {
  const signed = [], { api } = client()
  const supabase = { storage: { from() { return { async createSignedUrl(...args) { signed.push(args); return { data: { signedUrl: 'https://example.test/signed' } } } } } } }
  const { createSupabaseOpportunitiesRepository } = load('src/lib/opportunities/supabaseRepository.ts', {
    '../supabase': { supabase }, './privateDocument': api, '../authEmail': {}, '../authRegistration': {}, '../legal': {},
  }, { window: { location: { origin: 'https://www.xelay.ink' } } })
  const repo = createSupabaseOpportunitiesRepository()
  assert.equal(await repo.fileUrl(file), `https://www.xelay.ink/business/document/${id}`); assert.equal(signed.length, 0)
  await repo.fileUrl({ ...file, kind: 'resume', path: `${ownerId}/resume/${id}.pdf` }); assert.equal(signed.length, 1); assert.equal(signed[0][1], 60)
})

function viewer() {
  let auth = { authUser: { id: ownerId }, authReadEpoch: 0, isLoading: false, authReadBlocked: false }
  const cells = [], pendingEffects = [], requests = [], revoked = [], listeners = new Map()
  let cursor = 0, dirty = false, tree, props = { fileId: id }, created = 0
  const hooks = {
    useState(initial) { const n = cursor++; cells[n] ??= { value: initial }; return [cells[n].value, next => { const value = typeof next === 'function' ? next(cells[n].value) : next; if (!Object.is(value, cells[n].value)) { cells[n].value = value; dirty = true } }] },
    useEffect(fn, deps) { const n = cursor++, old = cells[n]; if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) { cells[n] = { deps, cleanup: old?.cleanup }; pendingEffects.push(() => { old?.cleanup?.(); cells[n].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  const { PrivateOrganizationDocumentPage: Component } = load('src/pages/PrivateOrganizationDocumentPage.tsx', {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@tanstack/react-router': { Link: 'a' },
    'lucide-react': { ArrowLeft: 'icon', Loader2: 'icon', ShieldCheck: 'icon' }, '../context/AuthContext': { useAuth: () => auth },
    '../components/GroupPresentationPdfPreview': { GroupPresentationPdfPreview: 'PDF' },
    '../lib/opportunities/privateDocument': { loadPrivateDocument(fileId, signal) { return new Promise(resolve => requests.push({ fileId, signal, resolve })) } },
  }, {
    URL: { createObjectURL() { return 'blob:synthetic-' + ++created }, revokeObjectURL(url) { revoked.push(url) } },
    window: { addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name) } },
  })
  function render(effects = true) {
    for (let n = 0; n < 20; n++) { dirty = false; cursor = 0; tree = Component(props); if (!effects) return tree; pendingEffects.splice(0).forEach(fn => fn()); if (!dirty) return tree }
    throw Error('Unstable render')
  }
  function pdf(node = tree) { if (!node || typeof node !== 'object') return null; if (node.type === 'PDF') return node; for (const child of [node.props?.children].flat(Infinity).filter(child => child != null)) { const found = pdf(child); if (found) return found } return null }
  render()
  return { requests, revoked, listeners, pdf, render, setAuth(next) { auth = { ...auth, ...next } }, resolve(n) { requests[n].resolve({ file, blob: blob() }) }, async settle() { for (let n = 0; n < 8; n++) { await Promise.resolve(); render() } }, unmount() { cells.forEach(c => c.cleanup?.()) } }
}
test('viewer hides old bytes before effects on account switch and ignores a late request', async () => {
  const v = viewer(); v.setAuth({ authUser: { id: randomUUID() }, authReadEpoch: 1 }); v.render(false); assert.equal(v.pdf(), null)
  v.render(); assert.equal(v.requests[0].signal.aborted, true); v.resolve(0); await v.settle(); assert.equal(v.pdf(), null)
  v.resolve(1); await v.settle(); assert.ok(v.pdf()); v.setAuth({ authUser: null, authReadEpoch: 2 }); v.render(false); assert.equal(v.pdf(), null)
  v.render(); assert.equal(v.revoked.length, 1); v.unmount()
})
test('restored browser history reauthorizes; logout and unmount revoke object URLs', async () => {
  const v = viewer(); v.resolve(0); await v.settle(); assert.ok(v.pdf())
  v.listeners.get('pagehide')(); v.render(); assert.equal(v.pdf(), null); assert.equal(v.revoked.length, 1)
  v.listeners.get('pageshow')(); v.render(); assert.equal(v.requests.length, 2); v.resolve(1); await v.settle(); assert.ok(v.pdf())
  v.unmount(); assert.equal(v.revoked.length, 2); assert.equal(v.requests[1].signal.aborted, true)
})
