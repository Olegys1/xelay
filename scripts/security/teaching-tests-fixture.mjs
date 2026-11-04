import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'

export function syntheticTest(courseId, groupIds, overrides = {}) {
  return {
    id: randomUUID(), course_id: courseId, title: 'Тестова контрольна', description: 'Вигадані завдання для локальної перевірки.',
    status: 'published', opens_at: new Date(Date.now() - 60000).toISOString(), closes_at: new Date(Date.now() + 86400000).toISOString(),
    duration_seconds: 1200, max_points: 20, category: '', allow_skip: true, allow_return: true, question_timer_policy: 'continue',
    restrict_copy: true, bonus_percent: 20, bonus_points: 2, version: 0,
    targets: groupIds.map(group_id => ({ group_id, audience_mode: 'all', subgroup_ids: [] })),
    questions: [
      { id: 'choice', kind: 'choice', text: 'Оберіть правильну відповідь.', points: 5, time_limit_seconds: 30, partial_credit: false,
        options: ['a', 'b', 'c', 'd'].map(id => ({ id, text: `Варіант ${id}` })), buckets: [], answer: 'b' },
      { id: 'boolean', kind: 'boolean', text: 'Два плюс два дорівнює чотири.', points: 5, time_limit_seconds: null, partial_credit: false,
        options: [{ id: 'true', text: 'Так' }, { id: 'false', text: 'Ні' }], buckets: [], answer: 'true' },
      { id: 'sorting', kind: 'sorting', text: 'Розподіліть числа.', points: 5, time_limit_seconds: null, partial_credit: true,
        options: [{ id: 'two', text: '2' }, { id: 'three', text: '3' }], buckets: [{ id: 'even', text: 'Парні' }, { id: 'odd', text: 'Непарні' }], answer: { two: 'even', three: 'odd' } },
      { id: 'sequence', kind: 'sequence', text: 'Розташуйте за зростанням.', points: 5, time_limit_seconds: null, partial_credit: true,
        options: [{ id: 'one', text: '1' }, { id: 'two', text: '2' }, { id: 'three', text: '3' }], buckets: [], answer: ['one', 'two', 'three'] },
    ], ...overrides,
  }
}
export async function teachingTestsFixture() {
  const fx = await audienceFixture()
  try {
    for (const name of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql',
      '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040010_teaching_tests.sql']) {
      await fx.db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
    }
    await applyAssessmentPhase1Fixture(fx)
    const testMutate = (who, action, payload) => fx.rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify(payload)])
    const testDetail = (who, id) => fx.rpc(who, 'xelay_teaching_test', [id])
    const testList = (who, course = null, group = null) => fx.rpc(who, 'xelay_teaching_tests', [course, group])
    return { ...fx, testMutate, testDetail, testList }
  } catch (error) { await fx.close(); throw error }
}

// Opt-in compatibility run: exercise the existing suite against the proposed
// migrations without changing its default baseline or touching any remote DB.
export async function applyAssessmentPhase1Fixture(fx) {
  if (process.env.XELAY_ASSESSMENT_PHASE1 !== '1') return
  for (const name of ['202611040020_assessment_bank_variants.sql', '202611040021_teaching_rubrics.sql', '202611040022_rubric_correction_publication.sql']) {
    await fx.db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
  }
}
