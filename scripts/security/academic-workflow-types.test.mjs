import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

test('academic workflow production components typecheck with their real dependency graph', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined, 'TypeScript configuration must load')
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.equal(parsed.errors.length, 0, 'TypeScript configuration must parse')
  const files = ['src/vite-env.d.ts', 'src/components/AcademicDepartmentSelect.tsx', 'src/components/AuthModal.tsx',
    'src/components/GroupTimetable.tsx', 'src/components/StudyGroupCourseCard.tsx', 'src/components/AdminStudyGroupIdentityReviews.tsx',
    'src/components/schedule/ScheduleAdditionalLinksFields.tsx', 'src/components/teaching/TeachingAssignmentDeadlineFields.tsx',
    'src/components/teaching/TeachingGroupDirectoryPicker.tsx', 'src/components/teaching/TeachingCourseForms.tsx',
    'src/components/teaching/GroupTeachingPanel.tsx', 'src/components/teaching/TeachingAssignmentLessonFields.tsx',
    'src/components/teaching/TeachingLessonAssignments.tsx', 'src/components/teaching/TeachingMultiAssignmentTargets.tsx',
    'src/components/teaching/TeachingPublications.tsx', 'src/components/teaching/TeachingSubmissionPanel.tsx',
    'src/pages/StudyGroupsPage.tsx', 'src/pages/AdminPage.tsx']
  const program = ts.createProgram(files.map(name => path.join(root, name)), parsed.options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const format = ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n' })
  assert.equal(diagnostics.length, 0, format)
})
