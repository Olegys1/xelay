// Actual installed schedule functions; synthetic rows in in-memory PostgreSQL.
// Opt-in and resource guarded. Never connects to Supabase, a meeting or a user.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { freemem } from 'node:os'
import { createFixture } from './fixture.mjs'
const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const first = result => result.rows[0]
test('additional links survive actual import, signed day/custom/sequence copies, inheritance, repair and existing group access controls', { skip: process.env.XELAY_EXTRA_LINKS_SQL !== '1' ? 'Opt-in guarded PostgreSQL fixture' : false, timeout: 60_000 }, async t => {
  if (freemem() / 1048576 < 1400) { t.skip('Requires1400MiB free memory before starting'); return }
  const guard = setInterval(() => { if (process.memoryUsage().rss / 1048576 > 650 || freemem() / 1048576 < 500) { console.error('Stopped at650MiB RSS or500MiB OS reserve'); process.exit(77) } }, 75); guard.unref()
  const deadline = setTimeout(() => { console.error('Stopped at60second deadline'); process.exit(78) }, 60_000); deadline.unref()
  let fx
  try {
    fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;alter table auth.users add column raw_app_meta_data jsonb default '{}';create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');` })
    const { db, asUser, seedUser } = fx
    for (const file of ['202610230003_timetable_teacher_name.sql', '202610230004_schedule_copy_first_shift_order.sql', '202610240007_schedule_copy_link_inheritance.sql', '202610240008_schedule_copy_link_repair.sql', '202610240009_schedule_copy_link_self_repair.sql', '202610260003_schedule_conference_access.sql', '202610260005_schedule_copy_custom_times.sql']) await db.exec(await read(file))
    // Apply only the two actual later calendar permission call replacements;
    // source routine, filtering and access ACL come from the repository migrations.
    const calendar = first(await db.query("select pg_get_functiondef('xelay_teaching_calendar(date,date)'::regprocedure) definition")).definition
    const removedUnion = (await read('202610240006_teacher_calendar_timetable.sql')).match(/v_old:=\$old\$([\s\S]*?)\$old\$/)?.[1]
    assert.ok(removedUnion && calendar.includes(removedUnion))
    await db.exec(calendar.replace(removedUnion, '').replaceAll('public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)').replaceAll('public.xelay_teaching_permissions(o.course_id,v_uid)', 'public.xelay_teaching_group_permissions(o.course_id,o.group_id,v_uid)'))
    await db.exec(await read('202610290001_home_teacher_conference.sql'))
    const owner = randomUUID(), deputy = randomUUID(), member = randomUUID(), outsider = randomUUID(), university = randomUUID(), unit = randomUUID(), program = randomUUID()
    await db.query("insert into universities(id,name,slug) values($1,'Extra links fixture',$2)", [university, 'extra-' + university])
    await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Extra faculty',$3,'faculty')", [unit, university, 'extra-' + unit])
    await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'EXTRA','Extra program','Extra program')", [program, university, unit])
    const username = id => 'extra_' + id.replaceAll('-', '').slice(0, 16)
    for (const id of [owner, deputy, member, outsider]) await seedUser(id, { username: username(id), university_id: university, academic_unit_id: unit, specialty_id: program, study_year: 1, experience: 'bachelor', categories: ['General'] })
    const request = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at) select $1,id,full_name,university_id,academic_unit_id,specialty,'EXTRA-1','extra_fixture','approved',id,now() from profiles where id=$2`, [request, owner])
    const group = first(await asUser(owner, 'select xelay_create_study_group($1) id', [request])).id
    for (const id of [deputy, member]) { const invitation = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) id', [group, username(id)])).id; await asUser(id, 'select xelay_respond_study_group_invitation($1,true)', [invitation]) }
    await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [group, deputy])
    const insert = async (subject, extra = [], actor = owner, options = {}) => first(await asUser(actor, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,online_url_secondary,online_url_label,online_url_secondary_label,conference_id,conference_access_code,online_links_extra,valid_from,valid_until,created_by) values($1,1,'14:30','15:50',$2,'lecture','','https://example.test/one','https://example.test/two','Основне','Запасне','123 456','000067',$3::jsonb,'2026-10-12','2027-01-31',$4) returning *`, [group, subject, JSON.stringify(extra), actor], options))
    // Preserve existing rows, exact routine metadata and policies during install.
    const old = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,valid_from,valid_until,created_by) values($1,2,'09:40','11:00','Existing unchanged','lecture','','2026-10-12','2027-01-31',$2) returning *`, [group, owner]))
    const signatures = ['xelay_import_study_group_timetable(uuid,jsonb)', 'xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)', 'xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)', 'xelay_private_copy_schedule_day_custom(uuid,date,date,boolean,text,text,jsonb,text,integer,boolean)', 'xelay_private_first_shift_projection(jsonb,jsonb)', 'xelay_private_schedule_copy_link_guard()', 'xelay_private_schedule_copy_link_propagate()', 'xelay_admin_schedule_copy_link_repair(uuid,boolean,text,uuid)', 'xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)', 'xelay_teaching_calendar(date,date)']
    const contracts = () => db.query("select oid::text,to_jsonb(p)-'prosrc' metadata from pg_proc p where oid=any($1::regprocedure[]) order by oid", [signatures]).then(r => r.rows)
    const policies = () => db.query("select * from pg_policies where tablename='study_group_schedule' order by policyname").then(r => r.rows)
    const beforeContracts = await contracts(), beforePolicies = await policies()
    await db.exec((await read('202610290005_schedule_additional_links.sql')).replace(/\r?\n/g, '\r\n'))
    assert.deepEqual(await contracts(), beforeContracts); assert.deepEqual(await policies(), beforePolicies)
    const row = id => asUser(owner, 'select * from study_group_schedule where id=$1', [id]).then(first)
    const unchanged = await row(old.id); assert.deepEqual(unchanged.online_links_extra, []); delete unchanged.online_links_extra; assert.deepEqual(unchanged, old)
    const extra = [{ url: 'https://example.test/three', label: 'Третє' }, { url: 'https://example.test/four', label: 'Четверте' }]
    const source = await insert('Additional links', extra)
    assert.deepEqual(source.online_links_extra, extra); assert.equal(source.online_url_secondary, 'https://example.test/two'); assert.equal(source.conference_access_code, '000067')
    assert.deepEqual(first(await asUser(member, 'select online_links_extra from study_group_schedule where id=$1', [source.id])).online_links_extra, extra)
    assert.deepEqual((await asUser(outsider, 'select id from study_group_schedule where id=$1', [source.id])).rows, [])
    await assert.rejects(insert('Member forbidden', extra, member)); await assert.rejects(insert('Anon forbidden', extra, outsider, { role: 'anon' }))
    for (const invalid of [{}, Array(19).fill(extra[0]), [{ url: 'javascript:alert(1)' }], [{ url: 'https://user:secret@example.test/' }], [{ url: '', label: 'Missing URL' }], [{ url: extra[0].url, label: 'bad\u202Ename' }], [{ url: extra[0].url, label: 'x'.repeat(81) }], [{ url: extra[0].url, other: true }]]) await assert.rejects(insert('Invalid extras', invalid), /EXTRA_LINKS/)
    await asUser(deputy, 'update study_group_schedule set online_links_extra=$2::jsonb where id=$1', [source.id, JSON.stringify(extra)])
    const payload = subject => ({ weekday: 3, starts_at: '11:20', ends_at: '12:40', subject, lesson_type: 'seminar', location: '', online_url: 'https://example.test/main', conference_access_code: '000099', online_links_extra: extra, valid_from: '2026-10-12', valid_until: '2027-01-31' })
    const imported = await asUser(owner, 'select xelay_import_study_group_timetable($1,$2::jsonb) n', [group, JSON.stringify([payload('Imported')])]); assert.equal(first(imported).n, 1)
    await assert.rejects(asUser(owner, 'select xelay_import_study_group_timetable($1,$2::jsonb) n', [group, JSON.stringify([payload('Imported')])]), /DUPLICATE_LESSON/)
    const beforeCount = first(await db.query('select count(*)::int n from study_group_schedule')).n
    await assert.rejects(asUser(owner, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [group, JSON.stringify([payload('Must rollback'), { ...payload('Bad'), online_links_extra: [{ url: 'file:///unsafe' }] }])]), /EXTRA_LINKS/)
    assert.equal(first(await db.query('select count(*)::int n from study_group_schedule')).n, beforeCount)
    const copy = async ({ target = '2026-10-17', preview = true, signature = null, custom = false } = {}) => first(await asUser(owner, custom ? 'select xelay_copy_study_group_schedule_day_with_custom_times($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) data' : 'select xelay_copy_study_group_schedule_day_with_time_mode($1,$2,$3,$4,$5,$6,$7::jsonb) data', custom ? [group, '2026-10-12', target, preview, signature, 'first_shift', '[]', '08:30', false] : [group, '2026-10-12', target, preview, signature, 'original', '[]'])).data
    const regular = await copy(); await copy({ preview: false, signature: regular.source_signature })
    const copied = first(await asUser(owner, 'select * from study_group_schedule where copied_from_schedule_id=$1 and valid_from=$2', [source.id, '2026-10-17']))
    assert.deepEqual(copied.online_links_extra, extra); assert.equal(copied.inherit_source_links, true)
    const custom = await copy({ target: '2026-10-18', custom: true }); await copy({ target: '2026-10-18', custom: true, preview: false, signature: custom.source_signature })
    const shifted = first(await asUser(owner, 'select * from study_group_schedule where copied_from_schedule_id=$1 and valid_from=$2', [source.id, '2026-10-18']))
    assert.equal(shifted.starts_at, '08:30:00'); assert.deepEqual(shifted.online_links_extra, extra)
    const stale = await copy({ target: '2026-10-24' }), revised = [...extra, { url: 'https://example.test/five', label: 'Оновлено' }]
    await asUser(owner, 'update study_group_schedule set online_links_extra=$2::jsonb where id=$1', [source.id, JSON.stringify(revised)])
    assert.deepEqual((await row(copied.id)).online_links_extra, revised); assert.deepEqual((await row(shifted.id)).online_links_extra, revised)
    await assert.rejects(copy({ target: '2026-10-24', preview: false, signature: stale.source_signature }), /SOURCE_CHANGED/)
    const manual = [{ url: 'https://example.test/manual', label: 'Власне' }]
    await asUser(owner, 'update study_group_schedule set online_links_extra=$2::jsonb where id=$1', [copied.id, JSON.stringify(manual)])
    assert.equal((await row(copied.id)).inherit_source_links, false)
    await asUser(owner, 'update study_group_schedule set online_links_extra=$2::jsonb where id=$1', [source.id, JSON.stringify(extra)])
    assert.deepEqual((await row(copied.id)).online_links_extra, manual)
    await asUser(owner, 'update study_group_schedule set inherit_source_links=true where id=$1', [copied.id]); assert.deepEqual((await row(copied.id)).online_links_extra, extra)
    const pairs = [{ source_date: '2026-10-12', target_date: '2026-10-31' }]
    const sequence = async (preview = true, signature = null) => first(await asUser(owner, 'select xelay_copy_study_group_schedule_sequence_with_custom_times($1,$2::jsonb,$3,$4,$5,$6::jsonb,$7,$8) data', [group, JSON.stringify(pairs), preview, signature, 'first_shift', '{}', '08:30', false])).data
    const planned = await sequence(); await sequence(false, planned.source_signature)
    assert.deepEqual(first(await asUser(owner, 'select online_links_extra from study_group_schedule where copied_from_schedule_id=$1 and valid_from=$2', [source.id, '2026-10-31'])).online_links_extra, extra)
    const repairSource = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_links_extra,valid_from,valid_until,created_by) values($1,1,'11:20','12:40','Repair extras only','lecture','',$2::jsonb,'2030-04-08','2030-04-30',$3) returning id`, [group, JSON.stringify(extra), owner])).id
    const repairTargets = []
    for (const [date, value] of [['2030-04-13', []], ['2030-04-20', manual]]) repairTargets.push(first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_links_extra,valid_from,valid_until,created_by) values($1,6,'11:20','12:40','Repair extras only','lecture','',$2::jsonb,$3,$3,$4) returning id`, [group, JSON.stringify(value), date, owner])).id)
    const repairPlan = first(await asUser(owner, 'select xelay_repair_my_schedule_copy_links($1,true,null,$2) data', [group, owner])).data
    assert.equal(repairPlan.count, 1); assert.equal(repairPlan.pairs[0].target_id, repairTargets[0])
    await asUser(owner, 'select xelay_repair_my_schedule_copy_links($1,false,$2,$3)', [group, repairPlan.signature, owner])
    assert.equal((await row(repairTargets[0])).copied_from_schedule_id, repairSource); assert.deepEqual((await row(repairTargets[0])).online_links_extra, extra)
    assert.equal((await row(repairTargets[1])).copied_from_schedule_id, null); assert.deepEqual((await row(repairTargets[1])).online_links_extra, manual)
    await asUser(owner, 'delete from study_group_schedule where id=$1', [source.id])
    assert.equal((await row(shifted.id)).copied_from_schedule_id, null); assert.deepEqual((await row(shifted.id)).online_links_extra, extra)
    const projection = first(await db.query("select pg_get_functiondef('xelay_teaching_calendar(date,date)'::regprocedure) source")).source
    assert.ok(projection.includes("s.online_links_extra,'timetable'::text source")); assert.equal(projection.includes('study_group_seminar_schedule'), false)
    assert.ok(projection.includes('public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)'))
    const syncTriggers = await db.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='study_group_schedule'::regclass and tgname='study_group_schedule_copy_link_sync'")
    assert.ok(first(syncTriggers).definition.includes('online_links_extra'))
  } finally { if (fx) await fx.close(); clearInterval(guard); clearTimeout(deadline) }
})
