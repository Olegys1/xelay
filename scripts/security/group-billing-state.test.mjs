import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/billingState.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { parseGroupBillingStatus, groupContentAccess } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const start = '2026-10-03T12:00:00.000Z'
const end = '2026-10-10T12:00:00.000Z'
const activeTrial = {
  is_active: true, source: 'trial', can_edit: false, payment_required: false,
  enforcement_enabled: true, expires_at: end, is_lifetime: false, can_renew: true,
  trial_started_at: start, trial_expires_at: end, trial_used: true,
  can_participate: true, server_now: start, remaining_seconds: 604800,
}

test('trial participation is independent of staff rights and stops at the exact expiry', () => {
  const status = parseGroupBillingStatus(activeTrial)
  assert.equal(status.can_edit, false)
  assert.equal(status.trial_active, true)
  assert.equal(groupContentAccess(status, Date.parse(end) - 1), true)
  assert.equal(groupContentAccess(status, Date.parse(end)), false)
  assert.equal(groupContentAccess(status, Date.parse(end) + 1), false)
})

test('client dates never reactivate a server-denied group or override its participation gate', () => {
  const inactive = parseGroupBillingStatus({ ...activeTrial, is_active: false, can_participate: false, payment_required: true })
  assert.equal(groupContentAccess(inactive, Date.parse(start) - 86400000), false)
  const denied = parseGroupBillingStatus({ ...activeTrial, enforcement_enabled: false, can_participate: false })
  assert.equal(groupContentAccess(denied, Date.parse(start)), false)
  const deniedDespiteFutureExpiry = parseGroupBillingStatus({ ...activeTrial, is_active: false, can_participate: true })
  assert.equal(groupContentAccess(deniedDespiteFutureExpiry, Date.parse(start)), false)
})

test('a manually prepaid year keeps its trial dates and uses the paid expiry', () => {
  const paidEnd = '2027-10-10T12:00:00.000Z'
  const status = parseGroupBillingStatus({ ...activeTrial, source: 'payment', can_edit: true, expires_at: paidEnd })
  assert.equal(status.trial_active, false)
  assert.equal(status.trial_used, true)
  assert.equal(status.trial_expires_at, end)
  assert.equal(groupContentAccess(status, Date.parse(end)), true)
  assert.equal(groupContentAccess(status, Date.parse(paidEnd)), false)
})

test('historical lifetime and annual statuses retain compatibility without starting a trial', () => {
  const base = { is_active: true, source: 'free', can_edit: true, payment_required: false, enforcement_enabled: true, expires_at: null }
  for (const source of ['free', 'admin_grant']) {
    const status = parseGroupBillingStatus({ ...base, source })
    assert.equal(status.is_lifetime, true)
    assert.equal(status.trial_used, false)
    assert.equal(groupContentAccess(status, Date.parse('2099-01-01')), true)
  }
  const lifetimePayment = parseGroupBillingStatus({ ...base, source: 'payment', is_lifetime: true })
  assert.equal(groupContentAccess(lifetimePayment, Date.parse('2099-01-01')), true)
  const annual = parseGroupBillingStatus({ ...base, source: 'payment', is_lifetime: false, expires_at: end })
  assert.equal(groupContentAccess(annual, Date.parse(start)), true)
  assert.equal(groupContentAccess(annual, Date.parse(end)), false)
  const legacyUnenforced = parseGroupBillingStatus({ ...base, source: null, is_active: false, enforcement_enabled: false })
  assert.equal(groupContentAccess(legacyUnenforced, Date.parse(start)), true)
})

test('malformed group billing status fails closed', () => {
  for (const invalid of [null, [], false, {},
    { ...activeTrial, is_active: 'true' },
    { ...activeTrial, can_edit: 1 },
    { ...activeTrial, source: 'unrecognized' },
    { ...activeTrial, expires_at: null },
    { ...activeTrial, expires_at: 'invalid' },
    { ...activeTrial, server_now: 'invalid' },
    { ...activeTrial, can_participate: 'true' },
    { ...activeTrial, trial_started_at: null },
    { ...activeTrial, trial_expires_at: start },
    { ...activeTrial, trial_expires_at: '2026-10-02T12:00:00.000Z' },
    { ...activeTrial, remaining_seconds: -1 },
    { ...activeTrial, remaining_seconds: 1.5 },
    { ...activeTrial, remaining_seconds: Number.MAX_SAFE_INTEGER + 1 },
    { ...activeTrial, trial_active: 'true' },
    { ...activeTrial, trial_active: true, source: 'payment' },
  ]) assert.throws(() => parseGroupBillingStatus(invalid), /Invalid group/)
})
