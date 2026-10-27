// Functional checks with synthetic classmates only. No network, live database or audit tool.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
const root = fileURLToPath(new URL('../', import.meta.url)), native = createRequire(import.meta.url)
function fixture(runtime = {}) {
  const modules = new Map()
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(code, {
      module, exports: module.exports, structuredClone, crypto, Date, URL, Blob, File, AbortController, DOMException, setTimeout, clearTimeout,
      console, fetch: () => { throw new Error('A local fixture cannot use the network') }, ...runtime,
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw new Error('Live Supabase is blocked') } }) }
        if (name.endsWith('/teaching') || name === './teaching') return { supabaseTeachingRepository: { mode: 'local' } }
        if (name.startsWith('.')) return load(resolve(dirname(filename), `${name}.ts`))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  const api = load('src/lib/studyGroupPresentations.ts'), ids = api.LOCAL_GROUP_PRESENTATION_IDS
  const author = api.createLocalGroupPresentationRepository('author'), classmate = api.createLocalGroupPresentationRepository('classmate'), teacher = api.createLocalGroupPresentationRepository('teacher'), head = api.createLocalGroupPresentationRepository('head')
  const draft = () => ({ ...api.emptyGroupPresentationDraft('Економічна теорія'), title: 'Ринкова рівновага', links: [{ label: 'Презентація', url: 'https://example.org/presentation.pdf' }] })
  return { api, ids, author, classmate, teacher, head, draft }
}
test('a student shares a presentation with classmates and keeps authorship', async () => {
  const fx = fixture(), id = crypto.randomUUID()
  await fx.author.save(fx.ids.group, id, 0, fx.draft())
  const data = await fx.classmate.list(fx.ids.group)
  assert.equal(data.presentations.length, 1); assert.equal(data.presentations[0].created_by, fx.ids.author)
  assert.equal(data.presentations[0].author_name, 'Марія Прикладенко'); assert.equal(data.can_moderate, false)
})
test('classmates may publish their own work but cannot update or delete another author', async () => {
  const fx = fixture(), id = crypto.randomUUID()
  await fx.author.save(fx.ids.group, id, 0, fx.draft())
  await assert.rejects(() => fx.classmate.save(fx.ids.group, id, 1, fx.draft()), /GROUP_PRESENTATION_FORBIDDEN/)
  await assert.rejects(() => fx.classmate.delete(fx.ids.group, id, 1), /GROUP_PRESENTATION_FORBIDDEN/)
  await fx.classmate.save(fx.ids.group, crypto.randomUUID(), 0, fx.draft())
  assert.equal((await fx.author.list(fx.ids.group)).presentations.length, 2)
})
test('a teacher-only actor cannot list, publish, read a file, update or delete student presentations', async () => {
  const fx = fixture(); fx.api.seedLocalGroupPresentations()
  const item = (await fx.author.list(fx.ids.group)).presentations[0]
  await assert.rejects(() => fx.teacher.list(fx.ids.group), /GROUP_PRESENTATION_ACCESS/)
  await assert.rejects(() => fx.teacher.save(fx.ids.group, crypto.randomUUID(), 0, fx.draft()), /GROUP_PRESENTATION_ACCESS/)
  await assert.rejects(() => fx.teacher.fileUrl(item.attachments[0]), /GROUP_PRESENTATION_ACCESS/)
  await assert.rejects(() => fx.teacher.delete(fx.ids.group, item.id, item.version), /GROUP_PRESENTATION_ACCESS/)
})
test('group scope cannot be changed by a client argument', async () => {
  const fx = fixture(), another = crypto.randomUUID()
  await assert.rejects(() => fx.author.list(another), /GROUP_PRESENTATION_ACCESS/)
  await assert.rejects(() => fx.author.save(another, crypto.randomUUID(), 0, fx.draft()), /GROUP_PRESENTATION_ACCESS/)
})
test('an author updates the canonical presentation and stale versions do not overwrite it', async () => {
  const fx = fixture(), id = crypto.randomUUID(), draft = fx.draft()
  const first = await fx.author.save(fx.ids.group, id, 0, draft)
  const next = await fx.author.save(fx.ids.group, id, first.version, { ...draft, title: 'Оновлена презентація' })
  assert.equal(next.version, 2); assert.equal(next.created_by, first.created_by); assert.equal(next.created_at, first.created_at)
  await assert.rejects(() => fx.author.save(fx.ids.group, id, first.version, draft), /GROUP_PRESENTATION_CONFLICT/)
  assert.equal((await fx.classmate.list(fx.ids.group)).presentations[0].title, 'Оновлена презентація')
})
test('retrying the same initial creation is idempotent', async () => {
  const fx = fixture(), id = crypto.randomUUID(), draft = fx.draft()
  const first = await fx.author.save(fx.ids.group, id, 0, draft), repeated = await fx.author.save(fx.ids.group, id, 0, draft)
  assert.equal(first.id, repeated.id); assert.equal(repeated.version, 1); assert.equal((await fx.author.list(fx.ids.group)).presentations.length, 1)
})
test('presentation validation requires a resource, a real date and safe links', () => {
  const fx = fixture(), draft = fx.draft()
  assert.throws(() => fx.api.validateGroupPresentationDraft({ ...draft, links: [] }), /Додайте файл/)
  assert.throws(() => fx.api.validateGroupPresentationDraft({ ...draft, lesson_date: '2026-02-30' }), /правильну дату/)
  assert.throws(() => fx.api.validateGroupPresentationDraft({ ...draft, links: [{ label: '', url: 'javascript:alert(1)' }] }), /коректну адресу/)
  assert.throws(() => fx.api.validateGroupPresentationDraft({ ...draft, subject: 'x' }), /предмет/)
})
test('50 MiB is accepted and oversize/unsupported files are rejected without allocating large buffers', () => {
  const fx = fixture(), file = { name: 'Презентація.pdf', type: 'application/pdf', size: 50 * 1024 * 1024 }
  assert.equal(fx.api.validateGroupPresentationFile(file).mime, 'application/pdf')
  assert.throws(() => fx.api.validateGroupPresentationFile({ ...file, size: file.size + 1 }), /50 МБ/)
  assert.throws(() => fx.api.validateGroupPresentationFile({ name: 'run.exe', type: 'application/octet-stream', size: 10 }), /формат/)
})
test('seeded private PDF can be opened by classmates and stays available while referenced', async () => {
  const fx = fixture(); fx.api.seedLocalGroupPresentations()
  const item = (await fx.author.list(fx.ids.group)).presentations[0], file = item.attachments[0]
  const url = await fx.classmate.fileUrl(file)
  assert.match(url, /^blob:/)
  const bytes = await fetch(url).then(response => response.text())
  assert.ok(bytes.startsWith('%PDF-1.4')); assert.ok(bytes.endsWith('%%EOF'))
  await fx.author.removeFiles([file.path])
  assert.equal(await fx.classmate.fileUrl(file), url)
})
test('deleting a presentation immediately removes classmates file access', async () => {
  const fx = fixture(); fx.api.seedLocalGroupPresentations()
  const item = (await fx.author.list(fx.ids.group)).presentations[0]
  await fx.author.delete(fx.ids.group, item.id, item.version)
  await assert.rejects(() => fx.classmate.fileUrl(item.attachments[0]), /GROUP_PRESENTATION_FILE/)
  assert.equal((await fx.classmate.list(fx.ids.group)).presentations.length, 0)
})
test('the local download uses a distinct attachment blob while PDF preview keeps its native MIME', async () => {
  const fx = fixture(); fx.api.seedLocalGroupPresentations()
  const file = (await fx.author.list(fx.ids.group)).presentations[0].attachments[0]
  const view = await fx.classmate.fileUrl(file), download = await fx.classmate.fileUrl(file, true)
  assert.notEqual(view, download)
  const [previewResponse, downloadResponse] = await Promise.all([fetch(view), fetch(download)])
  assert.equal(previewResponse.headers.get('content-type'), 'application/pdf')
  assert.equal(downloadResponse.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await previewResponse.text(), await downloadResponse.text())
})
test('downloads use an available browser host bridge just like the existing workbook export', async () => {
  const calls = [], fx = fixture({ chrome: { downloads: { async download(options) { calls.push(options); return 17 } } } })
  await fx.api.startGroupPresentationDownload('blob:synthetic', 'Презентація.pdf')
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'blob:synthetic'); assert.equal(calls[0].filename, 'Презентація.pdf'); assert.equal(calls[0].saveAs, true)
})
test('browser fallback activates a link inside the open modal and removes it afterwards', async () => {
  let appended = 0, clicked = 0, removed = 0
  const anchor = { click() { clicked++ }, remove() { removed++ } }, dialog = { appendChild(node) { assert.equal(node, anchor); appended++ } }
  const fx = fixture({ document: { createElement: () => anchor, querySelector: () => dialog, body: { appendChild() { throw new Error('The page behind the modal is inert') } } } })
  await fx.api.startGroupPresentationDownload('blob:synthetic', 'Презентація.pdf')
  assert.equal(appended, 1); assert.equal(clicked, 1); assert.equal(removed, 1); assert.equal(anchor.download, 'Презентація.pdf')
})
test('the head can moderate a presentation without impersonating or editing its author', async () => {
  const fx = fixture(); fx.api.seedLocalGroupPresentations()
  const item = (await fx.head.list(fx.ids.group)).presentations[0]
  assert.equal((await fx.head.list(fx.ids.group)).can_moderate, true)
  await assert.rejects(() => fx.head.save(fx.ids.group, item.id, item.version, fx.draft()), /GROUP_PRESENTATION_FORBIDDEN/)
  await fx.head.delete(fx.ids.group, item.id, item.version)
  assert.equal((await fx.author.list(fx.ids.group)).presentations.length, 0)
})
test('foreign or forged file paths cannot be attached to a new student presentation', async () => {
  const fx = fixture(), file = { path: `${fx.ids.group}/${fx.ids.classmate}/${crypto.randomUUID()}.pdf`, file_name: 'file.pdf', mime_type: 'application/pdf', file_size: 40 }
  await assert.rejects(() => fx.author.save(fx.ids.group, crypto.randomUUID(), 0, { ...fx.draft(), attachments: [file] }), /GROUP_PRESENTATION_FILE/)
})
