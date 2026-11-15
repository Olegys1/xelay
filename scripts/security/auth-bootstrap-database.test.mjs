import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../../supabase/migrations/202611140100_account_bootstrap.sql', import.meta.url), 'utf8')
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
const group = '33333333-3333-4333-8333-333333333333'

test('aggregate SQL preserves invoker ACL, limits all rows to actor and isolates section denials', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role anon;create role authenticated;create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create table public.profiles(id uuid primary key,full_name text,private_contact text);
      create table public.user_roles(id uuid primary key,user_id uuid,role text,university_id uuid,academic_unit_id uuid);
      create table public.class_representative_requests(id uuid primary key,user_id uuid,status text,created_at timestamptz);
      create table public.study_group_members(id uuid primary key,user_id uuid,group_id uuid,status text);
      insert into public.profiles values('${a}','Synthetic A','OWN_ONLY'),('${b}','Synthetic B','MUST_NOT_LEAK');
      insert into public.user_roles values('${a}','${a}','FACULTY_EDITOR',null,null),('${b}','${b}','ADMIN',null,null);
      insert into public.class_representative_requests values('${a}','${a}','approved',now()),('${b}','${b}','approved',now());
      insert into public.study_group_members values('${a}','${a}','${group}','accepted'),('${b}','${b}','${group}','accepted');
      alter table public.profiles enable row level security;
      alter table public.user_roles enable row level security;
      alter table public.class_representative_requests enable row level security;
      alter table public.study_group_members enable row level security;
      create policy readable_profile on public.profiles for select to authenticated using(true);
      create policy own_roles on public.user_roles for select to authenticated using(user_id=auth.uid());
      create policy own_requests on public.class_representative_requests for select to authenticated using(user_id=auth.uid());
      create policy own_members on public.study_group_members for select to authenticated using(user_id=auth.uid());
      grant select on all tables in schema public to authenticated;
      create function public.xelay_teacher_status() returns jsonb language sql stable as
        $$select jsonb_build_object('verified',false,'status','none','request',null,'requests',jsonb_build_array('MUST_NOT_LEAK'))$$;
      create function public.xelay_my_study_group_representative_status() returns jsonb language sql stable as
        $$select jsonb_build_object('is_representative',true,'owned_group_ids',jsonb_build_array('${group}'),'available_request_ids','[]'::jsonb,'can_create_group',false)$$;
    `)
    await db.exec(migration)
    // Reapplying does not add grants, rows, policies or duplicate functions.
    await db.exec(migration)
    const metadata = (await db.query(`select prosecdef,provolatile,proconfig,
      has_function_privilege('anon','public.xelay_my_account_bootstrap()','execute') anon,
      has_function_privilege('authenticated','public.xelay_my_account_bootstrap()','execute') authenticated,
      has_function_privilege('service_role','public.xelay_my_account_bootstrap()','execute') service
      from pg_proc where oid='public.xelay_my_account_bootstrap()'::regprocedure`)).rows[0]
    assert.equal(metadata.prosecdef, false);assert.equal(metadata.provolatile, 's')
    assert.equal(metadata.anon, false);assert.equal(metadata.authenticated, true);assert.equal(metadata.service, false)
    await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${a}',false)`)
    const data = (await db.query('select public.xelay_my_account_bootstrap() value')).rows[0].value
    assert.equal(data.profile.data.id, a);assert.equal(data.roles.data.length, 1);assert.equal(data.roles.data[0].role, 'FACULTY_EDITOR')
    assert.equal(data.representative_requests.data[0].id, a);assert.equal(data.memberships.data.length, 1)
    assert.equal(data.teacher.data.requests, undefined);assert.equal(JSON.stringify(data).includes('MUST_NOT_LEAK'), false)
    await db.exec(`reset role;revoke select on public.user_roles from authenticated;set role authenticated`)
    const partial = (await db.query('select public.xelay_my_account_bootstrap() value')).rows[0].value
    assert.equal(partial.profile.data.id, a);assert.equal(partial.roles.data, null);assert.equal(partial.roles.error.code, '42501');assert.equal(partial.roles.status, 403)
    assert.equal(partial.memberships.data.length, 1)
    await db.exec(`reset role;revoke select on public.profiles from authenticated;set role authenticated`)
    await assert.rejects(db.query('select public.xelay_my_account_bootstrap()'), { code: '42501' })
    await db.exec(`reset role;set role anon`)
    await assert.rejects(db.query('select public.xelay_my_account_bootstrap()'), { code: '42501' })
    await db.exec(`reset role;set role authenticated;select set_config('request.jwt.claim.sub','',false)`)
    await assert.rejects(db.query('select public.xelay_my_account_bootstrap()'), /ACCOUNT_AUTH_REQUIRED/)
  } finally { await db.close() }
})
