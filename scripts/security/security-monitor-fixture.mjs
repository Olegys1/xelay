// Small offline PostgreSQL fixture; no full application migrations, provider,
// credentials, environment file, or live database connection.
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const root = new URL('../../', import.meta.url)
const setup = await readFile(new URL('supabase/setup/security_monitor_20261028.sql', root), 'utf8')
const securityMigration = await readFile(new URL('supabase/migrations/202610030006_profile_news_security.sql', root), 'utf8')
const trustedHelper = securityMigration.match(/create or replace function public\.xelay_security_is_trusted_backend\(\)[\s\S]*?\$\$;/)?.[0]
if (!trustedHelper) throw new Error('Existing trusted-backend helper not found')

export async function createSecurityMonitorFixture() {
  const db = new PGlite()
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.mfa_factors(user_id uuid,status text);
    create table public.user_roles(user_id uuid,role text);
    create table public.profiles(id uuid);create table public.messages(id uuid);
    create table public.notifications(id uuid);create table public.teacher_verification_requests(id uuid);
    create table public.class_representative_requests(id uuid);create table storage.objects(id uuid);
    create table public.teaching_grades(id uuid);create table public.teaching_submissions(id uuid);
    create table public.study_group_members(id uuid);
    alter table public.user_roles enable row level security;alter table public.profiles enable row level security;
    alter table public.messages enable row level security;alter table public.notifications enable row level security;
    alter table public.teacher_verification_requests enable row level security;
    alter table public.class_representative_requests enable row level security;alter table storage.objects enable row level security;
    alter table public.teaching_grades enable row level security;alter table public.teaching_submissions enable row level security;
    alter table public.study_group_members enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    ${trustedHelper}
    revoke all on function public.xelay_security_is_trusted_backend() from public,anon,authenticated,service_role;
  `)
  await db.exec(setup)
  const asRole = async (role, callback, claims = { role, sub: null, aal: 'aal1' }) => {
    if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Invalid fixture role')
    await db.exec(`set role ${role}`)
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)])
    try { return await callback() } finally { await db.exec('reset role;reset "request.jwt.claims"') }
  }
  const rpc = (name, params = []) => asRole('service_role', async () =>
    (await db.query(`select public.${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) data`, params)).rows[0].data)
  const read = async (sql, params = []) => (await db.query(sql, params)).rows
  const one = async (sql, params = []) => (await read(sql, params))[0]
  return { db, rpc, one, read, asRole, setup, close: () => db.close() }
}

export const zeroObservations = () => ['auth_failures', 'api_errors', 'access_denials', 'storage_denials', 'request_volume']
  .map(kind => ({ kind, count: 0, total: 0, unknown_status: 0 }))
