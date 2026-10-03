import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

// Isolated legacy baseline: no production connection, account, or user data.
const fixture = await createFixture({ through: '202610030003' })
const { db } = fixture
const userA = '10000000-0000-4000-8000-000000000001'
const userB = '10000000-0000-4000-8000-000000000002'
const userC = '10000000-0000-4000-8000-000000000003'
const universityA = '20000000-0000-4000-8000-000000000001'
const universityB = '20000000-0000-4000-8000-000000000002'
const unitA = '21000000-0000-4000-8000-000000000001'
const unitB = '21000000-0000-4000-8000-000000000002'
const specialtyA = '22000000-0000-4000-8000-000000000001'
const specialtyB = '22000000-0000-4000-8000-000000000002'
const postId = '30000000-0000-4000-8000-000000000001'
let assertions = 0
let actor = null
let lastStatement = 'setup'

async function query(sql, parameters = []) {
  lastStatement = sql
  const result = actor
    ? await fixture.asUser(actor.id || null, sql, parameters, { role: actor.role })
    : await db.query(sql, parameters)
  return result.rows
}
async function check(sql, expected, parameters = []) {
  assert.deepEqual(await query(sql, parameters), expected)
  assertions += 1
}
async function denied(sql, code = '42501', parameters = []) {
  await assert.rejects(() => query(sql, parameters), error => error.code === code)
  assertions += 1
}
async function actAs(role, id = '') {
  actor = role === 'postgres' ? null : { role, id }
}

try {
  await db.exec(`
    insert into public.universities(id,name,slug) values
      ('${universityA}','Security fixture A','security-fixture-a'),
      ('${universityB}','Security fixture B','security-fixture-b');
    insert into public.academic_units(id,university_id,name,slug,unit_type) values
      ('${unitA}','${universityA}','Fixture faculty A','security-fixture-a','faculty'),
      ('${unitB}','${universityB}','Fixture faculty B','security-fixture-b','faculty');
    insert into public.academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values
      ('${specialtyA}','${universityA}','${unitA}','A','Fixture program A','Fixture program A'),
      ('${specialtyB}','${universityB}','${unitB}','B','Fixture program B','Fixture program B');
    do $$begin
      if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_email_key') then
        alter table public.profiles add constraint profiles_email_key unique(email);
      end if;
    end$$;
    grant select(email),update(email,rating,trust_score) on public.profiles to public,anon,authenticated;
    grant all on public.xelay_users to public,anon,authenticated,service_role;
    grant select(email),update(email) on public.xelay_users to public,anon,authenticated;
    create function public.increment_profile_rating(profile_id text) returns void language sql security definer as $$
      update profiles set rating=coalesce(rating,0)+1 where id::text=profile_id
    $$;
    -- The shared fixture intentionally omits this unrelated legacy badge body;
    -- reproduce its observed signature/ACL to check the overload cleanup.
    create function public.check_user_badges(p_user_id uuid) returns void language plpgsql as $$begin return; end$$;
    grant execute on function public.increment_profile_rating(uuid),public.increment_profile_rating(text),
      public.check_user_badges(uuid) to public,anon,authenticated,service_role;
  `)
  await fixture.seedUser(userA, { email: 'canonical-a@example.test', university_id: universityA,
    academic_unit_id: unitA, specialty_id: specialtyA, rating: 5, trust_score: 7 })
  await fixture.seedUser(userB, { email: 'canonical-b@example.test', university_id: universityB,
    academic_unit_id: unitB, specialty_id: specialtyB, rating: null, trust_score: null })
  await db.exec(`
    update public.profiles set email='tampered@example.test' where id='${userA}';
    update public.profiles set email='canonical-a@example.test' where id='${userB}';
    insert into public.xelay_users(id,user_id,email) values('legacy','${userA}','legacy@example.test');
    insert into public.user_roles(user_id,role,university_id,academic_unit_id) values
      ('${userA}','FACULTY_EDITOR','${universityA}','${unitA}'),
      ('${userB}','FACULTY_EDITOR','${universityB}','${unitB}');
  `)
  const migration = await readFile(new URL('../../supabase/migrations/202610030006_profile_news_security.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  await check('select email from public.profiles where id=$1', [{ email: 'canonical-a@example.test' }], [userA])
  await check("select count(*)::int as count from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_email_key'", [{ count: 0 }])

  await actAs('authenticated', userA)
  await query("select set_config('request.jwt.claim.role','service_role',false)")
  await denied('update public.profiles set rating=999 where id=$1', '42501', [userA])
  await denied('update public.profiles set trust_score=999 where id=$1', '42501', [userA])
  await query("update public.profiles set full_name='Updated',rating=5,trust_score=7,email='canonical-b@example.test',created_at='infinity' where id=$1", [userA])
  await check('select full_name,email,rating,trust_score,isfinite(created_at) as finite from public.profiles where id=$1', [{ full_name: 'Updated', email: 'canonical-a@example.test', rating: 5, trust_score: 7, finite: true }], [userA])
  await query("update public.profiles set email='absent@example.test' where id=$1", [userA])
  await check('select email from public.profiles where id=$1', [{ email: 'canonical-a@example.test' }], [userA])
  await check('select count(*)::int as count from public.profiles where id=$1', [{ count: 0 }], [userB])
  await denied('select * from public.xelay_users')
  await denied('select public.increment_profile_rating($1::uuid)', '42501', [userA])
  await denied('select public.increment_profile_rating($1::text)', '42501', [userA])
  await denied('select public.check_user_badges($1::uuid)', '42501', [userA])
  await check("select has_table_privilege('authenticated','public.profiles','TRUNCATE') as allowed", [{ allowed: false }])
  await check("select has_table_privilege('authenticated','public.profiles','TRIGGER') as allowed", [{ allowed: false }])
  await denied('update public.profiles set id=$2 where id=$1', '42501', [userA, userB])

  await actAs('authenticated', userB)
  await query("update public.profiles set full_name='Legacy',rating=0,trust_score=0 where id=$1", [userB])
  await check('select rating,trust_score from public.profiles where id=$1', [{ rating: null, trust_score: null }], [userB])

  await actAs('postgres')
  await query('insert into auth.users(id,email) values($1,$2)', [userC, 'canonical-c@example.test'])
  await actAs('authenticated', userC)
  await query("insert into public.profiles(id,full_name,username,email,rating,trust_score,created_at) values($1,'New profile','new_profile_003','canonical-a@example.test',999,999,'infinity')", [userC])
  await check('select email,rating,trust_score,isfinite(created_at) as finite from public.profiles where id=$1', [{ email: 'canonical-c@example.test', rating: 0, trust_score: 0, finite: true }], [userC])

  await actAs('authenticated', userA)
  await query("insert into public.news_posts(id,university_id,academic_unit_id,published_by,post_type,title,excerpt,body,created_at) values($1,$2,$3,$4,'news','Fixture news','Fixture summary','Original','infinity')", [postId, universityA, unitA, userA])
  await denied('update public.news_posts set published_by=$2 where id=$1', '42501', [postId, userB])
  await denied('update public.news_posts set id=$2 where id=$1', '42501', [postId, '30000000-0000-4000-8000-000000000002'])
  await denied('update public.news_posts set university_id=$2 where id=$1', '42501', [postId, universityB])
  await query("update public.news_posts set body='Edited',created_at='infinity' where id=$1", [postId])
  await check('select body,published_by,isfinite(created_at) as finite from public.news_posts where id=$1', [{ body: 'Edited', published_by: userA, finite: true }], [postId])
  await query('select public.xelay_update_news_post($1,$2::jsonb)', [postId, {
    title: 'Fixture news', excerpt: 'Fixture summary', body: 'Edited through RPC',
    published_at: '2026-10-03T09:00:00Z', post_type: 'news', is_pinned: false,
    event_starts_at: null, event_location: null, organizer: null,
    registration_url: null, link_url: null,
  }])
  await check('select body,published_by from public.news_posts where id=$1', [{ body: 'Edited through RPC', published_by: userA }], [postId])
  await check('select count(*)::int as count from public.news_editor_audit_log', [{ count: 0 }])
  await denied("insert into public.news_editor_audit_log(post_id,publisher_id,action) values($1,$2,'update')", '42501', [postId, userA])
  await query('delete from public.news_posts where id=$1', [postId])

  await actAs('anon')
  await denied('select * from public.xelay_users')
  await denied('select * from public.profiles')
  await denied('select public.increment_profile_rating($1::uuid)', '42501', [userA])
  await actAs('service_role')
  await query('select public.increment_profile_rating($1::uuid)', [userA])

  await actAs('postgres')
  await query('update auth.users set email=$2 where id=$1', [userA, 'changed-a@example.test'])
  await check('select email,rating from public.profiles where id=$1', [{ email: 'changed-a@example.test', rating: 6 }], [userA])
  await check('select action,changed_columns from public.news_editor_audit_log where post_id=$1 order by occurred_at', [
    { action: 'insert', changed_columns: [] },
    { action: 'update', changed_columns: ['body'] },
    { action: 'update', changed_columns: ['body', 'published_at'] },
    { action: 'delete', changed_columns: [] },
  ], [postId])
  await check("select count(*)::int as count from pg_policies where schemaname='public' and tablename='xelay_users'", [{ count: 1 }])
  console.log(`Profile/news security: ${assertions} assertions passed; migration retry passed.`)
} catch (error) {
  console.error(`Profile/news security failed: ${error.message} (${error.code || 'assertion'}); statement: ${lastStatement}`)
  process.exitCode = 1
} finally {
  await fixture.close()
}
