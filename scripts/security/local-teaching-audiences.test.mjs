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
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
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
  return { load }
}

test('actual local audience repositories preserve scoped messages, shared work, files and individual grades across roles', async t => {
  const fx = fixture(), api = fx.load('src/lib/localTeachingAudienceRepository.ts')
  api.resetLocalTeachingAudiencePreview()
  t.after(() => api.resetLocalTeachingAudiencePreview())
  await api.prepareLocalTeachingAudiencePreview()
  const teacher = api.createLocalTeachingAudienceRepository('teacher'), student = api.createLocalTeachingAudienceRepository('student'), head = api.createLocalTeachingAudienceRepository('head'), colleague = api.createLocalTeachingAudienceRepository('colleague')
  const course = uuid(21), group = uuid(11), lab = uuid(183), teacherId = uuid(1), studentId = uuid(2), headId = uuid(3)
  const initial = await teacher.course(course)

  await t.test('seeding is idempotent and uses an ordinary assessed assignment with its linked activity', async () => {
    const item = initial.assignments.find(item => item.id === lab)
    assert.equal(item.max_points, 10); assert.equal(item.submission_mode, 'team')
    assert.ok(initial.activities.some(activity => activity.item_id === lab && activity.max_points === 10))
    await api.prepareLocalTeachingAudiencePreview()
    assert.equal((await teacher.course(course)).assignments.find(item => item.id === lab).version, item.version)
  })
  await t.test('subgroup content is absent from direct data, files and messages for other students', async () => {
    const studentData = await student.group(group), headData = await head.group(group)
    const restricted = studentData.materials.find(item => item.id === uuid(203))
    assert.ok(restricted); assert.ok(!headData.materials.some(item => item.id === restricted.id))
    await assert.rejects(head.materialFileInfo(restricted, restricted.attachments[0]), /FORBIDDEN/)
    await assert.rejects(head.fileUrl(restricted.attachments[0]), /FORBIDDEN/)
    assert.equal((await student.audiences.messages(group)).announcements.length, 2)
    assert.equal((await head.audiences.messages(group)).announcements.length, 1)
    assert.ok((await student.audiences.messages(group)).announcements.every(item => item.course_title))
    await assert.rejects(student.audiences.context(course), /FORBIDDEN/)
  })
  await t.test('author can update a message once; stale versions, another teacher and foreign group scope are rejected', async () => {
    const message = (await teacher.audiences.context(course)).announcements.find(item => item.id === uuid(822))
    const payload = { ...message, body: 'Оновлений текст лише для першої підгрупи', expected_user_id: teacherId }
    await teacher.audiences.mutate('save_announcement', payload)
    assert.equal((await student.audiences.messages(group)).announcements.find(item => item.id === message.id).body, payload.body)
    assert.ok(!(await head.audiences.messages(group)).announcements.some(item => item.id === message.id))
    await assert.rejects(teacher.audiences.mutate('save_announcement', payload), /CONFLICT/)
    await assert.rejects(colleague.audiences.mutate('save_announcement', { ...payload, version: message.version + 1, expected_user_id: uuid(4) }), /FORBIDDEN/)
    await assert.rejects(colleague.audiences.mutate('save_announcement', { id: uuid(900), course_id: course, title: 'Зайва група', body: 'Не повинно зберегтися', version: 0, targets: [{ group_id: uuid(12), audience_mode: 'all' }] }), /FORBIDDEN/)
  })

  let shared, uploaded
  await t.test('simultaneous teammates reserve one canonical row and share a draft without exposing it to staff', async () => {
    const [first, second] = await Promise.all([
      student.classroomMutate('reserve_submission', { id: uuid(901), item_id: lab, group_id: group }),
      head.classroomMutate('reserve_submission', { id: uuid(902), item_id: lab, group_id: group }),
    ])
    assert.equal(first.id, second.id); shared = first
    uploaded = await student.uploadSubmission(shared.id, studentId, new File(['Спільна відповідь'], 'Команда.txt', { type: 'text/plain' }))
    shared = await student.classroomMutate('save_submission', { id: shared.id, item_id: lab, group_id: group, version: shared.version, body: 'Повний спільний опис', links: [], attachments: [uploaded] })
    const other = await head.classroom(lab, group)
    assert.equal(other.my_submission.id, shared.id); assert.equal(other.my_submission.body, 'Повний спільний опис')
    assert.equal(other.my_team.members.length, 2)
    assert.match(await head.submissionFileUrl(uploaded), /^blob:/)
    assert.equal((await teacher.classroom(lab, group)).submissions.length, 0)
    await assert.rejects(teacher.submissionFileUrl(uploaded), /FORBIDDEN/)
    await assert.rejects(student.uploadSubmission(shared.id, headId, new File(['x'], 'fake.txt', { type: 'text/plain' })), /FORBIDDEN/)
  })
  await t.test('stale or forged team updates cannot replace content, and submitting creates one visible work without automatic grades', async () => {
    await assert.rejects(head.classroomMutate('save_submission', { id: shared.id, item_id: lab, group_id: group, version: shared.version - 1, body: 'Затерти чужу правку', links: [], attachments: [] }), /CONFLICT/)
    await assert.rejects(head.classroomMutate('save_submission', { id: shared.id, item_id: lab, group_id: group, version: shared.version, body: 'Підміна файлу', links: [], attachments: [{ ...uploaded, storage_path: 'other-team/user/file.txt' }] }), /INVALID/)
    shared = await head.classroomMutate('submit_submission', { id: shared.id, version: shared.version })
    const work = await teacher.classroom(lab, group)
    assert.equal(work.submissions.length, 1); assert.equal(work.submissions[0].id, shared.id)
    assert.equal(work.submissions[0].team_members.length, 2)
    assert.match(await teacher.submissionFileUrl(uploaded), /^blob:/)
    assert.deepEqual(plain((await teacher.course(course)).grades), plain(initial.grades))
  })
  await t.test('explicit team grade writes separate journal rows, publishes own results only, and refreshes real versions', async () => {
    const work = await teacher.classroom(lab, group), submission = work.submissions[0]
    const versions = Object.fromEntries(submission.team_members.map(member => [member.entry_id, member.grade_version]))
    const payload = { id: shared.id, version: shared.version, score: 8, feedback: 'Спільну роботу перевірено', reason: '', publish: true, confirm_team: true, expected_user_id: teacherId, grade_versions: versions }
    await assert.rejects(teacher.classroomMutate('grade_team_submission', { ...payload, expected_user_id: uuid(4) }), /ACTOR_CHANGED/)
    await assert.rejects(teacher.classroomMutate('grade_team_submission', { ...payload, confirm_team: false }), /CONFLICT/)
    shared = await teacher.classroomMutate('grade_team_submission', payload)
    const reviewed = await teacher.classroom(lab, group)
    assert.ok(reviewed.submissions[0].team_members.every(member => member.grade_version > versions[member.entry_id]))
    assert.ok(reviewed.submissions[0].team_members.every(member => member.published_score === 8))
    const maria = await student.classroom(lab, group), andrii = await head.classroom(lab, group)
    assert.equal(maria.my_submission.published_score, 8); assert.equal(andrii.my_submission.published_score, 8)
    assert.ok(maria.my_submission.team_members.every(member => !('published_score' in member)))
    assert.ok(andrii.my_submission.team_members.every(member => !('published_score' in member)))
    await assert.rejects(teacher.classroomMutate('grade_team_submission', payload), /CONFLICT/)
    const journal = await teacher.course(course)
    assert.equal(journal.grades.filter(grade => grade.activity_id === reviewed.activity_id && grade.published_score === 8).length, 2)
    assert.equal((await student.group(group)).grades.filter(grade => grade.activity_id === reviewed.activity_id).length, 1)
  })
  await t.test('returned teamwork keeps new draft text and files private from staff until a new submission', async () => {
    shared = await teacher.classroomMutate('review_submission', { id: shared.id, version: shared.version, status: 'returned', feedback: 'Додайте розрахунки' })
    const draftFile = await head.uploadSubmission(shared.id, headId, new File(['Ще не надіслано'], 'Нова-чернетка.txt', { type: 'text/plain' }))
    shared = await head.classroomMutate('save_submission', { id: shared.id, item_id: lab, group_id: group, version: shared.version, body: 'Приватні нові розрахунки', links: [], attachments: [uploaded, draftFile] })
    assert.equal((await student.classroom(lab, group)).my_submission.body, 'Приватні нові розрахунки')
    assert.equal((await teacher.classroom(lab, group)).submissions[0].body, 'Повний спільний опис')
    await assert.rejects(teacher.submissionFileUrl(draftFile), /FORBIDDEN/)
    shared = await student.classroomMutate('submit_submission', { id: shared.id, version: shared.version })
    assert.equal((await teacher.classroom(lab, group)).submissions[0].body, 'Приватні нові розрахунки')
    assert.match(await teacher.submissionFileUrl(draftFile), /^blob:/)
  })
  await t.test('narrowing an assignment audience filters the effective team and bulk grades without changing its stored roster', async () => {
    const item = (await teacher.course(course)).assignments.find(item => item.id === lab)
    const previousHeadGrade = (await head.group(group)).grades.find(grade => grade.activity_id === (initial.activities.find(activity => activity.item_id === lab)?.id))
    const untouchedGrade = (await teacher.course(course)).grades.find(grade => grade.id === previousHeadGrade.id)
    await teacher.classroomMutate('save_group_assignment', { ...item, expected_user_id: teacherId, group_id: group, targets: [{ group_id: group, placement_mode: 'unplaced', lesson_date: initial.activities.find(activity => activity.item_id === lab).activity_date, due_at: null, audience_mode: 'subgroups', subgroup_ids: [uuid(801)] }] })
    const work = await teacher.classroom(lab, group), current = work.submissions[0]
    assert.deepEqual(plain(current.team_members.map(member => member.user_id)), [studentId])
    assert.deepEqual(plain((await student.classroom(lab, group)).my_team.members.map(member => member.user_id)), [studentId])
    assert.equal((await teacher.audiences.context(course)).teams.find(team => team.id === uuid(811)).user_ids.length, 2)
    await assert.rejects(head.classroom(lab, group), /FORBIDDEN/)
    await teacher.classroomMutate('grade_team_submission', { id: current.id, version: current.version, expected_user_id: teacherId, score: 9, feedback: 'Уточнений результат', reason: 'Уточнено після відповіді', publish: true, confirm_team: true, grade_versions: Object.fromEntries(current.team_members.map(member => [member.entry_id, member.grade_version])) })
    assert.equal((await student.classroom(lab, group)).my_submission.published_score, 9)
    assert.deepEqual(plain((await teacher.course(course)).grades.find(grade => grade.id === untouchedGrade.id)), plain(untouchedGrade))
    assert.equal((await head.group(group)).grades.find(grade => grade.activity_id === work.activity_id).published_score, 8)
  })
})
