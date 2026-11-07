import test from 'node:test'
import assert from 'node:assert/strict'
import { HOME_REFERRAL_NOTICE, showHomeReferralNotice } from '../../src/lib/homeReferralNotice.ts'

const student = { role: 'student', context: 'learning', status: 'ready', clockIso: '2026-11-10T10:00:00+02:00' }

test('the approved Kyiv campaign window includes its exact boundaries and expires without another read', () => {
  const start = Date.parse(HOME_REFERRAL_NOTICE.startsAt), end = Date.parse(HOME_REFERRAL_NOTICE.endsAt)
  assert.equal(new Date(start).toISOString(), '2026-11-07T22:00:00.000Z')
  assert.equal(new Date(end).toISOString(), '2026-11-21T21:59:00.000Z')
  for (const [time, expected] of [[start - 1, false], [start, true], [end, true], [end + 1, false]]) {
    assert.equal(showHomeReferralNotice({ ...student, clockIso: new Date(time).toISOString() }), expected)
  }
  assert.equal(showHomeReferralNotice({ ...student, clockIso: 'invalid' }), false)
})

test('only a ready student or headman learning context can display the notice', () => {
  assert.equal(showHomeReferralNotice(student), true)
  assert.equal(showHomeReferralNotice({ ...student, role: 'headman' }), true)
  for (const change of [{ role: 'teacher' }, { context: 'teaching' }, { status: 'loading' }, { status: 'error' }, { status: 'pending' }]) {
    assert.equal(showHomeReferralNotice({ ...student, ...change }), false)
  }
  assert.equal(HOME_REFERRAL_NOTICE.href, '/referrals')
})
