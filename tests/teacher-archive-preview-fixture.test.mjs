import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const module = { exports: {} }
runInNewContext(ts.transpileModule(readFileSync(new URL('../scripts/preview-teacher-subscriptions/archiveFixture.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, Date, Number, JSON, Set, Error, structuredClone })
const { createArchivePreviewFixture, previewArchiveId, PREVIEW_ARCHIVE_COURSE: courseId, PREVIEW_ARCHIVE_GROUP: groupId, PREVIEW_CLOSED_TEST: testId, PREVIEW_ACTIVE_TEST } = module.exports
const ownerId = previewArchiveId(1)
function setup() {
  const map = new Map(), storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }, controls = { expired: false, offline: false }
  return { controls, make: (owner = ownerId) => createArchivePreviewFixture({ ownerId: owner, controls: () => controls, storage, now: () => Date.parse('2026-11-18T12:00:00Z'), delayMs: 0 }) }
}
const payload = { testId, courseId, groupId, expectedUserId: ownerId, expectedVersion: 0, archived: true }
test('synthetic archive persists by owner across fixture recreation and expired access still permits restoration', async () => {
  const h = setup(), first = h.make(); await first.archiveRepository.set(payload)
  const refreshed = h.make(), own = await refreshed.archiveRepository.state(courseId, groupId)
  assert.equal(own.items.length, 1); assert.equal(own.items[0].testId, testId)
  assert.equal((await h.make(previewArchiveId(4)).archiveRepository.state(courseId, groupId)).items.length, 0)
  h.controls.expired = true
  assert.equal((await refreshed.archiveRepository.state(courseId, groupId)).canArchive, false)
  await assert.rejects(refreshed.archiveRepository.set({ ...payload, expectedVersion: 1 }), /TEST_ARCHIVE_PLAN_REQUIRED/)
  const restored = await refreshed.archiveRepository.set({ ...payload, expectedVersion: 1, archived: false })
  assert.equal(restored.archivedAt, null); assert.equal(restored.version, 2)
  assert.equal((await h.make().archiveRepository.state(courseId, groupId)).items[0].archivedAt, null)
})
test('offline operations preserve archive metadata; active tests, stale updates, foreign owners and score mutations are rejected', async () => {
  const h = setup(), fixture = h.make()
  await assert.rejects(fixture.archiveRepository.set({ ...payload, testId: PREVIEW_ACTIVE_TEST }), /TEST_ARCHIVE_NOT_COMPLETED/)
  await fixture.archiveRepository.set(payload)
  await assert.rejects(fixture.archiveRepository.set(payload), /TEST_ARCHIVE_CONFLICT/)
  await assert.rejects(fixture.archiveRepository.set({ ...payload, expectedUserId: previewArchiveId(4) }), /TEST_ARCHIVE_ACTOR_CHANGED/)
  h.controls.offline = true
  await assert.rejects(fixture.archiveRepository.set({ ...payload, expectedVersion: 1, archived: false }), /LOCAL_PREVIEW_OFFLINE/)
  h.controls.offline = false
  assert.notEqual((await fixture.archiveRepository.state(courseId, groupId)).items[0].archivedAt, null)
  await assert.rejects(fixture.repository.mutate('finalize_results', {}), /LOCAL_PREVIEW_ARCHIVE_ONLY/)
  assert.equal((await fixture.repository.detail(testId)).attempts.length, 0)
})
