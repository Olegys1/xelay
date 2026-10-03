// Isolated PostgreSQL fixture. Synthetic accounts only; never connects to Supabase.
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
const root = fileURLToPath(new URL('../../', import.meta.url))
const quote = (value) => '"' + value.replaceAll('"', '""') + '"'

export async function createFixture({ through = '999999999999', migrations, useStagingBaseline = false,
  useStagingParity = false, setupOnly = false } = {}) {
  if (useStagingParity) useStagingBaseline = true
  if (setupOnly && !useStagingBaseline) throw new Error('setupOnly requires useStagingBaseline so no default public table grants are created')
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key, email text unique, email_confirmed_at timestamptz,
      created_at timestamptz default now(), updated_at timestamptz default now(), deleted_at timestamptz, raw_user_meta_data jsonb default '{}');
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(), user_id uuid references auth.users,
      status text, factor_type text default 'totp');
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(auth.jwt()->>'sub',current_setting('request.jwt.claim.sub',true)),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$
      select coalesce(auth.jwt()->>'role',nullif(current_setting('request.jwt.claim.role',true),'')) $$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    ${useStagingBaseline ? '' : `alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant usage,select on sequences to anon,authenticated,service_role;`}
    create table storage.buckets(id text primary key,name text not null,public boolean default false,
      file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,
      name text not null,owner uuid,owner_id text,metadata jsonb default '{}',created_at timestamptz default now(),
      updated_at timestamptz default now(),unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant all on storage.objects,storage.buckets to anon,authenticated,service_role;
    create function storage.foldername(text) returns text[] language sql immutable as $$
      select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
    create function storage.filename(text) returns text language sql immutable as $$
      select (string_to_array($1,'/'))[array_length(string_to_array($1,'/'),1)] $$;
    create function storage.extension(text) returns text language sql immutable as $$
      select reverse(split_part(reverse(storage.filename($1)),'.',1)) $$;
    grant execute on all functions in schema storage to anon,authenticated,service_role;
    insert into storage.buckets(id,name,public) values('avatars','avatars',true),('answer-media','answer-media',true);
  `)
  if (setupOnly) {
    // Managed-platform approximation only: installer tests submit their own
    // baseline/parity/migration bundle and must exercise its transaction guard.
  } else if (useStagingBaseline) {
    await db.exec("set xelay.security_staging='true'")
    try { await db.exec(await readFile(resolve(root, 'supabase/setup/security_staging_legacy_baseline.sql'), 'utf8')) }
    catch (error) { await db.close(); throw new Error(`Fixture staging baseline: ${error.message}`, { cause: error }) }
    if (useStagingParity) {
      await db.exec("set xelay.security_staging='true'")
      try { await db.exec(await readFile(resolve(root, 'supabase/setup/security_staging_legacy_parity.sql'), 'utf8')) }
      catch (error) { await db.close(); throw new Error(`Fixture staging parity: ${error.message}`, { cause: error }) }
    }
  } else {
    const baseline = JSON.parse((await readFile(resolve(root, 'scripts/security/legacy-fixture.json'), 'utf8')).replace(/^\uFEFF/,''))
    for (const table of baseline.columns) {
      if (table.table === 'messages') continue // Created by repository migrations.
      const fields = table.columns.map((c) => `${quote(c.name)} ${c.type === 'ARRAY' ? 'text[]' : c.type}${c.default ? ` default ${c.default}` : ''}${c.name === 'id' ? ' primary key' : ''}`)
      await db.exec(`create table public.${quote(table.table)} (${fields.join(',')}); alter table public.${quote(table.table)} enable row level security;`)
    }
    await db.exec(`create table public.notifications(id uuid primary key default gen_random_uuid(),
      recipient_id uuid,actor_id uuid,actor_name text,type text,message text,is_read boolean default false,
      question_id text,answer_id text,created_at timestamptz default now());`)
    await db.exec(`create policy fixture_profiles_select on profiles for select to authenticated using(id=auth.uid());
      create policy fixture_profiles_insert on profiles for insert to authenticated with check(id=auth.uid());
      create policy fixture_profiles_update on profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());`)
    for (const policy of baseline.policies) {
      const roles = policy.roles.replace(/[{}]/g,'').split(',').map((r) => r === 'public' ? 'public' : quote(r)).join(',')
      await db.exec(`create policy ${quote(policy.policyname)} on ${quote(policy.schemaname)}.${quote(policy.tablename)} for ${policy.cmd.toLowerCase()} to ${roles}
        ${policy.qual ? `using (${policy.qual})` : ''} ${policy.with_check ? `with check (${policy.with_check})` : ''};`)
    }
    for (const definition of baseline.functions) await db.exec(definition)
  }
  const names = (setupOnly ? [] : migrations || await readdir(resolve(root, 'supabase/migrations'))).filter((n) => n.endsWith('.sql') && n.slice(0,12) <= through).sort()
  for (const name of names) {
    try { await db.exec(await readFile(resolve(root, 'supabase/migrations', name), 'utf8')) }
    catch (error) { await db.close(); throw new Error(`Fixture migration ${name}: ${error.message}`, { cause: error }) }
  }
  const asUser = async (userId, sql, params = [], { role = 'authenticated', aal = 'aal1' } = {}) => {
    await db.exec(`set role ${quote(role)}`)
    await db.query(`select set_config('request.jwt.claims',$1,false)`, [JSON.stringify({ sub: userId, role, aal, iss: 'https://staging.supabase.co/auth/v1' })])
    try { return await db.query(sql, params) }
    finally { await db.exec('reset role'); await db.exec(`reset "request.jwt.claims"`) }
  }
  const seedUser = async (id, { email = `${id}@example.test`, username = `user_${id.slice(-8)}`, ...profile } = {}) => {
    // Synthetic legacy users bypass only registration metadata validation, not security guards.
    await db.exec('alter table auth.users disable trigger user')
    try { await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [id,email]) }
    finally { await db.exec('alter table auth.users enable trigger user') }
    const values = { id, email, full_name: username, username, ...profile }
    const cols = Object.keys(values)
    await db.query(`insert into profiles(${cols.map(quote).join(',')}) values(${cols.map((_,i)=>`$${i+1}`).join(',')})`, Object.values(values))
  }
  return { db, asUser, seedUser, close: () => db.close() }
}
