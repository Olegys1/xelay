import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from './localTeachingRepository'
import { validateTeachingFile, validateTeachingLinks, type TeachingRepository, type TeachingPublication, type TeachingTarget, type TeachingSubmission, type TeachingSubmissionHistory, type TeachingSnapshot, type TeachingFile } from './teaching'
import type { TeachingAnnouncement, TeachingAnnouncementAudience, TeachingAnnouncementReceipts, TeachingAudienceContext, TeachingAudienceTarget, TeachingLabTeam, TeachingSubgroup } from './teachingAudience'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const LOCAL_AUDIENCE_COURSE = uuid(21), LOCAL_AUDIENCE_GROUP = uuid(11)
const KEY = 'xelay-local-teaching-audiences-v1'
type ItemScope = { targets: TeachingTarget[]; submission_mode?: 'individual' | 'team' }
type LocalAnnouncementRecipient = TeachingAnnouncementReceipts['recipients'][number] & { notification_id: string }
type DemoState = TeachingAudienceContext & { prepared?: boolean; handedIn?: Record<string, Pick<TeachingSubmission, 'body' | 'links' | 'attachments'>>; announcementDelivery?: Record<string, { version: number; recipients: LocalAnnouncementRecipient[] }>; scopes: Record<string, ItemScope>; shared: TeachingSubmission[]; history: TeachingSubmissionHistory[]; receipts: Record<string, { signature: string; result: { id?: string; version?: number } }> }
let memory: DemoState | undefined
let preparation: Promise<void> | undefined
let mutationQueue: Promise<unknown> = Promise.resolve()
const sharedFiles = new Map<string, { url: string; file: TeachingFile }>()
const clone = <T,>(v: T): T => structuredClone(v)
function fail(message = 'TEACHING_FORBIDDEN'): never { throw new Error(message) }
const time = () => new Date().toISOString()
function initialState(): DemoState {
  const stamp = time()
  return {
    subgroups: [
      { id: uuid(801), course_id: uuid(21), group_id: uuid(11), name: 'Підгрупа 1', user_ids: [uuid(2)], version: 1 },
      { id: uuid(802), course_id: uuid(21), group_id: uuid(11), name: 'Підгрупа 2', user_ids: [uuid(3)], version: 1 },
    ],
    teams: [{ id: uuid(811), course_id: uuid(21), group_id: uuid(11), item_id: uuid(183), name: 'Команда «Рівновага»', user_ids: [uuid(2), uuid(3)], version: 1 }],
    announcements: [
      { id: uuid(821), course_id: uuid(21), title: 'Зміна формату наступного заняття', body: 'Наступне заняття проведемо онлайн. Посилання є в розкладі. Дякую, що попередите одногрупників!', created_by: uuid(1), author_name: 'Олена Прикладенко', created_at: stamp, updated_at: stamp, version: 1, targets: [{ group_id: uuid(11), audience_mode: 'all' }, { group_id: uuid(12), audience_mode: 'all' }] },
      { id: uuid(822), course_id: uuid(21), title: 'Для підгрупи 1', body: 'До наступного заняття підготуйте приклад ринку послуг. Це повідомлення бачить лише перша підгрупа.', created_by: uuid(1), author_name: 'Олена Прикладенко', created_at: stamp, updated_at: stamp, version: 1, targets: [{ group_id: uuid(11), audience_mode: 'subgroups', subgroup_ids: [uuid(801)] }] },
    ],
    scopes: {
      [uuid(183)]: { submission_mode: 'team', targets: [{ group_id: uuid(11), audience_mode: 'all', placement_mode: 'unplaced', due_at: null }] },
      [uuid(203)]: { targets: [{ group_id: uuid(11), audience_mode: 'subgroups', subgroup_ids: [uuid(801)] }] },
    }, shared: [], history: [], receipts: {},
  }
}
function state(): DemoState {
  if (memory) return memory
  try { const raw = localStorage.getItem(KEY); if (raw) memory = JSON.parse(raw) as DemoState } catch { /* memory still works when storage is unavailable */ }
  return memory ||= initialState()
}
function persist(value: DemoState) { memory = value; try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* this preview never writes to a backend */ } }
function exclusive<T>(work: () => Promise<T>): Promise<T> { const next = mutationQueue.then(work, work); mutationQueue = next.then(() => {}, () => {}); return next }
export function resetLocalTeachingAudiencePreview() { for (const file of sharedFiles.values()) URL.revokeObjectURL(file.url); sharedFiles.clear(); memory = undefined; preparation = undefined; try { localStorage.removeItem(KEY) } catch {} resetLocalTeachingPreview() }

export async function prepareLocalTeachingAudiencePreview(): Promise<void> {
  if (state().prepared) return
  if (preparation) return preparation
  preparation = (async () => {
    const owner = createLocalTeachingRepository('teacher')
    await owner.materialLibrary()
    const snap = await owner.course(LOCAL_AUDIENCE_COURSE)
    const lab = snap.assignments.find(item => item.id === uuid(183))
    if (!lab) fail('TEACHING_NOT_FOUND')
    await owner.classroomMutate('save_group_assignment', { id: lab.id, course_id: lab.course_id, group_id: LOCAL_AUDIENCE_GROUP, version: lab.version, expected_user_id: LOCAL_TEACHING_IDENTITIES.teacher.userId,
      title: lab.title, body: lab.body, links: lab.links, attachments: lab.attachments, targets: lab.targets, status: 'published', max_points: 10, category: 'tasks', submission_format: 'written', work_type: 'Лабораторна робота' })
    const s = clone(state()); s.prepared = true; persist(s)
  })().finally(() => { preparation = undefined })
  return preparation
}

export function createLocalTeachingAudienceRepository(role: LocalTeachingRole): TeachingRepository {
  const base = createLocalTeachingRepository(role), identity = LOCAL_TEACHING_IDENTITIES[role], actor = identity.userId
  const staff = role === 'teacher' || role === 'colleague'
  async function snapshot(courseId: string, groupId?: string, permission?: string): Promise<TeachingSnapshot> {
    const result = await base.course(courseId)
    if (!staff || groupId && !result.groups.some(link => link.status === 'accepted' && link.group_id === groupId && (!permission || link.permissions?.includes(permission as 'assignments')))) fail()
    if (result.course.archived_at) fail('TEACHING_ARCHIVED')
    return result
  }
  function hasAudience(target: TeachingTarget | TeachingAudienceTarget, courseId: string, itemId?: string, userId = actor) {
    const s = state()
    if (!target.audience_mode || target.audience_mode === 'all') return true
    const rows = target.audience_mode === 'subgroups' ? s.subgroups : s.teams
    const ids = target.audience_mode === 'subgroups' ? target.subgroup_ids : target.team_ids
    return rows.some(row => ids?.includes(row.id) && row.course_id === courseId && row.group_id === target.group_id && (!('item_id' in row) || !itemId || row.item_id === itemId) && row.user_ids.includes(userId))
  }
  const decorate = <T extends TeachingPublication>(item: T): T => {
    const scope = state().scopes[item.id]
    const example = item.id === uuid(183) ? { title: 'Лабораторна робота · спільна модель ринку', body: 'Разом побудуйте модель ринку. Додайте спільний опис і файл з розрахунками. Один учасник здає роботу від усієї команди.', submission_format: 'written' as const } : {}
    return scope ? { ...item, ...example, submission_mode: scope.submission_mode || item.submission_mode, targets: item.targets.map(target => ({ ...target, ...scope.targets.find(t => t.group_id === target.group_id) })) } : item
  }
  const visible = <T extends TeachingPublication>(items: T[], groupId?: string): T[] => items.map(decorate).flatMap(item => {
    const targets = item.targets.filter(target => (!groupId || target.group_id === groupId) && (staff || hasAudience(target, item.course_id, item.id)))
    return targets.length || staff && !item.targets.length ? [{ ...item, targets }] : []
  })
  async function validateTargets(courseId: string, targets: TeachingTarget[], itemId?: string, permission = 'assignments') {
    if (!targets.length || new Set(targets.map(t => t.group_id)).size !== targets.length) fail('TEACHING_INVALID_INPUT')
    for (const target of targets) {
      await snapshot(courseId, target.group_id, permission)
      if (!target.audience_mode || target.audience_mode === 'all') continue
      const rows = target.audience_mode === 'subgroups' ? state().subgroups : target.audience_mode === 'teams' ? state().teams : fail('TEACHING_INVALID_INPUT')
      const ids = target.audience_mode === 'subgroups' ? target.subgroup_ids : target.team_ids
      if (!ids?.length || new Set(ids).size !== ids.length || ids.some(id => !rows.some(row => row.id === id && row.course_id === courseId && row.group_id === target.group_id && (!('item_id' in row) || !itemId || row.item_id === itemId)))) fail('TEACHING_INVALID_INPUT')
    }
  }
  async function announcementRecipients(courseId: string, targets: TeachingAudienceTarget[]) {
    await validateTargets(courseId, targets)
    // All records in this repository are synthetic. Read the seeded roster only
    // after the current local teacher's target permissions have been checked.
    const roster = (await createLocalTeachingRepository('teacher').course(courseId)).members
    const recipients = new Map<string, LocalAnnouncementRecipient>()
    const counts: TeachingAnnouncementAudience['group_counts'] = []
    for (const target of targets) {
      const selected = roster.filter(member => member.group_id === target.group_id && hasAudience(target, courseId, undefined, member.user_id))
      counts.push({ group_id: target.group_id, count: selected.length })
      for (const member of selected) if (!recipients.has(member.user_id)) recipients.set(member.user_id, { ...member, notification_id: crypto.randomUUID(), acknowledged_at: null })
    }
    return { recipients: [...recipients.values()], audience: { recipient_count: recipients.size, group_counts: counts } }
  }
  async function previewRecipients(courseId: string, targets: TeachingAudienceTarget[], expectedUserId: string) {
    if (expectedUserId !== actor) fail('TEACHING_ACTOR_CHANGED')
    return clone((await announcementRecipients(courseId, targets)).audience)
  }
  async function receipts(announcementId: string, expectedUserId: string): Promise<TeachingAnnouncementReceipts> {
    if (expectedUserId !== actor) fail('TEACHING_ACTOR_CHANGED')
    const message = state().announcements.find(row => row.id === announcementId)
    if (!message || message.created_by !== actor) fail()
    await validateTargets(message.course_id, message.targets)
    const delivery = state().announcementDelivery?.[announcementId]
    const recipients = message.requires_acknowledgement && delivery?.version === message.version ? delivery.recipients.map(({ notification_id: _notificationId, ...recipient }) => recipient) : []
    return clone({ id: message.id, version: message.version, total: recipients.length, acknowledged: recipients.filter(row => row.acknowledged_at).length, recipients })
  }
  async function acknowledge(notificationId: string, expectedUserId: string) {
    if (expectedUserId !== actor) fail('TEACHING_ACTOR_CHANGED')
    const next = clone(state())
    const message = next.announcements.find(row => row.requires_acknowledgement && next.announcementDelivery?.[row.id]?.version === row.version && next.announcementDelivery[row.id].recipients.some(recipient => recipient.user_id === actor && recipient.notification_id === notificationId))
    if (!message) fail()
    const delivery = next.announcementDelivery![message.id], recipient = delivery.recipients.find(row => row.user_id === actor && row.notification_id === notificationId)!
    await base.group(recipient.group_id)
    if (!message.targets.some(target => target.group_id === recipient.group_id && hasAudience(target, message.course_id))) fail()
    recipient.acknowledged_at ||= time(); persist(next)
    return { acknowledged_at: recipient.acknowledged_at }
  }
  async function context(courseId: string, groupId?: string) {
    const snap = await snapshot(courseId)
    // The editor must retain the other permitted groups of a shared message.
    const groups = new Set(snap.groups.filter(g => g.status === 'accepted' && g.permissions?.includes('assignments')).map(g => g.group_id))
    const s = state()
    return clone({ subgroups: s.subgroups.filter(x => x.course_id === courseId && groups.has(x.group_id)), teams: s.teams.filter(x => x.course_id === courseId && groups.has(x.group_id)), announcements: s.announcements.filter(x => x.course_id === courseId && x.targets.some(t => groups.has(t.group_id))).map(x => ({ ...x, targets: x.targets.filter(t => groups.has(t.group_id)) })) })
  }
  async function audienceMutate(action: string, payload: Record<string, unknown>) {
    const s = clone(state()), courseId = String(payload.course_id || ''), id = String(payload.id || crypto.randomUUID())
    if (payload.expected_user_id && payload.expected_user_id !== actor) fail('TEACHING_ACTOR_CHANGED')
    const snap = await snapshot(courseId)
    if (action.endsWith('subgroup') || action.endsWith('lab_team')) {
      const isTeam = action.endsWith('lab_team'), rows = isTeam ? s.teams : s.subgroups, prior = rows.find(x => x.id === id)
      if (prior && (prior.course_id !== courseId || prior.version !== Number(payload.version))) fail('TEACHING_CONFLICT')
      if (!prior && Number(payload.version || 0)) fail('TEACHING_CONFLICT')
      const groupId = prior?.group_id || String(payload.group_id || '')
      await snapshot(courseId, groupId, 'assignments')
      if (action.startsWith('delete_')) {
        if (!prior) fail('TEACHING_NOT_FOUND')
        if (isTeam && s.shared.some(x => x.team_id === id)) fail('TEACHING_CONFLICT')
        if (isTeam) s.teams = s.teams.filter(x => x.id !== id); else s.subgroups = s.subgroups.filter(x => x.id !== id)
        persist(s); return { id, version: prior.version + 1 }
      }
      const users = payload.user_ids as string[], name = String(payload.name || '').trim()
      if (!name || name.length > 120 || !Array.isArray(users) || !users.length || new Set(users).size !== users.length || users.some(user => !snap.members.some(m => m.group_id === groupId && m.user_id === user))) fail('TEACHING_INVALID_INPUT')
      const row: TeachingSubgroup = { id, course_id: courseId, group_id: groupId, name, user_ids: [...users], version: (prior?.version || 0) + 1 }
      if (isTeam) {
        const itemId = String(payload.item_id || (prior as TeachingLabTeam | undefined)?.item_id || '')
        if (!snap.assignments.some(x => x.id === itemId && x.targets.some(t => t.group_id === groupId)) || s.teams.some(t => t.id !== id && t.item_id === itemId && t.group_id === groupId && t.user_ids.some(u => users.includes(u)))) fail('TEACHING_INVALID_INPUT')
        if (s.shared.some(x => x.team_id === id) && prior && JSON.stringify([...prior.user_ids].sort()) !== JSON.stringify([...users].sort())) fail('TEACHING_CONFLICT')
        s.teams = [...s.teams.filter(x => x.id !== id), { ...row, item_id: itemId }]
      } else s.subgroups = [...s.subgroups.filter(x => x.id !== id), row]
      persist(s); return { id, version: row.version }
    }
    const prior = s.announcements.find(x => x.id === id)
    if (prior && (prior.created_by !== actor || prior.course_id !== courseId)) fail()
    if (prior && prior.version !== Number(payload.version) || !prior && Number(payload.version || 0)) fail('TEACHING_CONFLICT')
    if (action === 'delete_announcement') {
      if (!prior) fail('TEACHING_NOT_FOUND')
      for (const t of prior.targets) await snapshot(courseId, t.group_id, 'assignments')
      s.announcements = s.announcements.filter(x => x.id !== id); if (s.announcementDelivery) delete s.announcementDelivery[id]; persist(s); return { id, version: prior.version + 1 }
    }
    if (action !== 'save_announcement') fail('TEACHING_INVALID_INPUT')
    const title = String(payload.title || '').trim(), body = String(payload.body || '').trim(), targets = payload.targets as TeachingAudienceTarget[]
    if (!title || title.length > 160 || !body || body.length > 12000 || !Array.isArray(targets) || payload.requires_acknowledgement !== undefined && typeof payload.requires_acknowledgement !== 'boolean') fail('TEACHING_INVALID_INPUT')
    const recipients = await announcementRecipients(courseId, targets)
    for (const t of prior?.targets || []) await snapshot(courseId, t.group_id, 'assignments')
    const stamp = time(), row: TeachingAnnouncement = { id, course_id: courseId, title, body, targets: clone(targets), requires_acknowledgement: Boolean(payload.requires_acknowledgement), created_by: actor, author_name: identity.fullName, created_at: prior?.created_at || stamp, updated_at: stamp, version: (prior?.version || 0) + 1 }
    ;(s.announcementDelivery ||= {})[id] = { version: row.version, recipients: row.requires_acknowledgement ? recipients.recipients : [] }
    s.announcements = [...s.announcements.filter(x => x.id !== id), row]; persist(s); return { id, version: row.version }
  }
  async function classroom(itemId: string, groupId: string) {
    const data = await base.classroom(itemId, groupId), item = decorate(data.item)
    if (!staff && !item.targets.some(t => t.group_id === groupId && hasAudience(t, item.course_id, item.id))) fail()
    if (item.submission_mode !== 'team') return { ...data, item }
    const teams = state().teams.filter(t => t.item_id === itemId && t.group_id === groupId)
    const myTeam = teams.find(t => t.user_ids.includes(actor)), snap = staff ? await base.course(item.course_id) : null
    const eligibleUsers = (team: TeachingLabTeam) => team.user_ids.filter(userId => item.targets.some(target => target.group_id === groupId && hasAudience(target, item.course_id, item.id, userId)))
    const roster = snap?.members || []
    const ownGrades = !staff ? (await base.group(groupId)).grades : []
    const names = (id: string) => Object.values(LOCAL_TEACHING_IDENTITIES).find(person => person.userId === id)?.fullName || roster.find(m => m.user_id === id)?.full_name || 'Учасник команди'
    const shared = state().shared.filter(x => x.item_id === itemId && x.group_id === groupId && (staff ? x.status !== 'draft' : x.team_id === myTeam?.id)).map(x => {
      const team = teams.find(t => t.id === x.team_id)
      const ownGrade = ownGrades.find(grade => grade.activity_id === data.activity_id)
      const submittedCopy = staff ? state().handedIn?.[x.id] || (x.status === 'submitted' ? { body: x.body, links: x.links, attachments: x.attachments } : { body: '', links: [], attachments: [] }) : null
      return { ...clone(x), ...(submittedCopy ? clone(submittedCopy) : {}), team_name: team?.name, team_members: team ? eligibleUsers(team).map(id => {
        const entry = snap?.entries.find(row => row.group_id === groupId && row.user_id === id && row.active)
        const grade = snap?.grades.find(row => row.entry_id === entry?.id && row.activity_id === data.activity_id)
        return { user_id: id, full_name: names(id), ...(staff && data.permissions.includes('grades') ? { entry_id: entry?.id, grade_version: grade?.version || 0, published_score: grade?.published_score ?? null, published_comment: grade?.published_comment || '', published_at: grade?.published_at || null } : {}) }
      }) : [], ...(!staff ? { published_score: ownGrade?.published_score ?? null, published_comment: ownGrade?.published_comment || '', grade_published_at: ownGrade?.published_at || null, grade_version: 0 } : {}) }
    })
    const own = shared.find(x => x.team_id === myTeam?.id) || null
    return { ...data, item, my_team: myTeam ? { id: myTeam.id, name: myTeam.name, members: eligibleUsers(myTeam).map(id => ({ user_id: id, full_name: names(id) })) } : null,
      my_submission: own, team_submission: own, submissions: staff ? shared : [], history: state().history.filter(h => shared.some(s => s.id === h.submission_id)).map(h => staff ? clone(h) : { ...clone(h), score: undefined, published_score: undefined }), students: data.students.filter(student => item.targets.some(t => t.group_id === groupId && hasAudience(t, item.course_id, item.id, student.user_id))), can_submit: data.can_submit && Boolean(myTeam), can_save_draft: data.can_save_draft && Boolean(myTeam) }
  }
  async function classroomMutate(action: string, payload: Record<string, unknown>) {
    if (payload.expected_user_id && payload.expected_user_id !== actor) fail('TEACHING_ACTOR_CHANGED')
    const s = clone(state())
    const existing = s.shared.find(x => x.id === payload.id)
    const itemId = existing?.item_id || String(payload.item_id || ''), groupId = existing?.group_id || String(payload.group_id || '')
    const teamAction = ['reserve_submission', 'save_submission', 'submit_submission', 'withdraw_submission', 'review_submission', 'grade_team_submission'].includes(action)
    if (teamAction && itemId && groupId) {
      const data = await classroom(itemId, groupId)
      if (data.item.submission_mode === 'team') {
        if (action === 'grade_team_submission') {
          if (payload.expected_user_id !== actor) fail('TEACHING_ACTOR_CHANGED')
          if (!staff || !data.permissions.includes('grades') || payload.confirm_team !== true || payload.publish !== true || !existing || !['submitted', 'reviewed'].includes(existing.status) || existing.version !== payload.version) fail('TEACHING_CONFLICT')
          const team = s.teams.find(t => t.id === existing.team_id)!, snap = await base.course(data.item.course_id)
          const activity = snap.activities.find(a => a.item_id === itemId && a.group_id === groupId)
          const score = Number(payload.score)
          if (!activity || !Number.isFinite(score) || score < 0 || score > activity.max_points) fail('TEACHING_INVALID_INPUT')
          const versions = payload.grade_versions as Record<string, number>
          const users = team.user_ids.filter(userId => data.item.targets.some(target => target.group_id === groupId && hasAudience(target, data.item.course_id, data.item.id, userId)))
          if (!users.length) fail('TEACHING_INVALID_INPUT')
          const rows = users.map(id => {
            const entry = snap.entries.find(e => e.user_id === id && e.group_id === groupId && e.active)
            if (!entry) fail('TEACHING_INVALID_INPUT')
            const grade = snap.grades.find(g => g.entry_id === entry.id && g.activity_id === activity.id)
            if (!versions || versions[entry.id] !== (grade?.version || 0)) fail('TEACHING_CONFLICT')
            return { entry_id: entry.id, version: grade?.version || 0, score, comment: String(payload.feedback || ''), reason: String(payload.reason || '') }
          })
          await base.mutate('save_grades_batch', { id: crypto.randomUUID(), course_id: data.item.course_id, group_id: groupId, activity_id: activity.id, expected_user_id: actor, rows })
          if (payload.publish) await base.mutate('publish_grades', { activity_id: activity.id, course_id: data.item.course_id, group_id: groupId, expected_versions: rows.map(row => ({ entry_id: row.entry_id, version: row.version + 1 })) })
          existing.version++; existing.feedback = String(payload.feedback || ''); existing.status = 'reviewed'; existing.reviewed_at = time(); existing.reviewed_by = actor
        } else if (action === 'review_submission') {
          if (!staff || !data.can_review || !existing || !['submitted', 'reviewed'].includes(existing.status) || existing.version !== payload.version) fail('TEACHING_CONFLICT')
          if (!['returned', 'reviewed'].includes(String(payload.status)) || payload.status === 'returned' && String(payload.feedback || '').trim().length < 2) fail('TEACHING_INVALID_INPUT')
          if (payload.score != null) fail('TEACHING_INVALID_INPUT')
          existing.status = payload.status === 'returned' ? 'returned' : 'reviewed'; existing.feedback = String(payload.feedback || ''); existing.reviewed_at = time(); existing.reviewed_by = actor; existing.version++
        } else {
          if (staff || !data.my_team || !data.can_save_draft || action === 'submit_submission' && !data.can_submit) fail()
          if (existing && existing.team_id !== data.my_team.id) fail()
          let shared = s.shared.find(x => x.team_id === data.my_team!.id && x.item_id === itemId)
          if (!shared && ['reserve_submission', 'save_submission'].includes(action)) {
            shared = { id: String(payload.id || crypto.randomUUID()), item_id: itemId, course_id: data.item.course_id, group_id: groupId, user_id: actor, team_id: data.my_team.id, status: 'draft', body: '', links: [], attachments: [], version: 1, attempt: 0, submitted_at: null, feedback: '', reviewed_at: null, reviewed_by: null, reviewer_name: null, student_name: identity.fullName, grade_version: 0, published_score: null, published_comment: '' }; s.shared.push(shared)
          }
          if (!shared) fail('TEACHING_NOT_FOUND')
          if (action === 'reserve_submission') { persist(s); return { id: shared.id, version: shared.version } }
          if (Number(payload.version) !== shared.version) fail('TEACHING_CONFLICT')
          if (action === 'save_submission') {
            if (!['draft', 'returned'].includes(shared.status)) fail('TEACHING_CONFLICT')
            const attachments = payload.attachments as TeachingFile[] || []
            if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(file => {
              const uploaded = sharedFiles.get(file.storage_path)?.file
              const prior = shared!.attachments.find(old => old.storage_path === file.storage_path)
              const source = uploaded || prior
              return !file.storage_path.startsWith(shared!.id + '/') || !source || source.size !== file.size || source.name !== file.name || source.mime_type !== file.mime_type
            })) fail('TEACHING_INVALID_INPUT')
            shared.body = String(payload.body || ''); shared.links = validateTeachingLinks(payload.links as string[] || []); shared.attachments = clone(attachments)
          } else if (action === 'submit_submission') {
            if (!['draft', 'returned'].includes(shared.status) || !shared.body.trim() && !shared.links.length && !shared.attachments.length) fail('TEACHING_INVALID_INPUT')
            shared.status = 'submitted'; shared.submitted_at = time(); shared.attempt++
            ;(s.handedIn ||= {})[shared.id] = clone({ body: shared.body, links: shared.links, attachments: shared.attachments })
          } else if (action === 'withdraw_submission') { if (shared.status !== 'submitted') fail('TEACHING_CONFLICT'); shared.status = 'draft' }
          shared.version++; shared.updated_at = time()
          if (action !== 'save_submission') s.history.push({ id: crypto.randomUUID(), submission_id: shared.id, attempt: shared.attempt, body: shared.body, links: clone(shared.links), attachments: clone(shared.attachments), feedback: shared.feedback, created_at: time(), actor_name: identity.fullName, action: action === 'submit_submission' ? 'submitted' : 'withdrawn', version: shared.version })
          persist(s); return { id: shared.id, version: shared.version }
        }
        persist(s); return { id: existing!.id, version: existing!.version }
      }
    }
    const targets = Array.isArray(payload.targets) ? payload.targets as TeachingTarget[] : payload.group_id ? [{ group_id: String(payload.group_id), audience_mode: payload.audience_mode as TeachingTarget['audience_mode'], subgroup_ids: payload.subgroup_ids as string[] | undefined, team_ids: payload.team_ids as string[] | undefined }] : []
    if (action.startsWith('save_') && payload.course_id && targets.length && (action.includes('assignment') || action.includes('material'))) await validateTargets(String(payload.course_id), targets, String(payload.id), action.includes('material') ? 'materials' : 'assignments')
    const result = await base.classroomMutate(action, payload)
    if (targets.length && result.id && (action.includes('assignment') || action.includes('material'))) { s.scopes[result.id] = { targets: clone(targets), submission_mode: payload.submission_mode as 'individual' | 'team' | undefined }; persist(s) }
    return result
  }
  async function scopedFile(file: TeachingFile, publication?: TeachingPublication) {
    const data = staff ? await base.course(publication?.course_id || file.storage_path.split('/')[0]) : await base.group(identity.groupId || '')
    const item = visible([...data.assignments, ...data.materials]).find(item => (!publication || item.id === publication.id) && item.attachments.some(stored => stored.storage_path === file.storage_path && stored.size === file.size && stored.mime_type === file.mime_type && stored.name === file.name))
    if (!item) fail()
    return item
  }
  return {
    ...base, audiences: { context, messages: async groupId => {
      const data = await base.group(groupId)
      return clone({ announcements: state().announcements.filter(a => a.targets.some(t => t.group_id === groupId && hasAudience(t, a.course_id))).map(a => {
        const delivery = state().announcementDelivery?.[a.id], receipt = delivery?.version === a.version ? delivery.recipients.find(row => row.user_id === actor) : undefined
        return { ...a, course_title: data.courses.find(course => course.id === a.course_id)?.title, targets: a.targets.filter(t => t.group_id === groupId), notification_id: receipt?.notification_id || null, acknowledged_at: receipt?.acknowledged_at || null }
      }) })
    }, mutate: (action, payload) => exclusive(() => audienceMutate(action, payload)), previewRecipients, receipts, acknowledge: (notificationId, expectedUserId) => exclusive(() => acknowledge(notificationId, expectedUserId)) },
    course: async id => { const s = await base.course(id); return { ...s, assignments: visible(s.assignments), materials: visible(s.materials) } },
    group: async id => { const s = await base.group(id); return { ...s, assignments: visible(s.assignments, id), materials: visible(s.materials, id) } },
    groupMaterials: async id => { const s = await base.groupMaterials(id); return { ...s, materials: visible(s.materials, id) } },
    groupAssignments: async (id, date) => { const s = await base.groupAssignments(id, date); return { assignments: visible(s.assignments, id) } },
    fileUrl: async file => { await scopedFile(file); return base.fileUrl(file) },
    materialFileInfo: async (publication, file, signal) => { const item = await scopedFile(file, publication); return base.materialFileInfo(item, file, signal) },
    materialFileChunk: async (publication, file, offset, length, signal) => { const item = await scopedFile(file, publication); return base.materialFileChunk(item, file, offset, length, signal) },
    materialFilePage: async (publication, file, page, signal) => { const item = await scopedFile(file, publication); return base.materialFilePage(item, file, page, signal) },
    uploadSubmission: async (submissionId, uploadActor, file, onProgress, signal) => {
      const submission = state().shared.find(row => row.id === submissionId)
      if (!submission) return base.uploadSubmission(submissionId, uploadActor, file, onProgress, signal)
      signal?.throwIfAborted()
      const data = await classroom(submission.item_id, submission.group_id)
      if (staff || uploadActor !== actor || data.my_team?.id !== submission.team_id || !data.can_save_draft || !['draft', 'returned'].includes(submission.status)) fail()
      validateTeachingFile(file)
      const storage_path = `${submissionId}/${actor}/${crypto.randomUUID()}.${file.name.split('.').pop()!.toLowerCase()}`
      const metadata = { storage_path, name: file.name, mime_type: file.type || 'application/octet-stream', size: file.size }
      sharedFiles.set(storage_path, { url: URL.createObjectURL(file), file: metadata }); onProgress?.(100)
      return clone(metadata)
    },
    submissionFileUrl: async file => {
      const submission = state().shared.find(row => file.storage_path.startsWith(row.id + '/'))
      if (!submission) return base.submissionFileUrl(file)
      const data = await classroom(submission.item_id, submission.group_id)
      const permitted = staff ? data.submissions.some(row => row.id === submission.id) : data.my_team?.id === submission.team_id
      const visible = staff ? data.submissions.find(row => row.id === submission.id) : submission
      const linked = visible?.attachments.some(row => row.storage_path === file.storage_path) || data.history.some(row => row.attachments.some(attachment => attachment.storage_path === file.storage_path))
      if (!permitted || !linked) fail()
      const stored = sharedFiles.get(file.storage_path)
      if (!stored) throw new Error('Локальний файл доступний до перезавантаження сторінки.')
      return stored.url
    },
    classroom, classroomMutate: (action, payload) => exclusive(() => classroomMutate(action, payload)),
    mutate: (action, payload) => exclusive(async () => {
      if (Array.isArray(payload.targets) && payload.targets.length && payload.course_id && (action.includes('assignment') || action.includes('material'))) await validateTargets(String(payload.course_id), payload.targets as TeachingTarget[], String(payload.id), action.includes('material') ? 'materials' : 'assignments')
      const result = await base.mutate(action, payload)
      if (result.id && Array.isArray(payload.targets)) { const s = clone(state()); s.scopes[result.id] = { targets: clone(payload.targets as TeachingTarget[]), submission_mode: payload.submission_mode as 'individual' | 'team' | undefined }; persist(s) }
      return result
    }),
  }
}
