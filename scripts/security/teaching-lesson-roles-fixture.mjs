// Isolated real teaching chain; every account and course is fictional.
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'
export const readLessonRoleMigration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')

export async function lessonRoleFixture() {
  const fx = await audienceFixture()
  try {
    // The directory release preflight pins two actual production identities.
    // Install its exact v1 view block, then the complete v2 predicate migration,
    // without inventing those identities or replacing any authorization guard.
    const hidden = await readLessonRoleMigration('202610300002_hidden_test_study_groups.sql')
    const start = hidden.indexOf('create or replace view public.xelay_listed_study_groups')
    const end = hidden.indexOf('do $patch_list_reads$', start)
    if (start < 0 || end < start) throw new Error('Hidden directory fixture source drift')
    await fx.db.exec(hidden.slice(start, end))
    await fx.db.exec(await readLessonRoleMigration('202610300005_test_group_viewer_exceptions.sql'))
    // Mirror that release's exact source replacement for the calendar only.
    // All function privileges, verification, scope and subject checks survive.
    const old = (await fx.db.query("select pg_get_functiondef('public.xelay_teaching_calendar(date,date)'::regprocedure) body")).rows[0].body
    const patched = old.replace(/\b(from|join)(\s+)public\.study_groups\b/gi, '$1$2public.xelay_listed_study_groups')
    if (patched === old) throw new Error('Calendar directory fixture source drift')
    await fx.db.exec(patched)
    for (const name of ['202611030104_academic_notification_priority.sql',
      '202611030106_teaching_common_deadline_notifications.sql', '202611040001_fix_teaching_gradebook_dispatch.sql',
      '202611040030_teaching_journal_schedule.sql', '202611040031_teacher_calendar_homework.sql']) {
      await fx.db.exec(await readLessonRoleMigration(name))
    }
    return fx
  } catch (error) { await fx.close(); throw error }
}
