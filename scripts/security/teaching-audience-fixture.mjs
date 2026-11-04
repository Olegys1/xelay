import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'
const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
export async function audienceFixture({ formatVariant = false, materialSaveFix = true } = {}) {
  const fx = await createTeachingScopedFixture()
  try {
    for (const name of ['202610270001_teaching_group_scopes.sql','202610270002_teaching_multi_group_assignments.sql',
      '202610270003_teaching_material_library.sql','202610270004_teaching_material_library_access.sql',
      '202610270010_student_group_presentations.sql','202610270020_teaching_semesters_group_requests.sql','202610300003_upload_content_quarantine.sql',
      '202611020001_teaching_audiences_announcements.sql','202611020002_teaching_team_submissions.sql',
      '202611030001_fix_group_material_save.sql']) {
      if (!materialSaveFix && name === '202611030001_fix_group_material_save.sql') continue
      if (formatVariant && name === '202611020001_teaching_audiences_announcements.sql') {
        // The read-only production preflight observed these exact statements
        // with one-space indentation. Exercise that known formatting variant,
        // retaining the installed function bodies, permissions and expiry rule.
        for (const signature of ['public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)', 'public.xelay_publish_due_teaching_items()']) {
          const row=(await fx.db.query('select pg_get_functiondef(to_regprocedure($1)) body',[signature])).rows[0]
          const body=row.body.replace(/^[ \t]+(perform public\.xelay_teaching_lock_course\(v_course_id,v_permission\);)$/m,' $1')
            .replace(/^[ \t]+(v_prior:='\[\]'::jsonb;)$/m,' $1')
            .replace(/^[ \t]+(on public\.xelay_teaching_is_member\(t\.group_id,p\.id\) where t\.item_id=v_item\.id)$/m,' $1')
            .replace(/^[ \t]+(and\(v_item\.kind<>'material' or v_item\.access_until is null or v_item\.access_until>clock_timestamp\(\)\))$/m,' $1')
          await fx.db.exec(body)
        }
      }
      const sql=await read(name)
      await fx.db.exec(formatVariant && name.startsWith('20261102') ? sql.replace(/\r?\n/g,'\r\n') : sql)
    }
    return fx
  } catch(error) { await fx.close();throw error }
}
