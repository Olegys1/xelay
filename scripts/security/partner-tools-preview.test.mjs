import test from 'node:test'
import assert from 'node:assert/strict'
import { createPartnerToolsPreview, partnerPreviewDay } from '../../src/lib/partnerToolsPreview.ts'

const actor = '26666666-6666-4666-8666-666666666666'
const today = '2026-11-12'
function setup() {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  let at = Date.parse('2026-11-12T12:00:00Z')
  const now = () => at
  return { ...createPartnerToolsPreview({ storage, now }), storage, now, values, advance: ms => { at += ms } }
}
const stats = app => app.api.listAdmin(today, today)

test('public catalogue includes only the three synthetic published tools and returns copies', async () => {
  const app = setup()
  const rows = await app.api.listPublic()
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.status === 'published' && row.destinationUrl.startsWith('https://example.com/')))
  rows[0].name = 'Changed outside the repository'
  assert.equal((await app.api.listPublic())[0].name, 'Нотатник')
})
test('draft publication becomes visible and hiding removes it without deleting its statistics', async () => {
  const app = setup()
  const draft = (await stats(app)).items.find(row => row.status === 'draft')
  await app.api.save({ ...draft, status: 'published', sortOrder: 0 }, actor)
  const published = (await app.api.listPublic())[0]
  assert.equal(published.id, draft.id)
  await app.api.recordClick(published.id, 'catalog')
  await app.api.save({ ...published, status: 'hidden' }, actor)
  assert.ok(!(await app.api.listPublic()).some(row => row.id === published.id))
  assert.equal((await stats(app)).items.find(row => row.id === published.id).clicks, 1)
})
test('a stale edit cannot overwrite the newly saved value', async () => {
  const app = setup()
  const original = (await app.api.listPublic())[0]
  const current = await app.api.save({ ...original, name: 'Нова назва' }, actor)
  assert.notEqual(current.updatedAt, original.updatedAt)
  await assert.rejects(app.api.save({ ...original, name: 'Втрачена зміна' }, actor), /PARTNER_TOOL_CHANGED/)
  assert.equal((await app.api.listPublic())[0].name, 'Нова назва')
})
test('repeated clicks across home and catalogue count once for the same tool for 30 minutes', async () => {
  const app = setup()
  const tool = (await app.api.listPublic())[0]
  const before = (await stats(app)).items.find(row => row.id === tool.id).clicks
  await Promise.all(Array.from({ length: 100 }, (_, n) => app.api.recordClick(tool.id, n % 2 ? 'catalog' : 'home')))
  assert.equal((await stats(app)).items.find(row => row.id === tool.id).clicks, before + 1)
  app.advance(30 * 60 * 1000 - 1)
  await app.api.recordClick(tool.id, 'catalog')
  assert.equal((await stats(app)).items.find(row => row.id === tool.id).clicks, before + 1)
  app.advance(1)
  await app.api.recordClick(tool.id, 'catalog')
  assert.equal((await stats(app)).items.find(row => row.id === tool.id).clicks, before + 2)
})
test('hidden and unknown tools do not receive clicks', async () => {
  const app = setup()
  const hidden = (await stats(app)).items.find(row => row.status === 'hidden')
  await app.api.recordClick(hidden.id, 'catalog')
  await app.api.recordClick('unknown', 'home')
  assert.equal((await stats(app)).items.find(row => row.id === hidden.id).clicks, 0)
})
test('statistics use Kyiv dates and keep source attribution', async () => {
  assert.equal(partnerPreviewDay(Date.parse('2026-11-12T22:15:00Z')), '2026-11-13')
  const app = setup()
  const tool = (await app.api.listPublic())[0]
  await app.api.recordClick(tool.id, 'home')
  const daily = (await stats(app)).daily.find(row => row.toolId === tool.id && row.date === today && row.source === 'home')
  assert.ok(daily.clicks >= 1)
  assert.deepEqual(await app.api.listAdmin('2026-11-14', '2026-11-14').then(data => data.daily), [])
  await assert.rejects(app.api.listAdmin('2026-02-31', today), /PARTNER_TOOL_INPUT_INVALID/)
  await assert.rejects(app.api.listAdmin(today, '2026-11-11'), /PARTNER_TOOL_INPUT_INVALID/)
})
test('edits and deduplication survive a local reload', async () => {
  const app = setup()
  const tool = (await app.api.listPublic())[0]
  await app.api.save({ ...tool, name: 'Збережена назва' }, actor)
  await app.api.recordClick(tool.id, 'catalog')
  const before = (await stats(app)).items.find(row => row.id === tool.id).clicks
  const restored = createPartnerToolsPreview({ storage: app.storage, now: app.now })
  assert.equal((await restored.api.listPublic())[0].name, 'Збережена назва')
  await restored.api.recordClick(tool.id, 'home')
  assert.equal((await stats(restored)).items.find(row => row.id === tool.id).clicks, before)
})
test('unsafe destinations are rejected without changing the stored card', async () => {
  const app = setup()
  const tool = (await app.api.listPublic())[0]
  for (const destinationUrl of ['javascript:alert(1)', 'http://example.com/', 'https://user:pass@example.com/', 'https://127.0.0.1/', 'https://example.com:444/']) {
    await assert.rejects(app.api.save({ ...tool, destinationUrl }, actor), /PARTNER_TOOL_INPUT_INVALID/)
  }
  assert.equal((await app.api.listPublic())[0].destinationUrl, tool.destinationUrl)
})
test('malformed local storage falls back to synthetic data and reset restores the catalogue', async () => {
  const app = setup()
  const tool = (await app.api.listPublic())[0]
  await app.api.save({ ...tool, status: 'hidden' }, actor)
  app.reset()
  assert.equal((await app.api.listPublic()).length, 3)
  app.storage.setItem('xelay:useful-tools:local-preview:v1', '{invalid')
  const restored = createPartnerToolsPreview({ storage: app.storage, now: app.now })
  assert.equal((await restored.api.listPublic()).length, 3)
})
