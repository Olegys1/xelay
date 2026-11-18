// Synthetic archive metadata only. This module is not part of the app entry.
import type { TeachingTest, TeachingTestRepository } from '../../src/lib/teachingTests'
import type { TeachingTestArchiveItem, TeachingTestArchiveRepository } from '../../src/lib/teachingTestArchive'

export const previewArchiveId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
export const PREVIEW_ARCHIVE_COURSE = previewArchiveId(21)
export const PREVIEW_ARCHIVE_GROUP = previewArchiveId(11)
export const PREVIEW_CLOSED_TEST = previewArchiveId(801)
export const PREVIEW_ACTIVE_TEST = previewArchiveId(802)
export const PREVIEW_CLOSED_TITLE = 'Попит і пропозиція · завершений приклад'
export const PREVIEW_ACTIVE_TITLE = 'Ринкова рівновага · активний приклад'

export function createArchivePreviewFixture({ ownerId, controls, storage = localStorage, now = Date.now, delayMs = 150 }: {
  ownerId: string; controls: () => { offline: boolean; expired: boolean }; storage?: Pick<Storage, 'getItem' | 'setItem'>; now?: () => number; delayMs?: number
}): { repository: TeachingTestRepository; archiveRepository: TeachingTestArchiveRepository } {
  if (![previewArchiveId(1), previewArchiveId(4)].includes(ownerId)) throw Error('LOCAL_PREVIEW_OWNER_REQUIRED')
  const key = `xelay:synthetic-preview:teacher-test-archive:v1:${ownerId}`
  const at = (offset: number) => new Date(now() + offset).toISOString()
  const test = (active: boolean): TeachingTest => ({
    id: active ? PREVIEW_ACTIVE_TEST : PREVIEW_CLOSED_TEST, course_id: PREVIEW_ARCHIVE_COURSE,
    title: active ? PREVIEW_ACTIVE_TITLE : PREVIEW_CLOSED_TITLE,
    description: active ? 'Вигаданий тест із чинним часом доступу. Його не можна переносити до архіву.' : 'Вигаданий завершений тест для перевірки особистого архіву. У цьому прикладі немає студентських відповідей чи оцінок.',
    status: active ? 'published' : 'closed', opens_at: at(active ? -300_000 : -172_800_000), closes_at: at(active ? 3_600_000 : -86_400_000), duration_seconds: 900,
    max_points: 1, category: 'Тест', journal_date: new Date(now()).toISOString().slice(0, 10), work_type: 'test', allow_skip: true, allow_return: true,
    question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 0, bonus_points: 0,
    targets: [{ group_id: PREVIEW_ARCHIVE_GROUP, audience_mode: 'all', subgroup_ids: [] }],
    questions: [{ id: 'synthetic-q1', kind: 'choice', text: 'Вигаданий приклад: як зазвичай зміниться обсяг попиту після підвищення ціни?', points: 1, time_limit_seconds: null, partial_credit: false, options: [{ id: 'a', text: 'Зменшиться' }, { id: 'b', text: 'Збільшиться' }], buckets: [], answer: 'a' }],
    question_count: 1, version: 1, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null,
    can_edit: false, can_review: false, can_close: false, can_republish: false,
  })
  async function wait() { if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs)); if (controls().offline) throw Error('LOCAL_PREVIEW_OFFLINE') }
  function scope(courseId?: string, groupId?: string) {
    if (courseId !== undefined && courseId !== PREVIEW_ARCHIVE_COURSE || groupId !== undefined && groupId !== PREVIEW_ARCHIVE_GROUP) throw Error('TEST_ARCHIVE_SCOPE_FORBIDDEN')
  }
  function read(): TeachingTestArchiveItem[] {
    const raw = storage.getItem(key)
    if (!raw) return []
    let value: { version?: unknown; ownerId?: unknown; items?: unknown }
    try { value = JSON.parse(raw) } catch { throw Error('TEST_ARCHIVE_INVALID_RESPONSE') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.ownerId !== ownerId || !Array.isArray(value.items) || value.items.length > 2) throw Error('TEST_ARCHIVE_INVALID_RESPONSE')
    const items = value.items as TeachingTestArchiveItem[]
    if (new Set(items.map(item => item.testId)).size !== items.length || items.some(item => !item || item.testId !== PREVIEW_CLOSED_TEST || item.courseId !== PREVIEW_ARCHIVE_COURSE || !Number.isSafeInteger(item.version) || item.version < 1 || !(item.archivedAt === null || typeof item.archivedAt === 'string' && Number.isFinite(Date.parse(item.archivedAt))))) throw Error('TEST_ARCHIVE_INVALID_RESPONSE')
    return structuredClone(items)
  }
  const archiveRepository: TeachingTestArchiveRepository = {
    async state(courseId, groupId) { await wait(); scope(courseId, groupId); return { userId: ownerId, canArchive: !controls().expired, items: read(), serverNow: at(0) } },
    async set(payload) {
      await wait(); scope(payload.courseId, payload.groupId)
      if (payload.expectedUserId !== ownerId) throw Error('TEST_ARCHIVE_ACTOR_CHANGED')
      if (payload.testId === PREVIEW_ACTIVE_TEST) throw Error('TEST_ARCHIVE_NOT_COMPLETED')
      if (payload.testId !== PREVIEW_CLOSED_TEST) throw Error('TEST_ARCHIVE_SCOPE_FORBIDDEN')
      if (payload.archived && controls().expired) throw Error('TEST_ARCHIVE_PLAN_REQUIRED')
      const items = read(), previous = items.find(item => item.testId === payload.testId)
      if ((previous?.version || 0) !== payload.expectedVersion) throw Error('TEST_ARCHIVE_CONFLICT')
      if (!payload.archived && !previous?.archivedAt) throw Error('TEST_ARCHIVE_NOT_FOUND')
      const item = { testId: payload.testId, courseId: PREVIEW_ARCHIVE_COURSE, archivedAt: payload.archived ? at(0) : null, version: (previous?.version || 0) + 1 }
      storage.setItem(key, JSON.stringify({ version: 1, ownerId, items: [...items.filter(item => item.testId !== payload.testId), item] }))
      return structuredClone(item)
    },
  }
  return { archiveRepository, repository: {
    async list(courseId, groupId) { await wait(); scope(courseId, groupId); return { tests: [test(false), test(true)], server_now: at(0) } },
    async detail(testId) { await wait(); if (![PREVIEW_CLOSED_TEST, PREVIEW_ACTIVE_TEST].includes(testId)) throw Error('TEST_ARCHIVE_SCOPE_FORBIDDEN'); return { test: test(testId === PREVIEW_ACTIVE_TEST), attempt: null, attempts: [], server_now: at(0) } },
    async mutate() { throw Error('LOCAL_PREVIEW_ARCHIVE_ONLY') },
  } }
}
