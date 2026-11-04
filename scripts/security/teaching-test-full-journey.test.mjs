// One complete student/teacher journey through real local PostgreSQL functions.
// Every identity, answer, grade and publication is synthetic; no remote services.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

const migrations = [
  '202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql',
  '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040010_teaching_tests.sql',
  '202611040011_teaching_journal_preferences_absence.sql', '202611040020_assessment_bank_variants.sql',
  '202611040021_teaching_rubrics.sql', '202611040022_rubric_correction_publication.sql',
]
const attemptFor = (detail, user) => detail.attempts.find(attempt => attempt.user_id === user)
const hiddenScore = detail => {
  assert.deepEqual(detail.attempts, [])
  assert.deepEqual(detail.test.questions, [])
  for (const field of ['score', 'auto_score', 'final_score', 'bonus_score', 'rank', 'bonus_winner', 'questions', 'question_results', 'review_history', 'grade_snapshot', 'current_grade']) {
    assert.equal(detail.attempt[field], undefined, `private assessment field: ${field}`)
  }
}

test('full journey: student answers and submits; teacher corrects and approves; only explicit publication reveals each own result', async t => {
  const fx = await audienceFixture()
  t.after(() => fx.close())
  for (const migration of migrations) await fx.db.exec(await readFile(new URL('../../supabase/migrations/' + migration, import.meta.url), 'utf8'))
  const { ids, groups, dates, db, rpc, mutate } = fx
  const act = (who, action, payload) => rpc(who, 'xelay_teaching_test_mutate', [action, JSON.stringify({ expected_user_id: who, ...payload })])
  const detail = who => rpc(who, 'xelay_teaching_test', [definition.id])
  const list = who => rpc(who, 'xelay_teaching_tests', [ids.course, groups[0]])
  const journal = who => rpc(who, 'xelay_teaching_course', [ids.course])
  const ordinary = syntheticTest(ids.course, [groups[0]])
  const question = (kind, extra) => ({ id: kind, kind, text: 'Вигадане навчальне запитання', points: 5,
    time_limit_seconds: null, partial_credit: false, options: [], buckets: [], ...extra })
  const definition = syntheticTest(ids.course, [groups[0]], {
    title: 'Контрольна · повний шлях публікації', journal_date: dates.lesson_a, work_type: 'МКР',
    questions: [
      { ...ordinary.questions[0], time_limit_seconds: null },
      question('short_text', { answer: ['попит', 'demand'] }),
      question('numerical', { answer: '12.5', tolerance: 0.1 }),
      question('essay', { text: 'Поясніть відповідь своїми словами.' }),
    ],
  })
  let teacher, own, peer
  let activityId, ownGradeId, peerGradeId

  await t.test('publication creates exactly one dated work column, and only intended students see the test', async () => {
    teacher = await act(ids.owner, 'save_test', definition)
    const columns = (await db.query('select a.* from teaching_test_activities l join teaching_activities a on a.id=l.activity_id where l.test_id=$1', [definition.id])).rows
    assert.equal(columns.length, 1)
    activityId = columns[0].id
    assert.equal(columns[0].work_type, 'МКР')
    assert.equal(columns[0].activity_date.toISOString().slice(0, 10), dates.lesson_a)
    assert.equal((await list(ids.studentA)).tests[0].id, definition.id)
    assert.equal((await list(ids.headA)).tests[0].id, definition.id)
    assert.equal((await list(ids.studentB)).tests.length, 0)
    await assert.rejects(detail(ids.studentB), /FORBIDDEN/)
    await assert.rejects(act(ids.owner, 'start', { id: definition.id, group_id: groups[0] }), /FORBIDDEN/,
      'teacher rehearsals cannot create real competing student attempts')
  })

  await t.test('student saves answers, resumes the same timed attempt, navigates, submits once, and cannot see hidden answers or provisional marks', async () => {
    own = await act(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
    const first = own.attempt
    assert.equal(first.status, 'in_progress')
    assert.equal(first.current_question.id, 'choice')
    assert.equal(first.current_question.answer, undefined)
    own = await act(ids.studentA, 'save_answer', { id: definition.id, version: first.version, question_id: 'choice', answer: 'a' })
    const resumed = await detail(ids.studentA)
    assert.equal(resumed.attempt.id, first.id)
    assert.equal(resumed.attempt.expires_at, first.expires_at)
    assert.equal(resumed.attempt.answers.choice, 'a')
    await assert.rejects(act(ids.studentA, 'save_answer', { id: definition.id, version: first.version, question_id: 'choice', answer: 'b' }), /CONFLICT/)
    const answers = { short_text: ' ПОПИТ ', numerical: '12,55', essay: 'Моє вигадане пояснення для локальної перевірки.' }
    for (let index = 1; index < definition.questions.length; index++) {
      own = await act(ids.studentA, 'navigate', { id: definition.id, version: own.attempt.version, index })
      const current = own.attempt.current_question
      assert.equal(current.answer, undefined)
      own = await act(ids.studentA, 'save_answer', { id: definition.id, version: own.attempt.version, question_id: current.id, answer: answers[current.id] })
    }
    own = await act(ids.studentA, 'finish', { id: definition.id, version: own.attempt.version })
    assert.equal(own.attempt.status, 'submitted')
    assert.ok(own.attempt.submitted_at)
    hiddenScore(own)
    const repeated = await act(ids.studentA, 'start', { id: definition.id, group_id: groups[0] })
    assert.equal(repeated.attempt.id, first.id)
    assert.equal(repeated.attempt.status, 'submitted')
    assert.deepEqual(repeated.attempt.answers, own.attempt.answers)
    assert.equal((await db.query('select count(*)::int n from teaching_test_attempts where test_id=$1 and user_id=$2', [definition.id, ids.studentA])).rows[0].n, 1)
    assert.equal((await journal(ids.studentA)).grades.length, 0)
  })

  await t.test('another participant has an independent attempt; teacher sees all answers and preliminary points, students cannot review', async () => {
    peer = await act(ids.headA, 'start', { id: definition.id, group_id: groups[0] })
    const answers = ['b', 'demand', '12.5', 'Інше вигадане пояснення.']
    for (const [index, item] of definition.questions.entries()) {
      if (index) peer = await act(ids.headA, 'navigate', { id: definition.id, version: peer.attempt.version, index })
      peer = await act(ids.headA, 'save_answer', { id: definition.id, version: peer.attempt.version, question_id: item.id, answer: answers[index] })
    }
    peer = await act(ids.headA, 'finish', { id: definition.id, version: peer.attempt.version })
    assert.notEqual(peer.attempt.id, own.attempt.id)
    teacher = await detail(ids.owner)
    assert.equal(teacher.attempts.length, 2)
    assert.equal(attemptFor(teacher, ids.studentA).auto_score, 10)
    assert.equal(attemptFor(teacher, ids.headA).auto_score, 15)
    assert.equal(attemptFor(teacher, ids.studentA).answers.essay, own.attempt.answers.essay)
    assert.equal(attemptFor(teacher, ids.studentA).question_results.find(mark => mark.question_id === 'essay').requires_review, true)
    await assert.rejects(act(ids.studentA, 'save_review', { id: definition.id, attempt_id: own.attempt.id,
      version: attemptFor(teacher, ids.studentA).version, marks: [{ question_id: 'choice', mode: 'full', reason: 'Спроба самостійно змінити бал' }] }), /FORBIDDEN|UNVERIFIED/)
    await assert.rejects(act(ids.owner, 'finalize_results', { id: definition.id, version: teacher.test.version }), /RESULTS_NOT_READY/)
  })

  await t.test('teacher checks open answers, corrects automatic marking with a reason, then approves the speed bonus', async () => {
    // Simulate the named local example's access window ending; no production clock or data changes.
    await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1", [definition.id])
    await assert.rejects(act(ids.owner, 'finalize_results', { id: definition.id, version: teacher.test.version }), /MANUAL_REVIEW_REQUIRED/)
    teacher = await act(ids.owner, 'save_review', { id: definition.id, attempt_id: own.attempt.id,
      version: attemptFor(teacher, ids.studentA).version, marks: [
        { question_id: 'choice', mode: 'full', reason: 'Відповідь зараховано після уточнення формулювання.' },
        { question_id: 'essay', mode: 'custom', points: 3, reason: 'Зміст розкрито частково, приклад потребує уточнення.' },
      ] })
    assert.equal(attemptFor(teacher, ids.studentA).score, 18)
    assert.equal(attemptFor(teacher, ids.studentA).auto_score, 10)
    assert.equal(attemptFor(teacher, ids.studentA).review_history.length, 2)
    teacher = await act(ids.owner, 'save_review', { id: definition.id, attempt_id: peer.attempt.id,
      version: attemptFor(teacher, ids.headA).version, marks: [{ question_id: 'essay', mode: 'zero', reason: 'Пояснення не відповідає запитанню.' }] })
    teacher = await act(ids.owner, 'finalize_results', { id: definition.id, version: teacher.test.version })
    const winner = attemptFor(teacher, ids.studentA), second = attemptFor(teacher, ids.headA)
    assert.equal(winner.rank, 1)
    assert.equal(winner.bonus_score, 2)
    assert.equal(winner.final_score, 20)
    assert.equal(second.bonus_score, 0)
    assert.equal(second.final_score, 15)
    assert.equal(teacher.test.approved_revision, teacher.test.review_revision)
    hiddenScore(await detail(ids.studentA))
    assert.equal((await journal(ids.studentA)).grades.length, 0)
  })

  await t.test('transfer saves only journal drafts, remains idempotent and does not publish students results', async () => {
    teacher = await act(ids.owner, 'review_results', { id: definition.id, version: teacher.test.version })
    const grades = (await db.query('select g.*, e.user_id from teaching_grades g join teaching_entries e on e.id=g.entry_id where g.activity_id=$1 order by e.user_id', [activityId])).rows
    assert.equal(grades.length, 2)
    ownGradeId = grades.find(grade => grade.user_id === ids.studentA).id
    peerGradeId = grades.find(grade => grade.user_id === ids.headA).id
    assert.equal(Number(grades.find(grade => grade.id === ownGradeId).draft_score), 20)
    assert.equal(Number(grades.find(grade => grade.id === peerGradeId).draft_score), 15)
    assert.ok(grades.every(grade => grade.published_at === null && grade.published_score === null))
    await act(ids.owner, 'review_results', { id: definition.id, version: teacher.test.version })
    assert.deepEqual((await db.query('select id,version from teaching_grades where activity_id=$1 order by id', [activityId])).rows,
      grades.map(({ id, version }) => ({ id, version })).sort((left, right) => left.id.localeCompare(right.id)))
    const pending = await detail(ids.studentA)
    hiddenScore(pending)
    assert.equal(pending.attempt.published_score, null)
    assert.equal(pending.attempt.grade_published_at, null)
    assert.equal((await journal(ids.studentA)).grades.length, 0)
    await assert.rejects(mutate(ids.studentA, 'publish_grades', { activity_id: activityId, expected_versions: [] }), /FORBIDDEN|UNVERIFIED/)
  })

  await t.test('teacher explicitly publishes; student sees own grade in both test and journal while peer grade stays private', async () => {
    const versions = (await db.query('select entry_id,version from teaching_grades where activity_id=$1', [activityId])).rows
    await mutate(ids.owner, 'publish_grades', { activity_id: activityId, expected_versions: versions })
    const ownView = await detail(ids.studentA), peerView = await detail(ids.headA)
    hiddenScore(ownView)
    hiddenScore(peerView)
    assert.equal(ownView.attempt.published_score, 20)
    assert.equal(peerView.attempt.published_score, 15)
    assert.ok(ownView.attempt.grade_published_at)
    assert.equal((await list(ids.studentA)).tests[0].my_attempt.published_score, 20)
    const ownJournal = await journal(ids.studentA), peerJournal = await journal(ids.headA)
    assert.equal(ownJournal.grades.length, 1)
    assert.equal(peerJournal.grades.length, 1)
    assert.equal(ownJournal.grades[0].id, ownGradeId)
    assert.equal(ownJournal.grades[0].published_score, 20)
    assert.equal(peerJournal.grades[0].id, peerGradeId)
    assert.equal(peerJournal.grades[0].published_score, 15)
    assert.equal(ownJournal.grades[0].draft_score, undefined)
    assert.equal(ownJournal.audit.length, 0)
    assert.ok(ownJournal.entries.every(entry => entry.user_id === ids.studentA))
    assert.equal((await journal(ids.studentB)).grades.length, 0)
    await assert.rejects(fx.asUser(ids.studentA, 'select * from teaching_test_attempts'), /permission denied/)
  })
})
