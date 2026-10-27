// Reusable isolated PostgreSQL teaching setup, fictional identities only.
// Includes current teaching prerequisites; no network/provider/production calls.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

export async function createTeachingScopedFixture() {
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  const { db, asUser, seedUser } = fx
  try {
    // Unrelated platform-news releases pin a separately inspected live helper.
    // Install the real, complete current teaching chain without weakening that
    // unrelated fingerprint or replacing any teaching guard with a fixture stub.
    for (const name of ['202610230001_teacher_material_access.sql', '202610230003_timetable_teacher_name.sql',
      '202610240002_teacher_academic_profile.sql', '202610240003_academic_contacts.sql',
      '202610240004_grading_templates_and_work_types.sql', '202610240005_teacher_seminar_boundary.sql',
      '202610240006_teacher_calendar_timetable.sql', '202610260004_teacher_request_contact.sql']) {
      await db.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'))
    }
    const ids = Object.fromEntries(['owner', 'colleague', 'otherTeacher', 'headA', 'headB', 'studentA', 'studentB', 'outsider', 'admin', 'course'].map(name => [name, randomUUID()]))
    const scope = (await db.query('select id,university_id from academic_units where is_active limit 1')).rows[0]
    const specialty = randomUUID()
    await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
      values($1,$2,$3,'SCOPED','Synthetic scoped programme','Synthetic scoped programme')`, [specialty, scope.university_id, scope.id])
    for (const [name, id] of Object.entries(ids).filter(([name]) => name !== 'course')) {
      const teacher = ['owner', 'colleague', 'otherTeacher'].includes(name)
      await seedUser(id, { full_name: 'Synthetic ' + name, username: 'ts_' + id.replaceAll('-', '').slice(0, 16),
        university_id: scope.university_id, academic_unit_id: scope.id, specialty_id: teacher ? null : specialty,
        account_type: teacher ? 'teacher' : 'student', categories: teacher ? [] : ['General'], experience: teacher ? '' : 'bachelor' })
      if (teacher) await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,status,reviewed_by,reviewed_at,contact_telegram)
        values($1,$2,$3,$4,'Synthetic department','Synthetic lecturer','approved',null,now(),'synthetic_teacher')`, [id, 'Synthetic ' + name, scope.university_id, scope.id])
    }
    await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [ids.admin])
    await db.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp')", [ids.admin])
    const rpc = async (who, name, args = [], options = {}) => (await asUser(who,
      `select ${name}(${args.map((_, index) => '$' + (index + 1)).join(',')}) data`, args, options)).rows[0].data
    const mutate = (who, action, payload, options) => rpc(who, 'xelay_teaching_mutate', [action, JSON.stringify(payload)], options)
    const classroom = (who, action, payload) => rpc(who, 'xelay_classroom_mutate', [action, JSON.stringify(payload)])
    const dates = (await db.query("select (current_date-30)::text start,(current_date+180)::text finish,(current_date+7)::text lesson_a,(current_date+8)::text lesson_b")).rows[0]
    await mutate(ids.owner, 'create_course', { id: ids.course, version: 0, title: 'Synthetic scoped subject', semester: 'Synthetic semester', starts_on: dates.start, ends_on: dates.finish })
    const groups = []
    for (const [index, suffix] of ['A', 'B'].entries()) {
      const group = randomUUID(), request = randomUUID(), head = ids['head' + suffix], student = ids['student' + suffix]
      await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
        values($1,$2,'Synthetic head',$3,$4,'Synthetic scoped programme',$5,'synthetic_head','approved',$6,now())`, [request, head, scope.university_id, scope.id, 'Synthetic group ' + suffix, ids.admin])
      await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
        values($1,$2,$3,$4,$5,'Synthetic scoped programme',$6)`, [group, request, head, scope.university_id, scope.id, 'Synthetic group ' + suffix])
      await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [group, student, head])
      const invitation = await mutate(ids.owner, 'invite_group', { course_id: ids.course, group_id: group })
      await mutate(head, 'respond_group', { link_id: invitation.id, accept: true })
      groups.push(group)
    }
    const item = async id => (await db.query('select to_jsonb(i) data from teaching_items i where id=$1', [id])).rows[0]?.data
    return { ...fx, ids, scope, groups, dates, rpc, mutate, classroom, item }
  } catch (error) { await fx.close(); throw error }
}
