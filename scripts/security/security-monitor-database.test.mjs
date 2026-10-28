// Real SQL, synthetic data, and in-memory PostgreSQL only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSecurityMonitorFixture, zeroObservations } from './security-monitor-fixture.mjs'

test('private aggregate monitor and durable delivery queue', async t => {
  const fx = await createSecurityMonitorFixture()
  t.after(() => fx.close())
  const { db, rpc, one, read, asRole } = fx
  const state = () => one('select * from xelay_security_monitor.state')
  const incidents = () => read('select * from xelay_security_monitor.incidents order by created_at,id')
  const clear = () => db.exec(`truncate xelay_security_monitor.incidents,xelay_security_monitor.delivery_attempts,xelay_security_monitor.windows cascade;
    update xelay_security_monitor.state set last_window_end=null,next_poll_at='-infinity',lease_token=null,lease_until=null,
      window_start=null,window_end=null,coverage='not_configured',consecutive_failures=0,logs_retry_at=null,last_error_code=null,telegram_retry_at=null,last_admin_role_window=null;`)
  const poll = async ({ observations = zeroObservations(), coverage = 'healthy', error = null, retry = null, end } = {}) => {
    await db.exec("update xelay_security_monitor.state set last_window_end=null,next_poll_at='-infinity',lease_until=null")
    const lease = await rpc('xelay_security_monitor_due')
    assert.ok(lease?.lease_token)
    // Synthetic clock positioning exercises real window/baseline SQL without
    // exposing a clock override or accepting caller-supplied production windows.
    if (end) await db.query("update xelay_security_monitor.state set window_end=$1,window_start=$1::timestamptz-interval '5 minutes'", [end])
    const result = await rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(observations), coverage, error, retry])
    return { result, lease }
  }
  const change = (kind, count, total, unknown_status = 0) => zeroObservations().map(row => row.kind === kind ? { kind, count, total, unknown_status } : row)
  const manualIncident = async kind => {
    await db.query(`select xelay_security_monitor.record_incident($1,100,100,clock_timestamp()-interval '5 minutes',clock_timestamp())`, [kind])
  }

  await t.test('only service RPCs execute; spoofed claims and direct table access fail', async () => {
    const signatures = [
      'xelay_security_monitor_due()', 'xelay_security_monitor_observe(uuid,jsonb,text,text,integer)',
      'xelay_claim_admin_security_alert()', 'xelay_admin_security_alert_delivery_context(uuid)',
      'xelay_finish_admin_security_alert(uuid,text,text,integer)',
    ]
    for (const name of signatures) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal((await one('select has_function_privilege($1,$2,\'execute\') allowed', [role, 'public.' + name])).allowed, role === 'service_role')
      }
    }
    const spoofed = { role: 'service_role', aal: 'aal2', sub: randomUUID(), user_metadata: { role: 'ADMIN', is_admin: true } }
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(asRole(role, () => db.query('select public.xelay_security_monitor_due()'), spoofed), /permission denied/)
      await assert.rejects(asRole(role, () => db.query('select * from xelay_security_monitor.state'), spoofed), /permission denied/)
    }
    await assert.rejects(asRole('service_role', () => db.query("update xelay_security_monitor.state set coverage='healthy'")), /permission denied/)
    // Defense in depth: even an accidental future EXECUTE grant cannot make
    // editable JWT claims pass the actual database role helper.
    await db.exec('grant execute on function public.xelay_security_monitor_due() to authenticated')
    await assert.rejects(asRole('authenticated', () => db.query('select public.xelay_security_monitor_due()'), spoofed), /SECURITY_MONITOR_SERVICE_REQUIRED/)
    await db.exec('revoke execute on function public.xelay_security_monitor_due() from authenticated')
    assert.equal((await one(`select bool_and(c.relrowsecurity) value from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='xelay_security_monitor' and c.relkind='r'`)).value, true)
    assert.equal((await one("select count(*)::int n from pg_policies where schemaname='xelay_security_monitor'")).n, 0)
    assert.equal((await one(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='xelay_security_monitor' and has_function_privilege('authenticated',p.oid,'execute')`)).n, 0)
  })

  await t.test('durable single due lease, delayed UTC window, idempotent acknowledgement and quiet zero traffic', async () => {
    const [first, second] = await asRole('service_role', () => Promise.all([
      db.query('select public.xelay_security_monitor_due() data'), db.query('select public.xelay_security_monitor_due() data'),
    ]))
    const lease = first.rows[0].data
    assert.ok(lease.lease_token); assert.equal(second.rows[0].data, null)
    assert.equal(Date.parse(lease.window_end) - Date.parse(lease.window_start), 300000)
    assert.equal(Date.parse(lease.window_end) % 300000, 0)
    assert.ok(Date.parse(lease.window_end) < Date.now() - 59000)
    const before = await state()
    await db.exec('create table public.synthetic_new_private_table(id uuid);alter table public.synthetic_new_private_table enable row level security')
    await db.exec(fx.setup)
    assert.deepEqual(await state(), before)
    assert.equal((await one("select count(*)::int n from xelay_security_monitor.protected_table where table_name='synthetic_new_private_table'")).n, 1)
    assert.equal(await rpc('xelay_security_monitor_observe', [randomUUID(), '[]', 'unavailable', 'logs_unavailable', null]), false)
    assert.equal(await rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(zeroObservations()), 'healthy', null, null]), true)
    assert.equal(await rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(zeroObservations()), 'healthy', null, null]), false)
    await db.exec("update xelay_security_monitor.state set next_poll_at='-infinity'")
    assert.equal(await rpc('xelay_security_monitor_due'), null)
    assert.equal((await one('select count(*)::int n from xelay_security_monitor.observations')).n, 5)
    assert.equal((await incidents()).length, 0)
    assert.equal(await rpc('xelay_claim_admin_security_alert'), null)
  })

  await t.test('malformed, duplicate, raw, missing and excessive observations roll back without consuming a lease', async () => {
    await clear()
    const lease = await rpc('xelay_security_monitor_due')
    const bad = [null, {}, [], [zeroObservations()[0]],
      zeroObservations().map((r, i) => i === 1 ? zeroObservations()[0] : r),
      zeroObservations().map((r, i) => i === 0 ? { ...r, email: 'never@example.test' } : r),
      change('auth_failures', -1, 2), change('auth_failures', 1.2, 2), change('auth_failures', 3, 2),
      change('auth_failures', 1000000001, 1000000001), change('auth_failures', 0, 0, true),
      zeroObservations().map((r, i) => i === 0 ? { ...r, kind: null } : r),
      zeroObservations().map((r, i) => i === 0 ? { ...r, source: 'database' } : r),
    ]
    for (const observations of bad) {
      await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(observations), 'healthy', null, null]), /SECURITY_MONITOR_INVALID/)
      assert.equal((await state()).lease_token, lease.lease_token)
    }
    await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, '[]', 'unavailable', 'private provider body', null]), /INVALID_ERROR_CODE/)
    await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, '[]', 'unavailable', 'logs_rate_limited', 86401]), /INVALID_OBSERVATIONS/)
    assert.equal((await one('select count(*)::int n from xelay_security_monitor.windows')).n, 0)
  })

  await t.test('missing logs and provider errors remain unavailable, back off, and produce one coverage alert after three failures', async () => {
    await clear()
    const first = await poll({ observations: [], coverage: 'not_configured' })
    assert.equal(first.result, true)
    assert.equal((await state()).coverage, 'not_configured')
    assert.equal((await state()).last_error_code, 'logs_not_configured')
    assert.equal((await incidents()).length, 0)
    await poll({ observations: [], coverage: 'unavailable', error: 'logs_rate_limited', retry: 7200 })
    assert.ok(Date.parse((await state()).logs_retry_at) > Date.now() + 7190000)
    assert.equal(await rpc('xelay_security_monitor_due'), null)
    // A long provider cooldown does not stop the independent DB invariant
    // checks. The next collector sees the persistent deadline and skips HTTP.
    await db.exec("update xelay_security_monitor.state set next_poll_at='-infinity',last_window_end=null;alter table public.profiles disable row level security")
    const duringBackoff = await rpc('xelay_security_monitor_due')
    assert.ok(Date.parse(duringBackoff.logs_retry_at) > Date.now() + 7190000)
    assert.equal((await incidents())[0].kind, 'rls_disabled')
    await db.exec("alter table public.profiles enable row level security;delete from xelay_security_monitor.incidents where kind='rls_disabled'")
    const thirdEnd = new Date(Date.parse(first.lease.window_end) - 300000).toISOString()
    await poll({ observations: [], coverage: 'unavailable', error: 'logs_payment_required', end: thirdEnd })
    assert.equal((await state()).coverage, 'unavailable')
    assert.equal((await incidents()).length, 1)
    assert.equal((await incidents())[0].kind, 'logs_unavailable')
    await poll({ observations: [], coverage: 'unavailable', error: 'logs_unauthorized', end: new Date(Date.parse(thirdEnd) - 300000).toISOString() })
    assert.equal((await incidents()).length, 1)
    assert.equal((await incidents())[0].occurrences, 2)
    await poll()
    assert.equal((await state()).coverage, 'healthy'); assert.equal((await state()).consecutive_failures, 0)
  })

  await t.test('counts and ratios both gate detection; unknown status stays distinct from zero; normal peaks stay quiet', async () => {
    await clear()
    await poll({ observations: change('auth_failures', 29, 29) })
    await poll({ observations: change('auth_failures', 30, 61) })
    await poll({ observations: change('auth_failures', 30, 61, 1), coverage: 'partial', error: 'logs_partial' })
    await poll({ observations: change('request_volume', 8000, 8000) })
    assert.equal((await incidents()).length, 0)
    await poll({ observations: change('auth_failures', 30, 60) })
    assert.equal((await incidents())[0].kind, 'auth_failures')
    await poll({ observations: change('api_errors', 15, 150) })
    await poll({ observations: change('access_denials', 50, 100) })
    await poll({ observations: change('storage_denials', 20, 50) })
    assert.deepEqual((await incidents()).map(i => i.kind).sort(), ['access_denials', 'api_errors', 'auth_failures', 'storage_denials'])
    assert.equal((await one("select unknown_status from xelay_security_monitor.observations where kind='auth_failures'")).unknown_status, 0)
    const unknownEnd = new Date(Math.floor((Date.now() - 900000) / 300000) * 300000).toISOString()
    await poll({ observations: change('auth_failures', 30, 60, 2), coverage: 'partial', error: 'logs_partial', end: unknownEnd })
    assert.equal((await one("select unknown_status from xelay_security_monitor.observations where kind='auth_failures' and window_end=$1", [unknownEnd])).unknown_status, 2)
    const definitions = await read("select pg_get_functiondef(p.oid) body from pg_proc p where p.pronamespace='xelay_security_monitor'::regnamespace")
    assert.doesNotMatch(JSON.stringify(definitions), /auth\.audit_log_entries|user_metadata|raw_user_meta_data/)
  })

  await t.test('partial coverage cannot claim healthy, preserves other signals, and warns after sustained missing statuses', async () => {
    await clear()
    const rows = change('auth_failures', 30, 60, 2).map(row => row.kind === 'api_errors' ? { ...row, count: 15, total: 150 } : row)
    const lease = await rpc('xelay_security_monitor_due')
    await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(rows), 'healthy', null, null]), /INVALID_COVERAGE/)
    await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(zeroObservations()), 'partial', 'logs_partial', null]), /INVALID_COVERAGE/)
    await assert.rejects(rpc('xelay_security_monitor_observe', [lease.lease_token, JSON.stringify(rows), 'partial', null, null]), /INVALID_OBSERVATIONS/)
    const end = Math.floor((Date.now() - 1800000) / 300000) * 300000
    for (let n = 0; n < 3; n++) {
      await poll({ observations: rows, coverage: 'partial', error: 'logs_partial', end: new Date(end + n * 300000).toISOString() })
      assert.equal((await state()).coverage, 'partial')
      assert.equal((await state()).consecutive_failures, n + 1)
      assert.equal((await state()).last_error_code, 'logs_partial')
    }
    assert.deepEqual((await incidents()).map(i => i.kind).sort(), ['api_errors', 'logs_unavailable'])
    assert.equal((await one("select count(*)::int n from xelay_security_monitor.windows where coverage='partial'")).n, 3)
    await poll({ observations: rows, coverage: 'partial', error: 'logs_partial', end: new Date(end + 3 * 300000).toISOString() })
    assert.equal((await incidents()).length, 2) // per-kind cooldown still applies
    assert.equal((await one("select occurrences from xelay_security_monitor.incidents where kind='logs_unavailable'")).occurrences, 2)
    await poll()
    assert.equal((await state()).coverage, 'healthy')
    assert.equal((await state()).consecutive_failures, 0)
  })

  await t.test('volume detection requires six contiguous complete previous windows and greater than five times baseline', async () => {
    await clear()
    const end = Math.floor((Date.now() - 3600000) / 300000) * 300000
    for (let n = 0; n < 6; n++) {
      // Unknown auth response status does not make the independently known API
      // request count unusable as a volume baseline.
      const observations = change('request_volume', 1000, 1000).map(row => n === 2 && row.kind === 'auth_failures' ? { ...row, total: 1, unknown_status: 1 } : row)
      await poll({ observations, coverage: n === 2 ? 'partial' : 'healthy', error: n === 2 ? 'logs_partial' : null, end: new Date(end + n * 300000).toISOString() })
    }
    assert.equal((await incidents()).length, 0)
    await poll({ observations: change('request_volume', 5000, 5000), end: new Date(end + 6 * 300000).toISOString() })
    assert.equal((await incidents()).length, 0) // exactly 5x is not a spike
    await poll({ observations: change('request_volume', 9000, 9000), end: new Date(end + 7 * 300000).toISOString() })
    assert.equal((await incidents()).length, 1)
    assert.equal((await incidents())[0].kind, 'request_volume')
    await clear()
    for (let n = 0; n < 5; n++) await poll({ observations: change('request_volume', 1000, 1000), end: new Date(end + n * 300000).toISOString() })
    await poll({ observations: [], coverage: 'unavailable', end: new Date(end + 5 * 300000).toISOString() })
    await poll({ observations: change('request_volume', 10000, 10000), end: new Date(end + 6 * 300000).toISOString() })
    assert.equal((await incidents()).length, 0)
  })

  await t.test('database invariants run with unavailable logs and role changes contain no identity', async () => {
    await clear()
    const id = randomUUID()
    await db.query("insert into public.user_roles values($1,'ADMIN')", [id])
    // Repeated role writes within the same window remain one anonymous fact.
    await db.query("insert into public.user_roles values($1,'ADMIN')", [randomUUID()])
    const roleFact = await one("select event_count,occurrences from xelay_security_monitor.incidents where kind='admin_role_changed'")
    assert.equal(roleFact.event_count, 1); assert.equal(roleFact.occurrences, 1)
    await db.query('delete from public.user_roles where user_id<>$1', [id])
    await db.exec('alter table public.profiles disable row level security')
    await poll({ observations: [], coverage: 'not_configured' })
    const current = await incidents()
    assert.deepEqual(current.map(i => i.kind).sort(), ['admin_mfa_missing', 'admin_role_changed', 'rls_disabled'])
    assert.equal(current.filter(i => i.severity === 'critical').length, 2)
    assert.doesNotMatch(JSON.stringify(current), new RegExp(id))
    await db.exec('alter table public.profiles enable row level security')
    await db.query("insert into auth.mfa_factors values($1,'verified')", [id])
    await clear()
    await poll({ observations: [], coverage: 'unavailable' })
    assert.equal((await incidents()).length, 0)
    await db.exec('drop table public.messages')
    await poll({ observations: [], coverage: 'unavailable' })
    assert.equal((await incidents())[0].kind, 'rls_disabled')
    await db.exec('create table public.messages(id uuid);alter table public.messages enable row level security')
    await clear()
    await db.exec('alter table public.teaching_grades disable row level security;drop table public.teaching_submissions')
    // Reinstallation must not erase a previously recorded invariant just
    // because its RLS was disabled or its relation disappeared.
    await db.exec(fx.setup)
    assert.equal((await one("select count(*)::int n from xelay_security_monitor.protected_table where table_name in('teaching_grades','teaching_submissions','study_group_members')")).n, 3)
    await poll({ observations: [], coverage: 'not_configured' })
    const teachingFailure = (await incidents())[0]
    assert.equal(teachingFailure.kind, 'rls_disabled')
    assert.equal(teachingFailure.event_count, 2)
    assert.equal(teachingFailure.severity, 'critical')
    await db.exec('alter table public.teaching_grades enable row level security;create table public.teaching_submissions(id uuid);alter table public.teaching_submissions enable row level security')
  })

  await t.test('delivery has one lease, durable provider backoff, cooldown, current tokens and bounded attempts', async () => {
    await clear()
    await manualIncident('api_errors'); await manualIncident('auth_failures')
    const results = await asRole('service_role', () => Promise.all([
      db.query('select public.xelay_claim_admin_security_alert() data'), db.query('select public.xelay_claim_admin_security_alert() data'),
    ]))
    const alert = results[0].rows[0].data
    assert.ok(alert?.lease_token); assert.equal(results[1].rows[0].data, null)
    assert.deepEqual(await rpc('xelay_admin_security_alert_delivery_context', [alert.lease_token]), alert)
    assert.equal(await rpc('xelay_admin_security_alert_delivery_context', [randomUUID()]), null)
    await assert.rejects(rpc('xelay_finish_admin_security_alert', [alert.lease_token, 'failed', 'raw provider response', 0]), /INVALID_DELIVERY/)
    assert.equal(await rpc('xelay_finish_admin_security_alert', [alert.lease_token, 'failed', 'telegram_rate_limited', 3600]), true)
    assert.equal(await rpc('xelay_finish_admin_security_alert', [alert.lease_token, 'sent', null, null]), false)
    assert.equal(await rpc('xelay_claim_admin_security_alert'), null) // global, not per incident
    const waiting = await one('select * from xelay_security_monitor.incidents where id=$1', [alert.alert_id])
    assert.equal(waiting.attempts, 1); assert.equal(waiting.status, 'pending')
    assert.ok(Date.parse(waiting.next_attempt_at) > Date.now() + 3590000)
    await db.query(`select xelay_security_monitor.record_incident($1,999,1000,clock_timestamp()-interval '4 minutes',clock_timestamp()+interval '1 minute')`, [alert.kind])
    assert.equal((await incidents()).length, 2) // cooldown coalesces
    const coalesced = await one('select * from xelay_security_monitor.incidents where id=$1', [alert.alert_id])
    assert.equal(coalesced.occurrences, waiting.occurrences + 1)
    for (const field of ['event_count', 'total_count', 'window_start', 'window_end']) assert.deepEqual(coalesced[field], waiting[field])
    await db.exec("update xelay_security_monitor.state set telegram_retry_at=null;update xelay_security_monitor.incidents set next_attempt_at='-infinity'")
    const retry = await rpc('xelay_claim_admin_security_alert')
    await db.query("update xelay_security_monitor.incidents set lease_until=clock_timestamp()-interval '1 second' where id=$1", [retry.alert_id])
    assert.equal(await rpc('xelay_admin_security_alert_delivery_context', [retry.lease_token]), null)
    assert.equal(await rpc('xelay_finish_admin_security_alert', [retry.lease_token, 'sent', null, null]), false)
    const reclaimed = await rpc('xelay_claim_admin_security_alert')
    assert.ok(reclaimed.lease_token !== retry.lease_token)
    assert.equal(await rpc('xelay_finish_admin_security_alert', [reclaimed.lease_token, 'sent', null, null]), true)
    assert.equal((await one('select status from xelay_security_monitor.incidents where id=$1', [reclaimed.alert_id])).status, 'sent')
    // After five failed/abandoned attempts a queue item becomes terminal.
    await db.exec("update xelay_security_monitor.incidents set attempts=4,next_attempt_at='-infinity' where status='pending'")
    const last = await rpc('xelay_claim_admin_security_alert')
    assert.ok(last)
    await rpc('xelay_finish_admin_security_alert', [last.lease_token, 'failed', 'telegram_timeout', null])
    assert.equal((await one('select status from xelay_security_monitor.incidents where id=$1', [last.alert_id])).status, 'failed')
  })

  await t.test('six attempts per hour cap applies across incidents and retention bounds private state', async () => {
    await clear()
    for (const kind of ['auth_failures', 'api_errors', 'access_denials', 'storage_denials', 'request_volume', 'logs_unavailable', 'admin_role_changed']) await manualIncident(kind)
    for (let n = 0; n < 6; n++) {
      const alert = await rpc('xelay_claim_admin_security_alert'); assert.ok(alert)
      assert.equal(await rpc('xelay_finish_admin_security_alert', [alert.lease_token, 'sent', null, null]), true)
    }
    assert.equal(await rpc('xelay_claim_admin_security_alert'), null)
    await db.exec("update xelay_security_monitor.delivery_attempts set created_at=clock_timestamp()-interval '2 hours'")
    assert.ok(await rpc('xelay_claim_admin_security_alert'))
    await db.exec(`update xelay_security_monitor.incidents set created_at=clock_timestamp()-interval '31 days';
      insert into xelay_security_monitor.windows(window_start,window_end,coverage) values(clock_timestamp()-interval '8 days 5 minutes',clock_timestamp()-interval '8 days','unavailable');`)
    await poll()
    assert.equal((await incidents()).length, 0)
    assert.equal((await one("select count(*)::int n from xelay_security_monitor.windows where window_end<clock_timestamp()-interval '7 days'")).n, 0)
    assert.equal((await one("select count(*)::int n from xelay_security_monitor.delivery_attempts where created_at<clock_timestamp()-interval '1 hour'")).n, 0)
  })
})
