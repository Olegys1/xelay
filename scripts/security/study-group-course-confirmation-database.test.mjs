// Real PostgreSQL, synthetic rows only. No environment secrets or live database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const source = Object.fromEntries(await Promise.all(['202610150007_study_group_cohort_identity.sql',
  '202610260002_study_group_legacy_collision_recovery.sql', '202610290003_study_group_representative_transfer.sql',
  '202610270020_teaching_semesters_group_requests.sql', '202610290004_study_group_course_confirmation.sql',
  '202610290007_study_group_identity_review.sql'].map(async name => [name, await read(name)])))
function routine(text, name) {
  const start = text.search(new RegExp('create (?:or replace )?function public\\.' + name + '\\('))
  assert.ok(start >= 0, name + ' comes from production migration')
  const body = text.slice(start), tag = body.match(/as (\$[a-z_]*\$)/i)?.[1]
  assert.ok(tag); const first = body.indexOf(tag), last = body.indexOf(tag, first + tag.length)
  return body.slice(0, last + tag.length + 1)
}
const uuid = n => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = Object.fromEntries(['owner', 'next', 'member', 'foreign', 'teacher', 'admin', 'unconfirmed', 'banned', 'otherOwner', 'applicant'].map((x, i) => [x, uuid(i + 1)]))
const uni = uuid(100), fac = uuid(101), known = uuid(200), unknown = uuid(201), archive = uuid(202), collision = uuid(203), rollback = uuid(204), transferUnknown = uuid(205), adminGroup = uuid(206)
const req = n => uuid(300 + n), command = n => uuid(500 + n), course = uuid(900)

test('actual PostgreSQL: explicit group course, safe creation, teacher readiness and private review', { timeout: 70000 }, async t => {
  const minimum = 1400, freeBefore = Math.floor(freemem() / 1048576)
  if (freeBefore < minimum) { t.skip('Require1400MiB OSfree; available' + freeBefore); return }
  let peak = 0
  const guard = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss / 1048576)
    if (peak > 650) process.exit(77)
    if (freemem() / 1048576 < 500) process.exit(79)
  }, 50)
  guard.unref(); const timeout = setTimeout(() => process.exit(78), 70000); timeout.unref()
  const db = new PGlite({ postgresqlconf: ['shared_buffers=4MB', 'work_mem=1MB', 'maintenance_work_mem=4MB'] })
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows
  const one = async (sql, args = []) => (await rows(sql, args))[0]
  const as = async (who, sql, args = [], role = 'authenticated', aal = 'aal1') => db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who, role, aal })])
    await tx.exec('set local role ' + role)
    return (await tx.query(sql, args)).rows
  })
  const call = async (who, fn, args = [], aal = 'aal1', role = 'authenticated') => (await as(who, `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) value`, args, role, aal))[0].value
  const denied = (promise, message) => assert.rejects(promise, error => { if (message) assert.match(error.message, new RegExp(message)); return true })
  const status = (g, who = user.owner) => call(who, 'xelay_study_group_course_status', [g])
  const confirm = (g, n = 1, key = command(1), who = user.owner, level = 'bachelor', year = 2026) => call(who, 'xelay_confirm_study_group_course', [g, n, level, year, key])
  const create = (r, who, key = command(80), n = 1, level = 'bachelor', year = 2026) => call(who, 'xelay_create_study_group_with_course', [r, n, level, year, key])
  const review = (r, g, key, who = user.applicant, n = 1, level = 'bachelor', note = 'Please verify the academic identity') => call(who, 'xelay_request_study_group_identity_review', [r, g, n, level, 2026, note, key])
  const resolve = (id, action, g = null, n = null, level = null, year = null, actor = user.admin) => call(actor, 'xelay_admin_resolve_study_group_identity_review', [id, action, 'Explicit operator-reviewed academic evidence', g, n, level, year], 'aal2')
  const dump = async table => (await one(`select coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb) value from public.${table} t`)).value
  const seedRequest = (r, owner, name, cohort = null, level = null) => db.query(`insert into class_representative_requests(id,user_id,status,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level,phone)
    values($1,$2,'approved',$3,$4,'Synthetic OP',$5,$6,$7,'fixture-private-contact')`, [r, owner, uni, fac, name, cohort, level])
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema fixture;grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid$$;
      create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create table fixture.clock(year integer);insert into fixture.clock values(2026);
      create function public.xelay_current_academic_year()returns integer language sql stable security definer as $$select year from fixture.clock$$;
      create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),deleted_at timestamptz,banned_until timestamptz);
      create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid,status text);
      create table profiles(id uuid primary key references auth.users(id),full_name text,username text,university_id uuid,academic_unit_id uuid,
        specialty text,experience text,study_year integer,study_year_academic_year integer,study_year_needs_review boolean default false);
      create table user_roles(user_id uuid,role text);
      create table universities(id uuid primary key,name text,slug text);
      create table academic_units(id uuid primary key,university_id uuid,name text,slug text);
      create table class_representative_requests(id uuid primary key,user_id uuid references profiles(id),status text,university_id uuid,academic_unit_id uuid,
        specialty text,group_name text,cohort_start_year integer,study_level text,phone text);
      create table study_groups(id uuid primary key default gen_random_uuid(),representative_request_id uuid unique not null references class_representative_requests(id),
        representative_id uuid not null references profiles(id),university_id uuid,academic_unit_id uuid,specialty text,group_name text,
        cohort_start_year integer,study_level text,created_at timestamptz default now());
      create unique index study_groups_academic_cohort_unique_idx on study_groups(university_id,academic_unit_id,lower(btrim(specialty)),lower(btrim(group_name)),coalesce(cohort_start_year,0),coalesce(study_level,''));
      create table study_group_members(id uuid primary key default gen_random_uuid(),group_id uuid references study_groups(id),user_id uuid references profiles(id),
        invited_by uuid,status text,accepted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),unique(group_id,user_id));
      create table study_group_deputy_requests(id uuid primary key default gen_random_uuid(),group_id uuid,user_id uuid,status text,permissions text[] default '{}');
      create table study_group_cohort_collision_resolutions(request_id uuid,existing_group_id uuid,request_user_id uuid,existing_representative_id uuid,
        existing_representative_request_id uuid,university_id uuid,academic_unit_id uuid,specialty text,group_name text,new_cohort_start_year integer,
        new_study_level text,existing_cohort_start_year integer,existing_study_level text,confirmed_at timestamptz default now(),reason text,primary key(request_id,existing_group_id));
      create function public.xelay_is_study_group_representative(g uuid)returns boolean language sql stable security definer as $$select exists(select1 from public.study_groups where id=g and representative_id=auth.uid())$$;
    `.replace('select1', 'select 1'))
    await db.exec(routine(source['202610150007_study_group_cohort_identity.sql'], 'xelay_private_profile_group_cohort'))
    await db.exec(routine(source['202610150007_study_group_cohort_identity.sql'], 'xelay_guard_study_group_cohort_snapshot'))
    await db.exec(`create trigger study_group_cohort_snapshot_immutable before update on study_groups for each row execute function xelay_guard_study_group_cohort_snapshot();
      create function public.xelay_is_platform_admin()returns boolean language sql stable security definer as $$select exists(select 1 from public.user_roles where user_id=auth.uid()and role='ADMIN')and auth.jwt()->>'aal'='aal2'$$;
      create table fixture.teaching_calls(action text,payload jsonb);
      create table teaching_courses(id uuid primary key,owner_id uuid,university_id uuid,title text,semester text,archived_at timestamptz);
      create table teaching_course_groups(id uuid primary key,course_id uuid,group_id uuid,status text,invited_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),accepted_at timestamptz);
      create function public.xelay_teaching_assert_user()returns uuid language plpgsql stable security definer as $$begin if auth.uid()is null then raise exception 'TEACHING_AUTH_REQUIRED';end if;return auth.uid();end$$;
      create function public.xelay_teaching_permissions(c uuid,u uuid)returns text[]language sql stable security definer as $$select case when exists(select 1 from public.teaching_courses where id=c and owner_id=u)then array['manage']else '{}'::text[]end$$;
      create function public.xelay_teaching_lock_course(c uuid,p text)returns void language plpgsql security definer as $$begin if not exists(select 1 from public.teaching_courses where id=c and owner_id=auth.uid())then raise exception 'TEACHING_FORBIDDEN';end if;end$$;
      create function public.xelay_teaching_mutate_before_group_requests_20261027(p_action text,p_payload jsonb)returns jsonb language plpgsql security definer as $$begin insert into fixture.teaching_calls values(p_action,p_payload);return jsonb_build_object('action',p_action);end$$;
      create function public.xelay_teaching_workspace_before_group_requests_20261027()returns jsonb language sql stable security definer as $$select jsonb_build_object('sentinel','preserved','groups',coalesce((select jsonb_agg(jsonb_build_object('id',id,'group_name',group_name))from public.study_groups where university_id='${uni}'::uuid),'[]'::jsonb))$$;
      revoke all on study_groups,study_group_members,study_group_deputy_requests,class_representative_requests from public,anon,authenticated;
      grant select on study_groups,study_group_members,class_representative_requests to authenticated;
      insert into universities values('${uni}','Synthetic KNU','knu');insert into academic_units values('${fac}','${uni}','Synthetic economic faculty','economics');
    `)
    await db.exec(routine(source['202610270020_teaching_semesters_group_requests.sql'], 'xelay_teaching_mutate'))
    await db.exec(routine(source['202610270020_teaching_semesters_group_requests.sql'], 'xelay_teaching_workspace'))
    for (const [name, id] of Object.entries(user)) {
      await db.query('insert into auth.users(id)values($1)', [id])
      await db.query('insert into profiles(id,full_name,username,university_id,academic_unit_id,specialty,experience)values($1,$2,$3,$4,$5,$6,$7)', [id, 'Synthetic ' + name, 'synthetic.' + name, uni, fac, 'Synthetic OP', 'bachelor'])
    }
    await db.exec(`insert into user_roles values('${user.admin}','ADMIN');insert into auth.mfa_factors(user_id,status)values('${user.admin}','verified');
      update auth.users set email_confirmed_at=null where id='${user.unconfirmed}';update auth.users set banned_until='infinity'where id='${user.banned}';
      insert into teaching_courses values('${course}','${user.teacher}','${uni}','Synthetic subject','Synthetic semester',null);`)
    for (const [index, g, name, cohort, owner] of [[0, known, 'Known', 2025, user.owner], [1, unknown, 'Unknown', null, user.owner],
      [2, archive, 'Archive', 2010, user.owner], [3, collision, 'Collision', null, user.otherOwner], [4, rollback, 'Rollback', null, user.owner], [5, transferUnknown, 'TransferUnknown', null, user.owner], [6, adminGroup, 'Admin', null, user.admin]]) {
      await seedRequest(req(index), owner, name, cohort, cohort ? 'bachelor' : null)
      await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)
        values($1,$2,$3,$4,$5,'Synthetic OP',$6,$7,$8)`, [g, req(index), owner, uni, fac, name, cohort, cohort ? 'bachelor' : null])
      await db.query("insert into study_group_members(group_id,user_id,invited_by,status)values($1,$2,$3,'accepted')", [g, user.next, owner])
    }
    await seedRequest(req(10), user.applicant, 'Collision')
    await seedRequest(req(11), user.applicant, 'NewExplicit')
    await seedRequest(req(12), user.owner, 'TransferUnknown')
    await db.exec(routine(source['202610260002_study_group_legacy_collision_recovery.sql'], 'xelay_create_study_group').replaceAll('\n', '\r\n'))
    await db.exec(`revoke all on function xelay_create_study_group(uuid)from public;grant execute on function xelay_create_study_group(uuid)to anon,authenticated,service_role;`)
    await db.exec(source['202610290003_study_group_representative_transfer.sql'])
    const beforeCreate = await one("select oid::text,to_jsonb(p)metadata,prosrc from pg_proc p where oid='xelay_create_study_group(uuid)'::regprocedure")
    const beforeMutate = await one("select oid::text,to_jsonb(p)-'prosrc'metadata from pg_proc p where oid='xelay_teaching_mutate(text,jsonb)'::regprocedure")
    const beforeRequests = await dump('class_representative_requests')
    await db.exec(source['202610290004_study_group_course_confirmation.sql'])
    await db.exec(source['202610290007_study_group_identity_review.sql'])

    await t.test('migration preserves original create/approval provenance and teaching mutation metadata', async () => {
      assert.deepEqual(await one("select oid::text,to_jsonb(p)metadata,prosrc from pg_proc p where oid='xelay_create_study_group(uuid)'::regprocedure"), beforeCreate)
      assert.deepEqual(await one("select oid::text,to_jsonb(p)-'prosrc'metadata from pg_proc p where oid='xelay_teaching_mutate(text,jsonb)'::regprocedure"), beforeMutate)
      assert.deepEqual(await dump('class_representative_requests'), beforeRequests)
    })
    await t.test('owner status requires every active group confirmation and preserves out-of-period archives', async () => {
      assert.equal((await status(unknown)).needs_confirmation, true)
      assert.equal((await status(known)).current_course, 2)
      assert.equal((await status(known)).needs_confirmation, true)
      const old = await status(archive); assert.equal(old.archived, true); assert.equal(old.current_course, null); assert.equal(old.needs_confirmation, false)
      await denied(status(unknown, user.next), 'NOT_OWNER'); await denied(status(unknown, user.foreign), 'NOT_OWNER')
    })
    await t.test('explicit owner confirmation fills an unknown pair once, without personal-profile inference or approval rewrite', async () => {
      const before = await one('select to_jsonb(g)value from study_groups g where id=$1', [unknown])
      const receipt = await confirm(unknown)
      assert.equal(receipt.cohort_start_year, 2026); assert.equal(receipt.replayed, false)
      const after = (await one('select to_jsonb(g)value from study_groups g where id=$1', [unknown])).value
      assert.deepEqual({ ...after, cohort_start_year: null, study_level: null }, before.value)
      assert.equal((await status(unknown)).confirmed, true); assert.equal((await status(unknown)).needs_confirmation, false)
      assert.equal((await one('select repair_pending from study_group_course_confirmations where request_id=$1', [command(1)])).repair_pending, false)
      assert.deepEqual(await dump('class_representative_requests'), beforeRequests)
    })
    await t.test('retries, forged requests, invalid dates/degree and inactive accounts cannot create new authority', async () => {
      assert.equal((await confirm(unknown)).replayed, true)
      await denied(confirm(unknown, 2), 'REQUEST_REUSED'); await denied(confirm(unknown, 1, command(1), user.next), 'REQUEST_REUSED')
      for (const [n, level, year] of [[0, 'bachelor', 2026], [7, 'bachelor', 2026], [1, 'other', 2026], [1, 'bachelor', 2025]]) await denied(confirm(known, n, command(20), user.owner, level, year), 'INVALID_INPUT')
      for (const who of [user.banned, user.unconfirmed]) await denied(confirm(unknown, 1, command(30), who), 'AUTH_REQUIRED')
    })
    await t.test('known cohorts cannot be reinterpreted, while matching confirmation and yearly progression are automatic', async () => {
      await denied(confirm(known, 1, command(2)), 'IDENTITY_MISMATCH')
      await denied(confirm(known, 2, command(2), user.owner, 'master'), 'IDENTITY_MISMATCH')
      await confirm(known, 2, command(2)); assert.equal((await status(known)).confirmed, true)
      await db.exec('update fixture.clock set year=2027')
      const nextYear = await status(known); assert.equal(nextYear.current_course, 3); assert.equal(nextYear.needs_confirmation, false)
      await db.exec('update fixture.clock set year=2026')
    })
    await t.test('browser GUCs, direct writes and new unknown inserts do not bypass the immutable guard or closed receipts', async () => {
      await denied(db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user.owner, role: 'authenticated', aal: 'aal1' })])
        await tx.exec("select set_config('xelay.group_course_confirmed','true',true)")
        await tx.query("update study_groups set cohort_start_year=2026,study_level='bachelor'where id=$1", [rollback])
      }), 'IMMUTABLE')
      await denied(as(user.owner, 'update study_groups set cohort_start_year=2020 where id=$1', [known]))
      await denied(as(user.owner, "insert into study_group_course_confirmations(request_id,group_id,actor_id,representative_id,academic_year,course,cohort_start_year,study_level)values($1,$2,$3,$3,2026,1,2026,'bachelor')", [command(31), rollback, user.owner]))
      await denied(db.query("insert into study_groups(representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)values($1,$2,$3,$4,'Synthetic OP','NewUnknown')", [req(12), user.owner, uni, fac]), 'COURSE_REQUIRED')
      const fks = await rows("select confrelid::regclass::text target from pg_constraint where conrelid='study_group_course_confirmations'::regclass and contype='f'")
      assert.deepEqual(fks.map(x => x.target), ['study_groups'])
    })
    await t.test('failed receipt completion rolls back both the unknown identity and confirmation atomically', async () => {
      await db.exec(`create function fixture.fail_course_receipt()returns trigger language plpgsql as $$begin
        if new.group_id='${rollback}'::uuid and old.repair_pending and not new.repair_pending then raise exception 'FIXTURE_CLOSE_FAILURE';end if;return new;end$$;
        create trigger fixture_receipt_close before update on study_group_course_confirmations for each row execute function fixture.fail_course_receipt();`)
      await denied(confirm(rollback,1,command(33)), 'FIXTURE_CLOSE_FAILURE')
      assert.deepEqual(await one('select cohort_start_year,study_level from study_groups where id=$1',[rollback]),{cohort_start_year:null,study_level:null})
      assert.equal((await one('select count(*)::integer n from study_group_course_confirmations where request_id=$1',[command(33)])).n,0)
      await db.exec('drop trigger fixture_receipt_close on study_group_course_confirmations;drop function fixture.fail_course_receipt();')
    })
    await t.test('actual headman transfer retains anchored confirmations and permits the new owner to confirm an unknown group', async () => {
      await call(user.owner, 'xelay_transfer_study_group_representative', [known, user.next, user.owner, command(40)])
      await denied(status(known), 'NOT_OWNER'); assert.equal((await status(known, user.next)).confirmed, true)
      await call(user.owner, 'xelay_transfer_study_group_representative', [transferUnknown, user.next, user.owner, command(41)])
      await confirm(transferUnknown, 1, command(42), user.next)
      assert.equal((await status(transferUnknown, user.next)).confirmed, true)
      await denied(create(req(5), user.owner), 'REQUEST_TRANSFERRED')
    })
    await t.test('fresh invitations require confirmed current identity; accepted/pending access operations retain their old path', async () => {
      const payload = { course_id: course, group_id: rollback }
      await denied(call(user.teacher, 'xelay_teaching_mutate', ['invite_group', payload]), 'CONFIRMATION_REQUIRED')
      await denied(call(user.foreign, 'xelay_teaching_mutate', ['invite_group', payload]), 'TEACHING_FORBIDDEN')
      await call(user.teacher, 'xelay_teaching_mutate', ['respond_group', { group_id: rollback }])
      await call(user.teacher, 'xelay_teaching_mutate', ['invite_group', { course_id: course, group_id: unknown }])
      await denied(call(user.teacher, 'xelay_teaching_mutate', ['invite_group', { course_id: course, group_id: archive }]), 'CONFIRMATION_REQUIRED')
      const calls = await rows('select action from fixture.teaching_calls order by ctid')
      assert.deepEqual(calls.map(x => x.action), ['respond_group', 'invite_group'])
    })
    await t.test('directory extension preserves upstream scope/order/keys and reports only academic readiness metadata', async () => {
      const workspace = await call(user.teacher, 'xelay_teaching_workspace')
      assert.equal(workspace.sentinel, 'preserved')
      assert.equal(workspace.groups.find(x => x.id === unknown).identity_ready, true)
      const missing = workspace.groups.find(x => x.id === rollback); assert.equal(missing.identity_ready, false); assert.equal(missing.identity_needs_confirmation, true)
      assert.equal(missing.university_slug, 'knu'); assert.equal(missing.academic_unit_slug, 'economics')
      assert.equal(workspace.groups.find(x => x.id === archive).identity_needs_confirmation, false)
    })
    let creationCase
    await t.test('unknown foreign collision remains blocked, with a bounded requester-only actionable review case', async () => {
      await denied(create(req(10), user.applicant), 'IDENTITY_NEEDS_REVIEW')
      creationCase = await review(req(10), null, command(60))
      assert.equal(creationCase.status, 'pending'); assert.equal((await review(req(10), null, command(60))).reused, true)
      assert.equal((await review(req(10), null, command(61))).id, creationCase.id)
      await denied(review(req(10), null, command(62), user.foreign), 'FORBIDDEN')
      await denied(review(req(11), null, command(63)), 'NOT_REQUIRED')
      const mine = await call(user.applicant, 'xelay_my_study_group_identity_reviews')
      assert.equal(mine.length, 1); assert.equal('snapshot' in mine[0], false)
      assert.deepEqual(await call(user.foreign, 'xelay_my_study_group_identity_reviews'), [])
    })
    await t.test('review queue requires existing verified admin MFA and exposes no approval contacts', async () => {
      await denied(call(user.admin, 'xelay_admin_study_group_identity_reviews', []), 'MFA_REQUIRED')
      await denied(call(user.foreign, 'xelay_admin_study_group_identity_reviews', [], 'aal2'), 'MFA_REQUIRED')
      await db.exec(`delete from auth.mfa_factors where user_id='${user.admin}'`)
      await denied(call(user.admin, 'xelay_admin_study_group_identity_reviews', [], 'aal2'), 'MFA_REQUIRED')
      await db.exec(`insert into auth.mfa_factors(user_id,status)values('${user.admin}','verified')`)
      const queue = await call(user.admin, 'xelay_admin_study_group_identity_reviews', [], 'aal2')
      assert.equal(queue.total, 1); assert.equal(queue.items[0].collision_groups[0].snapshot_unchanged, true)
      assert.equal(JSON.stringify(queue).includes('fixture-private-contact'), false)
    })
    await t.test('stale captured academic scope and self-review cannot grant an admin new group authority', async () => {
      const stale=await review(null,rollback,command(76),user.owner)
      await db.query("update study_groups set group_name='Rollback changed'where id=$1",[rollback])
      await denied(resolve(stale.id,'confirm_identity',rollback,1,'bachelor',2026),'GROUP_REVIEW_STALE')
      await db.query("update study_groups set group_name='Rollback'where id=$1",[rollback])
      await resolve(stale.id,'close')
      const own=await review(null,adminGroup,command(77),user.admin)
      await denied(resolve(own.id,'confirm_identity',adminGroup,1,'bachelor',2026),'SELF_REVIEW')
      assert.equal((await status(adminGroup,user.admin)).confirmed,false)
      await resolve(own.id,'close')
    })
    await t.test('operator distinction never claims or mutates the old group; explicit new creation preserves the approval snapshot', async () => {
      await denied(resolve(creationCase.id, 'distinct', unknown), 'FORBIDDEN')
      const oldGroup = await one('select to_jsonb(g)value from study_groups g where id=$1', [collision])
      await resolve(creationCase.id, 'distinct', collision)
      assert.deepEqual(await one('select to_jsonb(g)value from study_groups g where id=$1', [collision]), oldGroup)
      const id = await create(req(10), user.applicant)
      assert.notEqual(id, collision); assert.equal((await status(id, user.applicant)).confirmed, true)
      assert.equal(await create(req(10), user.applicant, command(81)), id)
      const original = await one('select cohort_start_year,study_level from class_representative_requests where id=$1', [req(10)])
      assert.deepEqual(original, { cohort_start_year: null, study_level: null })
      await denied(confirm(collision,1,command(65),user.otherOwner),'GROUP_ALREADY_EXISTS')
      assert.equal((await one('select cohort_start_year from study_groups where id=$1',[collision])).cohort_start_year,null)
    })
    await t.test('direct explicit creation is atomic, requires course input and returns an existing own group even if legacy unknown', async () => {
      await denied(create(req(11), user.applicant, command(83), 7), 'INVALID_INPUT')
      const id = await create(req(11), user.applicant, command(83), 2)
      assert.equal((await status(id, user.applicant)).current_course, 2)
      assert.equal(await create(req(4), user.owner, command(84), 0), rollback)
      await denied(call(user.foreign, 'xelay_create_study_group_with_course', [req(11), 1, 'bachelor', 2026, command(85)]), 'REQUEST_TRANSFERRED')
      for(const who of [user.banned,user.unconfirmed]) await denied(create(req(11),who), 'AUTH_REQUIRED')
    })
    await t.test('admin can explicitly confirm one captured unknown identity without changing ownership; closure is visible only to applicant', async () => {
      const groupCase = await review(null, rollback, command(70), user.owner)
      const ownerBefore = (await one('select representative_id from study_groups where id=$1', [rollback])).representative_id
      await resolve(groupCase.id, 'confirm_identity', rollback, 1, 'bachelor', 2026)
      assert.equal((await one('select representative_id from study_groups where id=$1', [rollback])).representative_id, ownerBefore)
      assert.equal((await status(rollback)).confirmed, true)
      const mismatch = await review(null, known, command(71), user.next, 1)
      await denied(resolve(mismatch.id, 'confirm_identity', known, 1, 'bachelor', 2026), 'IDENTITY_MISMATCH')
      await resolve(mismatch.id, 'close')
      const mine = await call(user.next, 'xelay_my_study_group_identity_reviews'); assert.equal(mine[0].status, 'closed'); assert.match(mine[0].resolution_reason, /operator-reviewed/)
    })
    await t.test('new RPCs and closed tables reject anonymous/service access and no repair ticket remains pending', async () => {
      for (const role of ['anon', 'service_role']) await denied(call(user.owner, 'xelay_study_group_course_status', [unknown], 'aal1', role))
      for (const table of ['study_group_course_confirmations', 'study_group_identity_reviews']) await denied(as(user.owner, 'select * from ' + table))
      assert.equal((await one('select count(*)::integer n from study_group_course_confirmations where repair_pending')).n, 0)
      assert.deepEqual(await one('select cohort_start_year,study_level from class_representative_requests where id=$1', [req(1)]), { cohort_start_year: null, study_level: null })
    })
    console.log(JSON.stringify({ realPostgres: true, freeBeforeMiB: freeBefore, peakRssMiB: Math.ceil(Math.max(peak, process.memoryUsage().rss / 1048576)), noProductionConnections: true }))
  } finally { clearInterval(guard); clearTimeout(timeout); await db.close() }
})
