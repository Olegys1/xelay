import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { stripTopLevelTransactions, buildStagingInstall, stagingRef } from './build-staging-install.mjs';
import { createFixture } from './fixture.mjs';

const migrations = (await readdir(new URL('../../supabase/migrations/', import.meta.url)))
  .filter(name => /^\d+_.+\.sql$/.test(name)).sort();

test('staging assembler removes only top-level transaction wrappers', () => {
  const body = `-- intro\nbegin;\ncreate function x() returns void language plpgsql as $body$begin perform 'commit;'; end;$body$;\nselect 'begin;', "commit;", E'escaped\\\'commit;'; /* nested /* begin; */ commit; */\ncommit;\n-- tail`;
  const result = stripTopLevelTransactions(body);
  assert.ok(!result.includes('-- intro\nbegin;'));
  assert.ok(result.includes("$body$begin perform 'commit;'; end;$body$;"));
  assert.ok(result.includes("select 'begin;', \"commit;\", E'escaped\\\'commit;';"));
  assert.ok(result.endsWith('\n-- tail'));
  assert.throws(() => stripTopLevelTransactions('rollback;'), /transaction control/);
  assert.throws(() => stripTopLevelTransactions("select 'unclosed"), /Unclosed/);
});

test('historical MFA operator bundle stays bounded to its installed 45-source manifest', async () => {
  const boundary = '202610030015_private_storage_error_compatibility.sql';
  const {manifest} = await buildStagingInstall({includeSupplement:true,migrationsThrough:boundary});
  assert.equal(manifest.length,45);
  assert.ok(manifest.at(-1).name.endsWith(boundary));
  assert.equal(manifest.some(item => item.name.endsWith('202610030016_group_trial.sql')),false);
  const current = await buildStagingInstall({includeSupplement:true});
  assert.ok(current.manifest.some(item => item.name.endsWith('202610030016_group_trial.sql')));
  await assert.rejects(() => buildStagingInstall({migrationsThrough:'unknown.sql'}),/Unknown staging migration boundary/);
});

test('complete staging bundle installs atomically with real legacy column contracts', async () => {
  const fixture = await createFixture({useStagingBaseline:true,setupOnly:true});
  try {
    const {sql,manifest} = await buildStagingInstall({includeSupplement:true});
    const expectedSources = migrations.length + 2;
    assert.equal(manifest.length,expectedSources);
    assert.deepEqual(manifest.slice(0,2).map(item => item.name),[
      'supabase/setup/security_staging_legacy_baseline.sql',
      'supabase/setup/security_staging_legacy_parity.sql',
    ]);
    assert.ok(manifest.some(item => item.name.endsWith('202610030010_question_comment_notifications.sql')));
    try { await fixture.db.exec(sql); }
    catch (error) { throw new Error(`Atomic staging bundle: ${error.message}`); }
    const result = await fixture.db.query(`select
      (select count(*)::integer from xelay_staging.installation) as sources,
      (select count(*)::integer from auth.users) as users,
      (select count(*)::integer from storage.objects) as objects,
      (select data_type from information_schema.columns where table_schema='public'
        and table_name='notifications' and column_name='question_id') as parent_type`);
    assert.deepEqual(result.rows[0],{sources:expectedSources,users:0,objects:0,parent_type:'uuid'});
    await assert.rejects(() => fixture.db.exec(sql));
    await fixture.db.exec('rollback');
    assert.equal((await fixture.db.query('select count(*)::integer as count from xelay_staging.installation')).rows[0].count,expectedSources);
  } finally { await fixture.close(); }
});

test('staging installer contains one atomic wrapper and a closed source manifest', async () => {
  const {sql,manifest} = await buildStagingInstall();
  assert.equal(stagingRef,'saufzpryybuawudohhwj');
  assert.equal((sql.match(/^begin;$/gm)||[]).length,1);
  assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
  assert.equal(manifest.length,migrations.length + 1);
  assert.deepEqual(manifest.slice(1).map(item => item.name),migrations.map(name => `supabase/migrations/${name}`));
  assert.equal(manifest[0].name,'supabase/setup/security_staging_legacy_baseline.sql');
  assert.ok(manifest.every(item => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(sql.includes('revoke all on schema xelay_staging from public,anon,authenticated;'));
  assert.ok(!sql.includes('WAYFORPAY_SECRET_KEY='));
  assert.ok(sql.includes('installed_sources'));
});
