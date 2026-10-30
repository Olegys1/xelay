// In-memory PostgreSQL only: no working users, cloud database or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const hidden = ['437c96ae-19d1-4bed-ae69-0b83ae9ec1b4','445fcadc-95e2-4f8c-bfb3-6d0998030a01']
const heads = ['04f587f8-1604-4f53-aabc-d1699c938b1d','b6d61792-89c5-48af-ad52-73806352ae61']
const real = 'd54d0a4e-eb72-4ac4-8f5f-cc0bcc3bcab4'
const ordinary = '00000000-0000-4000-8000-000000000010'
const other = '00000000-0000-4000-8000-000000000011'
const admin = '00000000-0000-4000-8000-000000000001'
const otherHead = '00000000-0000-4000-8000-000000000002'
const unit = '00000000-0000-4000-8000-000000000003'
const university = '00000000-0000-4000-8000-000000000004'
const migration = await readFile(new URL('../supabase/migrations/202610300002_hidden_test_study_groups.sql',import.meta.url),'utf8')

test('test-group directories: precise IDs, unchanged data and RLS, pagination and safe retries', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('aal',current_setting('request.jwt.claim.aal',true)) $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.profiles(id uuid primary key,full_name text,username text);
    create table public.universities(id uuid primary key,name text);
    create table public.academic_units(id uuid primary key,university_id uuid,name text);
    create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
    create table auth.mfa_factors(user_id uuid,status text);
    create table public.user_roles(user_id uuid,role text);
    create table public.study_groups(id uuid primary key,representative_request_id uuid,representative_id uuid,
      university_id uuid,academic_unit_id uuid,specialty text,group_name text,created_at timestamptz default now(),
      cohort_start_year int,study_level text,supplement_capacity int default 2);
    create table public.study_group_members(group_id uuid,user_id uuid,status text);
    create table public.synthetic_content(group_id uuid,kind text,payload text);
    alter table public.study_groups enable row level security;
    grant select on public.study_groups,public.study_group_members to authenticated,service_role;
    create policy own_groups on public.study_groups for select to authenticated
      using (representative_id=auth.uid() or exists(select 1 from public.study_group_members m where m.group_id=id and m.user_id=auth.uid() and m.status='accepted'));
    create function public.xelay_is_platform_admin() returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.user_roles where user_id=auth.uid() and role='ADMIN') $$;
    create function public.xelay_teaching_assert_user() returns uuid language plpgsql stable security definer set search_path='' as $$
      declare u uuid:=auth.uid();begin if u is null then raise exception 'AUTH_REQUIRED';end if;return u;end $$;
    create function public.xelay_teaching_workspace_before_group_requests_20261027() returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin perform public.xelay_teaching_assert_user();return jsonb_build_object('groups',(select coalesce(jsonb_agg(to_jsonb(g) order by g.id),'[]'::jsonb) from public.study_groups g),'sentinel','preserved');end $$;
    create function public.xelay_teaching_workspace_before_group_course_20261029() returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin return public.xelay_teaching_workspace_before_group_requests_20261027()||jsonb_build_object('requests',(select coalesce(jsonb_agg(g.id),'[]'::jsonb) from public.study_groups g));end $$;
    create function public.xelay_teaching_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin perform public.xelay_teaching_assert_user();return public.xelay_teaching_workspace_before_group_course_20261029();end $$;
    create function public.xelay_classroom_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin perform public.xelay_teaching_assert_user();return jsonb_build_object('classrooms',(select coalesce(jsonb_agg(g.id),'[]'::jsonb) from public.study_groups g));end $$;
    create function public.xelay_teaching_calendar(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin perform public.xelay_teaching_assert_user();if p_to<p_from then raise exception 'RANGE_INVALID';end if;return jsonb_build_object('lessons',(select coalesce(jsonb_agg(g.id),'[]'::jsonb) from public.study_groups g));end $$;
    create function public.xelay_android_widget_groups() returns jsonb language plpgsql stable security definer set search_path='' as $$
      begin perform public.xelay_teaching_assert_user();return jsonb_build_object('groups',(select coalesce(jsonb_agg(g.id),'[]'::jsonb) from public.study_groups g where representative_id=auth.uid()));end $$;
    create function public.xelay_teaching_course(p_group uuid) returns jsonb language sql stable security definer set search_path='' as $$ select to_jsonb(g) from public.study_groups g where id=p_group $$;
    create function public.xelay_teaching_material_library() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_agg(g.id) from public.study_groups g $$;
    create function public.xelay_teaching_group_context(p_group uuid) returns jsonb language sql stable security definer set search_path='' as $$ select to_jsonb(g) from public.study_groups g where id=p_group $$;
    create function public.xelay_teaching_mutate(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ begin return jsonb_build_object('retained',p_payload);end $$;
  `)
  const adminSource = await readFile(new URL('../supabase/migrations/202610160009_admin_study_group_members.sql',import.meta.url),'utf8')
  const adminDefinition = adminSource.match(/create or replace function public\.xelay_admin_study_groups\([\s\S]*?\nend \$\$;/)?.[0]
  assert.ok(adminDefinition)
  await db.exec(adminDefinition)
  await db.exec(`revoke all on function public.xelay_teaching_workspace_before_group_requests_20261027(),public.xelay_teaching_workspace_before_group_course_20261029() from public,anon,authenticated,service_role;
    revoke all on function public.xelay_teaching_workspace(),public.xelay_classroom_workspace(),public.xelay_teaching_calendar(date,date),public.xelay_android_widget_groups(),public.xelay_admin_study_groups(text,text,integer,integer) from public,anon,authenticated,service_role;
    grant execute on function public.xelay_teaching_workspace(),public.xelay_classroom_workspace(),public.xelay_teaching_calendar(date,date),public.xelay_android_widget_groups(),public.xelay_admin_study_groups(text,text,integer,integer) to authenticated;`)
  await db.query('insert into public.universities values($1,$2)',[university,'Synthetic University'])
  await db.query('insert into public.academic_units values($1,$2,$3)',[unit,university,'Synthetic faculty'])
  for(const [id,name] of [[heads[0],'Synthetic owner A'],[heads[1],'Synthetic owner B'],[admin,'Synthetic admin'],[otherHead,'Synthetic real head']]) {
    await db.query('insert into public.profiles values($1,$2,$3)',[id,name,id])
    await db.query('insert into auth.users(id) values($1)',[id])
  }
  await db.query("insert into auth.mfa_factors values($1,'verified')",[admin])
  await db.query("insert into public.user_roles values($1,'ADMIN')",[admin])
  for(const [id,name,owner] of [[hidden[0],'ооо 1',heads[0]],[hidden[1],'ЕУБ-4',heads[1]],[real,'ЕУБ - 4',otherHead],[ordinary,'ооо 1',heads[0]],[other,'Other group',otherHead]]) {
    await db.query("insert into public.study_groups(id,group_name,representative_id,university_id,academic_unit_id,specialty,cohort_start_year,study_level) values($1,$2,$3,$4,$5,'Synthetic program',2026,'bachelor')",[id,name,owner,university,unit])
    await db.query("insert into public.study_group_members values($1,$2,'accepted')",[id,owner])
    await db.query("insert into public.synthetic_content values($1,'grade','87'),($1,'material','retained-file-reference')",[id])
  }
  const functionMetadata = async () => (await db.query("select oid::regprocedure::text signature,proacl::text acl,proowner,prosecdef,provolatile,proconfig from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
  const untouched = async () => (await db.query("select proname,md5(prosrc) hash from pg_proc where pronamespace='public'::regnamespace and proname in('xelay_teaching_course','xelay_teaching_material_library','xelay_teaching_group_context','xelay_teaching_mutate') order by proname")).rows
  const preserved = async () => (await db.query("select (select jsonb_agg(to_jsonb(g) order by id) from public.study_groups g) groups,(select jsonb_agg(to_jsonb(m) order by group_id) from public.study_group_members m) members,(select jsonb_agg(to_jsonb(c) order by group_id,kind) from public.synthetic_content c) content")).rows[0]
  const metadataBefore=await functionMetadata(),untouchedBefore=await untouched(),dataBefore=await preserved()
  async function as(who,operation,role='authenticated',aal='aal2') {
    await db.exec(`set role ${role}`)
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.aal',$2,false)",[who||'',aal])
      return await operation()
    } finally { await db.exec('reset role') }
  }
  const rpc=(who,name,args=[])=>as(who,async()=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value)

  await t.test('wrong owner fails before changing views/functions/data',async()=>{
    await db.query('update public.study_groups set representative_id=$1 where id=$2',[otherHead,hidden[1]])
    await assert.rejects(db.exec(migration),/HIDDEN_TEST_GROUP_IDENTITY_CHANGED/)
    await db.exec('rollback')
    assert.equal((await db.query("select to_regclass('public.xelay_listed_study_groups') value")).rows[0].value,null)
    assert.deepEqual(await functionMetadata(),metadataBefore)
    await db.query('update public.study_groups set representative_id=$1 where id=$2',[heads[1],hidden[1]])
    assert.deepEqual(await preserved(),dataBefore)
  })
  await db.exec(migration)
  await t.test('workspace wrappers, classroom, calendar and widget lists hide only the two IDs',async()=>{
    const expected=[real,ordinary,other].sort()
    const workspace=await rpc(admin,'xelay_teaching_workspace')
    assert.equal(workspace.sentinel,'preserved')
    assert.deepEqual(workspace.groups.map(g=>g.id).sort(),expected)
    assert.deepEqual(workspace.requests.sort(),expected)
    assert.deepEqual((await rpc(admin,'xelay_classroom_workspace')).classrooms.sort(),expected)
    assert.deepEqual((await rpc(admin,'xelay_teaching_calendar',['2026-10-30','2026-10-31'])).lessons.sort(),expected)
    assert.deepEqual((await rpc(heads[0],'xelay_android_widget_groups')).groups,[ordinary])
  })
  await t.test('actual admin RPC filters before total, sorting, search and pagination',async()=>{
    const first=await rpc(admin,'xelay_admin_study_groups',['','name',1,0])
    const second=await rpc(admin,'xelay_admin_study_groups',['','name',1,1])
    assert.equal(first.total,3);assert.equal(first.items.length,1)
    assert.equal(second.total,3);assert.equal(second.items.length,1)
    assert.notEqual(first.items[0].id,second.items[0].id)
    for(const page of [first,second]) assert.ok(!hidden.includes(page.items[0].id))
    const matching=await rpc(admin,'xelay_admin_study_groups',['еуб','name',20,0])
    assert.equal(matching.total,1);assert.equal(matching.items[0].id,real)
    const sameName=await rpc(admin,'xelay_admin_study_groups',['ооо','name',20,0])
    assert.equal(sameName.total,1);assert.equal(sameName.items[0].id,ordinary)
  })
  await t.test('security-invoker view cannot bypass underlying membership RLS or write rows',async()=>{
    const rows=await as(heads[0],()=>db.query('select id from public.xelay_listed_study_groups order by id'))
    assert.deepEqual(rows.rows.map(g=>g.id),[ordinary])
    const otherRows=await as(otherHead,()=>db.query('select id from public.xelay_listed_study_groups order by id'))
    assert.deepEqual(otherRows.rows.map(g=>g.id).sort(),[real,other].sort())
    const serviceRows=await as(null,()=>db.query('select id from public.xelay_listed_study_groups order by id'),'service_role')
    assert.deepEqual(serviceRows.rows.map(g=>g.id).sort(),[real,ordinary,other].sort())
    await assert.rejects(as(null,()=>db.query('select * from public.xelay_listed_study_groups'),'anon'),/permission denied/)
    const view=(await db.query("select reloptions from pg_class where oid='public.xelay_listed_study_groups'::regclass")).rows[0]
    assert.ok(view.reloptions.includes('security_invoker=true'))
    const permissions=(await db.query("select has_table_privilege('authenticated','public.xelay_listed_study_groups','INSERT') can_insert,has_table_privilege('authenticated','public.xelay_listed_study_groups','UPDATE') can_update,has_table_privilege('authenticated','public.xelay_listed_study_groups','DELETE') can_delete")).rows[0]
    assert.deepEqual(permissions,{can_insert:false,can_update:false,can_delete:false})
  })
  await t.test('direct detail/audience APIs, all data and function permissions remain unchanged',async()=>{
    assert.deepEqual(await functionMetadata(),metadataBefore)
    assert.deepEqual(await untouched(),untouchedBefore)
    assert.deepEqual(await preserved(),dataBefore)
    const raw=await as(heads[0],()=>db.query('select id from public.study_groups where id=$1',[hidden[0]]))
    assert.equal(raw.rows[0].id,hidden[0])
    assert.equal((await rpc(heads[0],'xelay_teaching_group_context',[hidden[0]])).id,hidden[0])
    assert.equal((await rpc(heads[0],'xelay_teaching_course',[hidden[0]])).id,hidden[0])
    assert.deepEqual((await rpc(heads[0],'xelay_teaching_material_library')).sort(),[...hidden,real,ordinary,other].sort())
    await assert.rejects(rpc(heads[0],'xelay_admin_study_groups',['','name',20,0]),/ADMIN_MFA_REQUIRED/)
    await assert.rejects(as(null,()=>db.query('select public.xelay_teaching_workspace()'),'anon'),/permission denied/)
    await assert.rejects(rpc(null,'xelay_teaching_workspace'),/AUTH_REQUIRED/)
    await assert.rejects(rpc(admin,'xelay_teaching_calendar',['2026-11-01','2026-10-30']),/RANGE_INVALID/)
  })
  await t.test('reapplying the migration is idempotent and preserves direct-audience roundtrips',async()=>{
    const functionsBefore=(await db.query("select oid,md5(prosrc) hash from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
    await db.exec(migration)
    assert.deepEqual((await db.query("select oid,md5(prosrc) hash from pg_proc where pronamespace='public'::regnamespace order by oid")).rows,functionsBefore)
    assert.deepEqual(await preserved(),dataBefore)
    assert.deepEqual(await untouched(),untouchedBefore)
  })
  await t.test('an unexpected non-stable core function makes the entire replay fail closed',async()=>{
    const before=(await db.query("select md5(prosrc) hash from pg_proc where oid='public.xelay_teaching_calendar(date,date)'::regprocedure")).rows[0].hash
    await db.exec('alter function public.xelay_teaching_calendar(date,date) volatile')
    await assert.rejects(db.exec(migration),/HIDDEN_TEST_GROUP_READ_PREREQUISITE/)
    await db.exec('rollback')
    assert.equal((await db.query("select md5(prosrc) hash from pg_proc where oid='public.xelay_teaching_calendar(date,date)'::regprocedure")).rows[0].hash,before)
    assert.deepEqual(await preserved(),dataBefore)
    await db.exec('alter function public.xelay_teaching_calendar(date,date) stable')
  })
})
