import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/teachingTeamSubmissions.ts', import.meta.url), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports })
const { ownTeachingSubmission, teachingTeamGradePayload, teachingTeamGradePreview } = module.exports
const members = [
  { user_id: 'maria', full_name: 'Марія', entry_id: 'entry-maria', grade_version: 2, published_score: 4, published_at: '2026-11-02T08:00:00Z' },
  { user_id: 'andrii', full_name: 'Андрій', entry_id: 'entry-andrii', grade_version: 0, published_score: null },
]
const submission = { id: 'shared-work', user_id: 'maria', team_id: 'team-a', version: 7, team_members: members }
const data = { my_submission: submission, my_team: { id: 'team-a', members } }

test('teammate can open one shared work, a different student cannot inherit it', () => {
  assert.equal(ownTeachingSubmission(data, 'andrii'), submission)
  assert.equal(ownTeachingSubmission(data, 'other-student'), null)
  assert.equal(ownTeachingSubmission(data, ''), null)
})
test('removed member and stale team selection fail closed even if uploader matches', () => {
  assert.equal(ownTeachingSubmission({ ...data, my_team: { id: 'team-a', members: [members[1]] } }, 'maria'), null)
  assert.equal(ownTeachingSubmission({ ...data, my_team: { id: 'team-b', members } }, 'maria'), null)
  assert.equal(ownTeachingSubmission({ my_submission: submission }, 'maria'), null)
})
test('individual work remains private to its author', () => {
  const individual = { ...submission, team_id: null }
  assert.equal(ownTeachingSubmission({ my_submission: individual }, 'maria'), individual)
  assert.equal(ownTeachingSubmission({ ...data, my_submission: individual }, 'andrii'), null)
})
test('bulk grades require a separate explicit confirmation', () => {
  assert.throws(() => teachingTeamGradePayload(submission, 10, 8, 'Добре', 'Уточнено', false, 'teacher'), /Підтвердьте/)
  assert.throws(() => teachingTeamGradePayload(submission, 10, 8, 'Добре', 'Уточнено', true, ''), /Акаунт/)
})
test('bulk write preserves separate optimistic versions and exact captured team', () => {
  const payload = teachingTeamGradePayload(submission, 10, 8, ' Добре ', ' Уточнено ', true, 'teacher')
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), { id: 'shared-work', version: 7, expected_user_id: 'teacher', score: 8, feedback: 'Добре', reason: 'Уточнено', publish: true, confirm_team: true, grade_versions: { 'entry-maria': 2, 'entry-andrii': 0 } })
  assert.equal(members[0].published_score, 4)
  assert.equal(members[1].published_score, null)
})
test('existing member grades cannot be overwritten without a reason', () => {
  assert.throws(() => teachingTeamGradePayload(submission, 10, 8, '', ' ', true, 'teacher'), /причину/)
})
test('missing journal links reject the whole action instead of silently skipping a member', () => {
  assert.throws(() => teachingTeamGradePreview({ ...submission, team_members: [members[0], { user_id: 'third', full_name: 'Третій' }] }, 10, 5), /всіх учасників/)
})
test('duplicate members or journal entries cannot receive duplicate batch writes', () => {
  for (const duplicate of [members[0], { ...members[1], entry_id: members[0].entry_id }]) assert.throws(() => teachingTeamGradePreview({ ...submission, team_members: [members[0], duplicate] }, 10, 5), /Склад команди/)
})
test('invalid scores, individual work and absent team roster cannot reach preview', () => {
  for (const score of [null, NaN, Infinity, -1, 11]) assert.throws(() => teachingTeamGradePreview(submission, 10, score))
  assert.throws(() => teachingTeamGradePreview({ ...submission, team_id: null }, 10, 5))
  assert.throws(() => teachingTeamGradePreview({ ...submission, team_members: [] }, 10, 5))
  assert.throws(() => teachingTeamGradePreview(submission, 0, 0))
})
test('zero is a real score and fresh ungraded teams do not need a revision reason', () => {
  const ungraded = { ...submission, team_members: members.map(member => ({ ...member, published_at: null, published_score: null })) }
  const payload = teachingTeamGradePayload(ungraded, 10, 0, '', '', true, 'teacher')
  assert.equal(payload.score, 0)
  assert.equal(payload.reason, '')
})
