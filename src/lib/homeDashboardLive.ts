import { supabase } from './supabase'
import { getMemberCount, getPublicProfiles } from './profiles'
import { categoryLabel } from '../translations/categories'
import { loadLearningHomeDashboard, loadHomeTeachingSummary } from './homeDashboardRepository'
import { loadTeacherHomeDashboard } from './homeTeacherDashboardRepository'
import type { XelayUser } from '../types'
import { homeKyivClock } from './homeDashboardModel'
import type { HomeDashboardCommunityItem, HomeDashboardData, HomeDashboardGroup, HomeDashboardNewsItem } from './homeDashboardModel'

const active = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError') }
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
const text = (value: unknown, length = 240) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, length) : ''

/** Empty means unknown/not loaded. It never contains example students or grades. */
export function emptyLiveHome(profile: XelayUser, status: HomeDashboardData['status'] = 'loading'): HomeDashboardData {
  const name = profile.name?.trim() || 'Користувач'
  return {
    role: profile.isTeacher ? 'teacher' : profile.isClassRepresentative ? 'headman' : 'student',
    displayName: name, initials: name.split(/\s+/u).map(value => value[0]).join('').slice(0, 2).toLocaleUpperCase('uk-UA'),
    clockIso: new Date().toISOString(), contexts: profile.isTeacher ? ['teaching'] : ['learning'],
    teachingVerified: false, status, participantCount: 0,
    groups: [], lessons: [], tasks: [], updates: [], publications: [], community: [], news: [],
  }
}

function mergeGroups(learning: HomeDashboardGroup[], teaching: HomeDashboardGroup[]): HomeDashboardGroup[] {
  const groups = new Map(learning.map(group => [group.id, { ...group, learningPermissions: group.permissions, teachingPermissions: [] as HomeDashboardGroup['permissions'] }]))
  for (const group of teaching) {
    const own = groups.get(group.id)
    groups.set(group.id, own ? {
      ...group, ...own, status: own.status === 'accepted' || group.status === 'accepted' ? 'accepted' : own.status,
      teachingSubjectIds: [...new Set([...own.teachingSubjectIds, ...group.teachingSubjectIds])],
      gradingSubjectIds: [...new Set([...own.gradingSubjectIds, ...group.gradingSubjectIds])],
      permissions: own.permissions, learningPermissions: own.learningPermissions, teachingPermissions: group.permissions,
    } : { ...group, learningPermissions: [], teachingPermissions: group.permissions })
  }
  return [...groups.values()]
}

async function loadPublicCards(profile: XelayUser, signal: AbortSignal) {
  const newsQuery = (kind: 'platform' | 'faculty') => {
    let query = supabase.from('news_posts').select('id,title,excerpt,published_at,university_id,academic_unit_id')
      .eq('status', 'published').order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(2)
    query = kind === 'platform' ? query.is('university_id', null).is('academic_unit_id', null)
      : query.eq('university_id', profile.universityId!).eq('academic_unit_id', profile.academicUnitId!)
    return query.abortSignal(signal)
  }
  const results = await Promise.allSettled([
    supabase.from('questions').select('id,user_id,title,category,author_name,answers_count').order('created_at', { ascending: false }).limit(2).abortSignal(signal),
    newsQuery('platform'),
    isId(profile.universityId) && isId(profile.academicUnitId) ? newsQuery('faculty') : Promise.resolve({ data: [], error: null }),
    getMemberCount(),
  ])
  active(signal)
  const usable = (index: number) => results[index].status === 'fulfilled' && !(results[index] as PromiseFulfilledResult<any>).value.error
    ? (results[index] as PromiseFulfilledResult<any>).value.data : null
  const rawQuestions: any[] = Array.isArray(usable(0)) ? usable(0) : []
  const authors = await getPublicProfiles(rawQuestions.map(row => row.user_id).filter(isId)).catch(() => ({ data: [], error: true }))
  active(signal)
  const names = new Map((authors.data || []).map(row => [row.id, text(row.full_name, 120)] as const))
  const community: HomeDashboardCommunityItem[] = rawQuestions.filter(row => typeof row.id === 'string').map(row => ({
    id: row.id, category: categoryLabel(text(row.category)), title: text(row.title) || 'Запитання спільноти',
    author: names.get(row.user_id) || text(row.author_name, 120) || 'Учасник спільноти',
    replies: Number.isSafeInteger(row.answers_count) && row.answers_count >= 0 ? row.answers_count : undefined,
    href: `/question/${encodeURIComponent(row.id)}`,
  }))
  const news: HomeDashboardNewsItem[] = [1, 2].flatMap(index => (Array.isArray(usable(index)) ? usable(index) : []).flatMap((row: any) => {
    let date: string | null = null
    try { if (typeof row.published_at === 'string') date = homeKyivClock(row.published_at).date } catch { /* no guessed date */ }
    return isId(row.id) && date ? [{ id: row.id, kind: index === 1 ? 'platform' as const : 'faculty' as const, title: text(row.title), excerpt: text(row.excerpt), date, href: `/news/${encodeURIComponent(row.id)}` }] : []
  })).slice(0, 3)
  const count = usable(3)
  return { community, news, participantCount: typeof count === 'number' && Number.isFinite(count) ? count : 0, incomplete: results.some(result => result.status === 'rejected' || result.value.error) }
}

/** All contexts use the same authenticated actor; no service-role client is used. */
export async function loadLiveHome(profile: XelayUser, userId: string, signal: AbortSignal): Promise<HomeDashboardData> {
  if (profile.id !== userId) throw new Error('HOME_ACTOR_CHANGED')
  const clockIso = new Date().toISOString()
  // Summary contains own states and permitted aggregate counts only. A missing
  // summary is explicit; loaders must never infer "not submitted" from it.
  const [summary, cards] = await Promise.all([loadHomeTeachingSummary(null, signal).catch(error => {
    active(signal)
    console.warn('Home teaching summary unavailable', error?.code || '')
    return null
  }), loadPublicCards(profile, signal)])
  const [learning, teacher] = await Promise.all([
    loadLearningHomeDashboard({ userId, clockIso, signal, summary }),
    profile.isTeacher ? loadTeacherHomeDashboard({ userId, clockIso, signal, summary }) : Promise.resolve(null),
  ])
  active(signal)
  const groups = mergeGroups(learning.groups, teacher?.groups || [])
  const verified = teacher?.teachingVerified === true
  const contexts: HomeDashboardData['contexts'] = verified
    ? groups.some(group => group.learning && group.status === 'accepted') || learning.isHeadman ? ['learning', 'teaching'] : ['teaching']
    : ['learning']
  const warnings = [...learning.warnings, ...(teacher?.warnings || [])]
  return {
    ...emptyLiveHome(profile, 'ready'), clockIso, teachingVerified: verified,
    role: learning.isHeadman || profile.isClassRepresentative ? 'headman' : verified ? 'teacher' : 'student', contexts,
    preferredGroupId: learning.groups.find(group => group.status === 'accepted')?.id,
    groups,
    lessons: [...learning.lessons.map(item => ({ ...item, context: 'learning' as const })), ...(teacher?.lessons || []).map(item => ({ ...item, context: 'teaching' as const }))],
    tasks: [...learning.tasks, ...(teacher?.tasks || [])],
    updates: [...learning.updates, ...(teacher?.updates || [])],
    publications: teacher?.publications || [],
    reviewCountsAvailable: teacher?.reviewCountsAvailable ?? false,
    community: cards.community, news: cards.news, participantCount: cards.participantCount,
    partialMessage: warnings.length || cards.incomplete || summary === null
      ? 'Частину оновлень не вдалося завантажити. Спробуйте оновити головну або відкрийте потрібну групу.' : undefined,
  }
}
