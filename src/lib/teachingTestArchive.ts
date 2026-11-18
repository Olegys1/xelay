import { supabase } from './supabase'
import type { TeachingTest } from './teachingTests'

export type TeachingTestArchiveItem = { testId: string; courseId: string; archivedAt: string | null; version: number }
export type TeachingTestArchiveState = { userId: string; canArchive: boolean; items: TeachingTestArchiveItem[]; serverNow: string }
export type TeachingTestArchiveSet = { testId: string; courseId: string; groupId?: string; archived: boolean; expectedVersion: number; expectedUserId: string }
export type TeachingTestArchiveRepository = {
  state(courseId?: string, groupId?: string): Promise<TeachingTestArchiveState>
  set(payload: TeachingTestArchiveSet): Promise<TeachingTestArchiveItem>
}
type RpcClient = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && allowed.every(key => Object.prototype.hasOwnProperty.call(v,key))
function item(v: unknown): TeachingTestArchiveItem {
  if (!object(v) || !keys(v,['testId','courseId','archivedAt','version']) || !uuid(v.testId) || !uuid(v.courseId)
    || !(v.archivedAt === null || typeof v.archivedAt === 'string' && Number.isFinite(Date.parse(v.archivedAt)))
    || typeof v.version !== 'number' || !Number.isSafeInteger(v.version) || v.version < 1 || v.version > 1000000) throw new Error('TEST_ARCHIVE_INVALID_RESPONSE')
  return v as TeachingTestArchiveItem
}
export function teachingTestArchiveError(error: unknown): string {
  if (object(error) && ['PGRST202','42883'].includes(String(error.code))) return 'Особистий архів ще не підключений до цієї версії платформи. Звичайні тести залишаються доступними; спробуйте відкрити архів після оновлення.'
  const message = error instanceof Error ? error.message : object(error) && typeof error.message === 'string' ? error.message : ''
  const errors: Record<string,string> = {
    TEST_ARCHIVE_PLAN_REQUIRED:'Особистий архів нових завершених тестів входить у викладацькі тарифи Старт, Плюс і Макс. Раніше збережений архів можна переглядати й відновлювати після завершення підписки.',
    TEST_ARCHIVE_NOT_COMPLETED:'Тест ще доступний для проходження або має чинну повторну чи індивідуальну спробу. Зачекайте на завершення; час і відповіді не змінено.',
    TEST_ARCHIVE_CONFLICT:'Стан архіву змінився в іншому вікні. Оновіть список і повторіть дію.',
    TEST_ARCHIVE_SCOPE_FORBIDDEN:'Немає чинного викладацького доступу до цього тесту у вибраному предметі чи групі.',
    TEST_ARCHIVE_TEACHER_REQUIRED:'Підтвердьте чинний викладацький доступ, щоб відкрити особистий архів.',
    TEST_ARCHIVE_ACTOR_CHANGED:'Обліковий запис змінився. Відкрийте тести ще раз.',
    TEST_ARCHIVE_NOT_FOUND:'У вашому архіві немає цього тесту. Оновіть список.',
    TEST_ARCHIVE_SCOPE_TOO_LARGE:'Уточніть предмет або групу, щоб відкрити менший список архіву.',
    TEST_ARCHIVE_INVALID:'Перевірте вибраний тест і оновіть список.',
    TEST_ARCHIVE_INVALID_RESPONSE:'Не вдалося перевірити стан архіву. Попередні тести й оцінки збережені.',
    STUDENT_SESSION_REQUIRED:'Сесію завершено. Увійдіть до свого облікового запису ще раз.',
    TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED:'Для архіву потрібен чинний підтверджений викладацький доступ.',
  }
  return Object.entries(errors).find(([code]) => message.includes(code))?.[1] || 'Не вдалося оновити особистий архів. Спробуйте ще раз.'
}
/** A conservative display hint only. The server also checks personal windows,
 * publication revisions, retakes, pending attempts, identity and entitlement. */
export function teachingTestArchiveEligible(test: Pick<TeachingTest,'status'|'closes_at'>, serverNow: string): boolean {
  const now=Date.parse(serverNow)
  return Number.isFinite(now) && (test.status === 'closed' || test.status === 'published' && Number.isFinite(Date.parse(test.closes_at)) && Date.parse(test.closes_at) <= now)
}
export function createSupabaseTeachingTestArchiveRepository(client: RpcClient = supabase): TeachingTestArchiveRepository {
  async function rpc(name: string, args: Record<string, unknown>) { const { data,error }=await client.rpc(name,args);if(error)throw error;return data }
  return {
    async state(courseId,groupId) {
      if (courseId !== undefined && !uuid(courseId) || groupId !== undefined && !uuid(groupId)) throw new Error('TEST_ARCHIVE_INVALID')
      const v=await rpc('xelay_teaching_test_archive_state',{p_course_id:courseId??null,p_group_id:groupId??null})
      if (!object(v) || !keys(v,['userId','canArchive','items','serverNow']) || !uuid(v.userId) || typeof v.canArchive !== 'boolean' || !Array.isArray(v.items) || typeof v.serverNow !== 'string' || !Number.isFinite(Date.parse(v.serverNow))) throw new Error('TEST_ARCHIVE_INVALID_RESPONSE')
      const items=v.items.map(item)
      if (new Set(items.map(i=>i.testId)).size!==items.length || courseId && items.some(i=>i.courseId!==courseId)) throw new Error('TEST_ARCHIVE_INVALID_RESPONSE')
      return {userId:v.userId,canArchive:v.canArchive,items,serverNow:v.serverNow}
    },
    async set(p) {
      if (!uuid(p.testId) || !uuid(p.courseId) || !uuid(p.expectedUserId) || p.groupId!==undefined&&!uuid(p.groupId) || typeof p.archived!=='boolean' || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion<0 || p.expectedVersion>999999) throw new Error('TEST_ARCHIVE_INVALID')
      const result=item(await rpc('xelay_teaching_test_archive_set',{p_test_id:p.testId,p_course_id:p.courseId,p_group_id:p.groupId??null,p_archived:p.archived,p_expected_version:p.expectedVersion,p_expected_user_id:p.expectedUserId}))
      if (result.testId!==p.testId || result.courseId!==p.courseId || (result.archivedAt!==null)!==p.archived) throw new Error('TEST_ARCHIVE_INVALID_RESPONSE')
      return result
    },
  }
}
