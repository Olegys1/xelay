import { readFile } from 'node:fs/promises'
import { lessonRoleFixture } from './teaching-lesson-roles-fixture.mjs'
export const readCourseModuleMigration = name => readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')

// Real current teaching, assessment, journal, homework and private file guards.
// Accounts are fictional, PGlite is in-memory and no network is ever contacted.
export async function courseModulesFixture({ applyModules = true } = {}) {
  const fx=await lessonRoleFixture()
  try {
    for(const name of ['202611040010_teaching_tests.sql','202611040011_teaching_journal_preferences_absence.sql',
      '202611040012_profile_name_parts.sql','202611040020_assessment_bank_variants.sql',
      '202611040021_teaching_rubrics.sql','202611040022_rubric_correction_publication.sql',
      '202611040040_teaching_lesson_roles.sql']) await fx.db.exec(await readCourseModuleMigration(name))
    if(applyModules) await fx.db.exec(await readCourseModuleMigration('202611040050_teaching_course_modules.sql'))
    return fx
  } catch(error) {await fx.close();throw error}
}
