import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url)), native = createRequire(import.meta.url)
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const modules = new Map(), storage = new Map()
  function load(path) {
    const filename = resolve(root, path)
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    const code = ts.transpileModule(readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, structuredClone, crypto: { randomUUID }, Date, URL, Blob, File, AbortController, DOMException, TextEncoder, TextDecoder, setTimeout, clearTimeout,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      window: { addEventListener() {}, removeEventListener() {} }, fetch() { throw Error('Local test cannot use a network') },
      require(name) {
        if (name.endsWith('/supabase') || name === './supabase') return { supabase: new Proxy({}, { get() { throw Error('No live Supabase traffic allowed') } }) }
        if (name.startsWith('.')) return load(resolve(dirname(filename), name + (name.endsWith('.ts') ? '' : '.ts')))
        return native(name)
      },
    }, { filename })
    return module.exports
  }
  return { load, storage }
}

test('local announcement preview counts only selected synthetic audiences without writing or contacting a service', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingAudienceRepository.ts')
  api.resetLocalTeachingAudiencePreview()
  const teacher = api.createLocalTeachingAudienceRepository('teacher').audiences
  const original = plain(await teacher.context(uuid(21)))
  const all = await teacher.previewRecipients(uuid(21), [{ group_id: uuid(11), audience_mode: 'all' }, { group_id: uuid(12), audience_mode: 'all' }], uuid(1))
  assert.equal(all.recipient_count, 3, 'the same student in two selected groups receives only one message')
  assert.deepEqual(plain(all.group_counts), [{ group_id: uuid(11), count: 2 }, { group_id: uuid(12), count: 2 }])
  const subgroup = await teacher.previewRecipients(uuid(21), [{ group_id: uuid(11), audience_mode: 'subgroups', subgroup_ids: [uuid(801)] }], uuid(1))
  assert.equal(subgroup.recipient_count, 1)
  const team = await teacher.previewRecipients(uuid(21), [{ group_id: uuid(11), audience_mode: 'teams', team_ids: [uuid(811)] }], uuid(1))
  assert.equal(team.recipient_count, 2)
  assert.deepEqual(plain(await teacher.context(uuid(21))), original, 'recipient preview must never publish or acknowledge')
  await assert.rejects(teacher.previewRecipients(uuid(21), [{ group_id: uuid(11), audience_mode: 'all' }], uuid(2)), /ACTOR_CHANGED/)
  await assert.rejects(teacher.previewRecipients(uuid(21), [{ group_id: uuid(11), audience_mode: 'subgroups', subgroup_ids: [uuid(999)] }], uuid(1)), /INVALID/)
  await assert.rejects(api.createLocalTeachingAudienceRepository('colleague').audiences.previewRecipients(uuid(21), [{ group_id: uuid(12), audience_mode: 'all' }], uuid(4)), /FORBIDDEN/)
})

test('local mandatory publication persists own explicit acknowledgements and resets them only for a new version', async () => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingAudienceRepository.ts')
  api.resetLocalTeachingAudiencePreview()
  const teacher = api.createLocalTeachingAudienceRepository('teacher').audiences
  const student = api.createLocalTeachingAudienceRepository('student').audiences
  const head = api.createLocalTeachingAudienceRepository('head').audiences
  const payload = { id: uuid(940), course_id: uuid(21), version: 0, title: 'Наступне заняття онлайн', body: 'Будь ласка, підтвердьте, що побачили зміну.', targets: [{ group_id: uuid(11), audience_mode: 'all' }], requires_acknowledgement: true, expected_user_id: uuid(1) }
  await teacher.mutate('save_announcement', payload)
  const own = (await student.messages(uuid(11))).announcements.find(message => message.id === payload.id)
  const other = (await head.messages(uuid(11))).announcements.find(message => message.id === payload.id)
  assert.equal(own.requires_acknowledgement, true)
  assert.ok(own.notification_id)
  assert.notEqual(own.notification_id, other.notification_id)
  assert.equal(own.acknowledged_at, null)
  assert.equal((await teacher.receipts(payload.id, uuid(1))).acknowledged, 0, 'loading a message and receipts never acknowledges it')
  await assert.rejects(student.acknowledge(other.notification_id, uuid(2)), /FORBIDDEN/)
  await assert.rejects(student.acknowledge(own.notification_id, uuid(3)), /ACTOR_CHANGED/)
  await assert.rejects(student.receipts(payload.id, uuid(2)), /FORBIDDEN/)
  await student.acknowledge(own.notification_id, uuid(2))
  const result = await teacher.receipts(payload.id, uuid(1))
  assert.equal(result.total, 2); assert.equal(result.acknowledged, 1)
  assert.ok(result.recipients.find(recipient => recipient.user_id === uuid(2)).acknowledged_at)
  assert.ok(result.recipients.every(recipient => !('notification_id' in recipient)))
  assert.equal((await head.messages(uuid(11))).announcements.find(message => message.id === payload.id).acknowledged_at, null)
  const stamp = (await student.messages(uuid(11))).announcements.find(message => message.id === payload.id).acknowledged_at
  await student.acknowledge(own.notification_id, uuid(2))
  assert.equal((await teacher.receipts(payload.id, uuid(1))).recipients.find(recipient => recipient.user_id === uuid(2)).acknowledged_at, stamp)
  assert.equal(JSON.parse(fx.storage.get('xelay-local-teaching-audiences-v1')).announcements.find(row => row.id === payload.id).requires_acknowledgement, true)
  await teacher.mutate('save_announcement', { ...payload, version: 1, body: 'Оновлене повідомлення', targets: [{ group_id: uuid(11), audience_mode: 'subgroups', subgroup_ids: [uuid(801)] }] })
  assert.equal((await teacher.receipts(payload.id, uuid(1))).total, 1)
  assert.equal((await teacher.receipts(payload.id, uuid(1))).acknowledged, 0)
  await assert.rejects(student.acknowledge(own.notification_id, uuid(2)), /FORBIDDEN/)
  assert.ok(!(await head.messages(uuid(11))).announcements.some(message => message.id === payload.id))
  const revised = (await student.messages(uuid(11))).announcements.find(message => message.id === payload.id)
  assert.notEqual(revised.notification_id, own.notification_id)
  await student.acknowledge(revised.notification_id, uuid(2))
  await teacher.mutate('save_announcement', { ...payload, version: 2, requires_acknowledgement: false })
  assert.equal((await teacher.receipts(payload.id, uuid(1))).total, 0)
  assert.equal((await student.messages(uuid(11))).announcements.find(message => message.id === payload.id).notification_id, null)
  await assert.rejects(student.acknowledge(revised.notification_id, uuid(2)), /FORBIDDEN/)
})
