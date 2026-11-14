import { personalRetakesFixture } from './teaching-test-personal-retakes-fixture.mjs'
import { readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { randomUUID } from 'node:crypto'

// Synthetic local database only; this fixture never contacts a provider.
export async function publicationRevisionsFixture() {
  const fx = await personalRetakesFixture()
  try {
    await fx.db.exec(await readCourseModuleMigration('202611140110_teaching_publication_revisions.sql'))
    async function stage(testId, changes = {}, actor = fx.ids.owner) {
      const previous = await fx.testDetail(actor, testId)
      return fx.testMutate(actor, 'save_published_draft', {
        id: testId, version: previous.test.version,
        draft_version: previous.test.publication_draft?.version ?? 0,
        definition: { ...previous.test, ...changes },
      })
    }
    async function publish(testId, changes = {}, actor = fx.ids.owner) {
      const previous = await fx.testDetail(actor, testId)
      const payload = {
        id: testId, version: previous.test.version,
        draft_version: previous.test.publication_draft?.version ?? 0,
        request_id: randomUUID(), confirm_republish: true, reset_policy: 'keep',
        extend_active_attempts: false, ...changes,
      }
      return { payload, detail: await fx.testMutate(actor, 'republish_test', payload) }
    }
    return { ...fx, stage, publish }
  } catch (error) { await fx.close(); throw error }
}
