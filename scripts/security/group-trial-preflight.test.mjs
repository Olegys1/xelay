// Local metadata-only checks. Never connects to a hosted database.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const source = await readFile(new URL('../../supabase/migrations/202610030016_group_trial.sql', import.meta.url), 'utf8')
const preflight = await readFile(new URL('../../supabase/setup/group_trial_preflight.sql', import.meta.url), 'utf8')
const initialGuard = (sql) => sql.match(/do \$\$[\s\S]*?\$\$;/)?.[0].replaceAll('\r\n', '\n')

test('trial preflight uses the exact migration prerequisite guard within a read-only rollback', () => {
  assert.ok(initialGuard(source))
  assert.equal(initialGuard(preflight), initialGuard(source))
  assert.match(preflight, /begin;\s*set transaction read only;\s*do \$\$/)
  assert.match(preflight, /select 'GROUP_TRIAL_PREREQUISITES_OK'[\s\S]*rollback;\s*$/)
  assert.doesNotMatch(preflight, /\b(create|alter|drop|insert|update|delete|grant|revoke|truncate)\s+(table|function|trigger|policy|into|on|from)\b/i)
})

test('read-only preflight passes on functional 003 and installs no trial objects', async (t) => {
  const fixture = await createFixture({ through: '202610030003' })
  t.after(() => fixture.close())
  assert.equal((await fixture.db.query("select to_regclass('public.group_trial_entitlements') is null as absent")).rows[0].absent, true)
  const results = await fixture.db.exec(preflight)
  assert.ok(results.some((result) => result.rows.some((row) => row.status === 'GROUP_TRIAL_PREREQUISITES_OK' && row.trial_table_exists === false)))
  assert.equal((await fixture.db.query("select to_regclass('public.group_trial_entitlements') is null as absent")).rows[0].absent, true)
})
