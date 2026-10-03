import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const stagingRef = 'saufzpryybuawudohhwj';

// Split only real SQL statements. Semicolons inside functions, quoted strings,
// nested comments and identifiers never become transaction boundaries.
export function stripTopLevelTransactions(sql) {
  let start = 0, index = 0, normalized = '', state = 'plain', tag = '', depth = 0;
  const output = [];
  function finish(end) {
    const command = normalized.trim().replace(/\s+/g, ' ').toUpperCase();
    if (!['BEGIN', 'BEGIN TRANSACTION', 'START TRANSACTION', 'COMMIT', 'COMMIT TRANSACTION'].includes(command)) {
      if (/^(ROLLBACK|END(?: TRANSACTION)?|SAVEPOINT|RELEASE)\b/.test(command)) throw new Error('Unsupported transaction control in staging source');
      output.push(sql.slice(start, end));
    }
    start = end;
    normalized = '';
  }
  while (index < sql.length) {
    const c = sql[index], next = sql[index + 1];
    if (state === 'line') {
      if (c === '\n') { state = 'plain'; normalized += ' '; }
      index++; continue;
    }
    if (state === 'comment') {
      if (c === '/' && next === '*') { depth++; index += 2; }
      else if (c === '*' && next === '/') { if (--depth === 0) state = 'plain'; index += 2; }
      else index++;
      continue;
    }
    if (state === 'dollar') {
      if (sql.startsWith(tag, index)) { index += tag.length; state = 'plain'; }
      else index++;
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (c === quote && next === quote) index += 2;
      else if (c === quote) { state = 'plain'; index++; }
      else if (c === '\\' && state === 'single' && tag === 'escape') index += 2;
      else index++;
      continue;
    }
    if (c === '-' && next === '-') { state = 'line'; normalized += ' '; index += 2; continue; }
    if (c === '/' && next === '*') { state = 'comment'; depth = 1; normalized += ' '; index += 2; continue; }
    if (c === "'" || c === '"') {
      state = c === "'" ? 'single' : 'double';
      tag = c === "'" && /(?:^|\W)[eE]$/.test(sql.slice(Math.max(start,index-2),index)) ? 'escape' : '';
      normalized += ' quoted '; index++; continue;
    }
    if (c === '$') {
      const match = /^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/.exec(sql.slice(index));
      if (match) { tag = match[0]; state = 'dollar'; normalized += ' function_body '; index += tag.length; continue; }
    }
    if (c === ';') { finish(index + 1); index++; continue; }
    normalized += c;
    index++;
  }
  if (state !== 'plain' && state !== 'line') throw new Error('Unclosed SQL string or comment');
  if (start < sql.length) output.push(sql.slice(start));
  return output.join('');
}

export async function buildStagingInstall({ includeSupplement = false, migrationsThrough = null } = {}) {
  const sources = ['supabase/setup/security_staging_legacy_baseline.sql'];
  if (includeSupplement) sources.push('supabase/setup/security_staging_legacy_parity.sql');
  const migrationNames = (await readdir(resolve(repository,'supabase/migrations'))).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  // Historical hosted evidence uses an exact source boundary. Default bundles
  // still include the entire current chain; an unknown boundary is refused.
  if (migrationsThrough !== null && !migrationNames.includes(migrationsThrough)) throw new Error('Unknown staging migration boundary');
  sources.push(...migrationNames.filter(name => migrationsThrough === null || name <= migrationsThrough).map(name => `supabase/migrations/${name}`));
  const manifest = [];
  const parts = [
    `-- STAGING ONLY: install into empty test1 (${stagingRef}), never production.`,
    '-- Schema and catalog seeds only. No production users, files, webhook secrets or live payment credentials.',
    '-- One outer transaction: an error rolls the whole installation back.',
    'begin;',
    "set local xelay.security_staging='true';",
  ];
  for (const name of sources) {
    const sql = await readFile(resolve(repository,name),'utf8');
    manifest.push({name, sha256:createHash('sha256').update(sql).digest('hex')});
    parts.push(`\n-- Source: ${name}\n`);
    if (name.startsWith('supabase/setup/')) parts.push("set local xelay.security_staging='true';");
    parts.push(stripTopLevelTransactions(sql));
  }
  parts.push(
    '\ncreate schema xelay_staging;',
    'revoke all on schema xelay_staging from public,anon,authenticated;',
    'create table xelay_staging.installation (source_file text primary key,sha256 text not null,installed_at timestamptz not null default now());',
    'alter table xelay_staging.installation enable row level security;',
    'revoke all on xelay_staging.installation from public,anon,authenticated;',
    ...manifest.map(item => `insert into xelay_staging.installation(source_file,sha256) values ('${item.name}','${item.sha256}');`),
    "notify pgrst,'reload schema';",
    "set local xelay.security_staging='false';",
    'commit;',
    `select '${stagingRef}' as intended_test_project,count(*) as installed_sources from xelay_staging.installation;`,
  );
  return {sql:parts.join('\n'),manifest};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--complete'].includes(arg))) throw new Error('Usage: node scripts/security/build-staging-install.mjs [--complete]');
    const result = await buildStagingInstall({includeSupplement:args.includes('--complete')});
    const outputDir = resolve(repository,'.security-audit.local');
    if (!outputDir.startsWith(repository + sep)) throw new Error('Output directory outside repository');
    await mkdir(outputDir,{recursive:true});
    await writeFile(resolve(outputDir,'staging-install.sql'),result.sql);
    await writeFile(resolve(outputDir,'staging-install-manifest.json'),JSON.stringify({project:stagingRef,sources:result.manifest},null,2));
    console.log(JSON.stringify({project:stagingRef,sources:result.manifest.length,bytes:Buffer.byteLength(result.sql),completeLegacySupplement:args.includes('--complete'),applied:false}));
  } catch {
    console.error('Staging installer preparation failed. No cloud operation was performed.');
    process.exitCode = 1;
  }
}
