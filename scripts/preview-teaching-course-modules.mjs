import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const examControls = process.argv.includes('--exam-controls')
const directoryName = examControls ? '.teaching-exam-controls-preview.local' : '.teaching-course-modules-preview.local'
const directory = path.join(root, directoryName)
const argument = process.argv.indexOf('--port'), port = argument < 0 ? 3090 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · ${examControls ? 'Правила тестів' : 'Модулі та прогрес'}</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`)
await writeFile(path.join(directory, 'main.tsx'), `import React from'react'
import{createRoot}from'react-dom/client'
import'../src/index.css'
import{SeasonalThemePreviewProvider}from'../src/context/ThemeContext'
import{ToastProvider}from'../src/context/ToastContext'
import{LocalTeachingCourseModulesPreview}from'../src/components/teaching/LocalTeachingCourseModulesPreview'
const root=import.meta.hot?.data.xelayPreviewRoot||createRoot(document.getElementById('root')!);if(import.meta.hot)import.meta.hot.data.xelayPreviewRoot=root;
root.render(<React.StrictMode><SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><LocalTeachingCourseModulesPreview/></ToastProvider></SeasonalThemePreviewProvider></React.StrictMode>)`)
if (process.argv.includes('--prepare-only')) process.exit(0)
const { courseModulesFixture } = await import('./security/teaching-course-modules-fixture.mjs')
const { seedCourseModulesPreview } = await import('./security/course-modules-preview-seed.mjs')
const fixture = await courseModulesFixture({ additionalMigrations: [
  '202611040060_teaching_test_admission.sql', '202611050061_teaching_test_explicit_close.sql', '202611050070_teaching_personal_journal_view.sql',
  ...(examControls ? ['202611060010_teaching_test_integrity.sql', '202611060020_teaching_test_manual_variants.sql', '202611060030_teaching_test_question_images.sql'] : []),
] })
const seed = await seedCourseModulesPreview(fixture, { advanced: true, examControls })
const { db, ids, groups } = fixture
const roles = { teacher: ids.owner, student: ids.studentA, head: ids.headA, other: ids.studentB }
const names = { teacher: 'Олена Прикладенко', student: 'Марія Прикладенко', head: 'Андрій Прикладенко', other: 'Данило Прикладенко' }
const signatures = {
  xelay_teaching_course_modules: ['p_course_id'], xelay_teaching_course_module_save: ['p_payload'],
  xelay_teaching_course_modules_reorder: ['p_course_id', 'p_module_ids', 'p_versions', 'p_expected_user_id'],
  xelay_student_course_modules: ['p_course_id', 'p_group_id'], xelay_student_module_acknowledge: ['p_item_id', 'p_group_id', 'p_expected_user_id'],
  xelay_teaching_workspace: [], xelay_classroom_workspace: [], xelay_teaching_course: ['p_course_id'], xelay_teaching_group: ['p_group_id'],
  xelay_teaching_tests: ['p_course_id', 'p_group_id'], xelay_teaching_test: ['p_test_id'], xelay_teaching_test_mutate: ['p_action', 'p_payload'],
  xelay_teaching_mutate: ['p_action', 'p_payload'], xelay_teaching_classified_activity: ['p_payload'],
  xelay_classroom_assignment: ['p_item_id', 'p_group_id'], xelay_classroom_mutate: ['p_action', 'p_payload'],
  xelay_teaching_classified_assignment: ['p_action', 'p_payload'], xelay_teaching_save_multi_assignment: ['p_payload'],
  xelay_save_teaching_grades_batch: ['p_request_id', 'p_course_id', 'p_group_id', 'p_activity_id', 'p_expected_user_id', 'p_rows'],
  xelay_teaching_audience: ['p_course_id'], xelay_teaching_audience_mutate: ['p_action', 'p_payload'], xelay_teaching_group_announcements: ['p_group_id'],
  xelay_teaching_grade_requests: ['p_course_id'], xelay_group_teacher_materials: ['p_group_id'],
  xelay_group_teacher_assignments: ['p_group_id', 'p_lesson_date'], xelay_teaching_assignment_lessons: ['p_course_id', 'p_group_id', 'p_lesson_date'],
  xelay_teaching_journal_preferences: ['p_course_id', 'p_group_id'], xelay_teaching_save_journal_preferences: ['p_course_id', 'p_group_id', 'p_activity_ids', 'p_version', 'p_expected_user_id'],
  xelay_teaching_save_journal_view: ['p_course_id', 'p_group_id', 'p_settings', 'p_version', 'p_expected_user_id'],
  xelay_teaching_sync_journal_schedule: ['p_course_id', 'p_group_id', 'p_from', 'p_to', 'p_expected_user_id'],
  xelay_teaching_question_bank: ['p_course_id'], xelay_teaching_question_bank_mutate: ['p_action', 'p_payload'],
  xelay_teaching_test_question_image: ['p_image_id'], xelay_teaching_test_question_image_upload: ['p_course_id', 'p_expected_user_id', 'p_data'],
  xelay_teaching_rubric: ['p_assignment_id', 'p_group_id'], xelay_teaching_rubric_mutate: ['p_action', 'p_payload'],
}
let queue = Promise.resolve()
function serialized(operation) { const result = queue.then(operation); queue = result.catch(() => {}); return result }
const reply = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)) }
const blocked = '\0xelay-course-modules-isolated'
const transport = `const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc(name,args={}){const role=sessionStorage.getItem('xelay-course-modules-preview-role')||'teacher';const send=async signal=>{try{return await(await fetch('/__course-modules/rpc',{signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,name,args})})).json()}catch(error){return{data:null,error:{message:error.message}}}};return {then:(resolve,reject)=>send().then(resolve,reject),abortSignal:send}},from:deny,channel:deny,storage:new Proxy({},{get:()=>deny}),auth:new Proxy({},{get:()=>deny})}`
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teaching-course-modules-v2'), optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'xlsx'] },
  plugins: [react(), { name: 'course-modules-isolated', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? transport : null }, configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = req.url?.split('?')[0]
      if (!url?.startsWith('/__course-modules/')) return next()
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { error: { message: 'PREVIEW_ORIGIN_DENIED' } })
      try {
        if (url === '/__course-modules/config' && req.method === 'GET') return reply(res, 200, { courseId: ids.course, groupId: groups[0], otherGroupId: groups[1], examControls, ...seed, roles: Object.fromEntries(Object.entries(roles).map(([role, userId]) => [role, { userId, fullName: names[role] }])) })
        if (url !== '/__course-modules/rpc' || req.method !== 'POST') return reply(res, 404, { error: { message: 'PREVIEW_ROUTE_UNKNOWN' } })
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw Error('PREVIEW_REQUEST_TOO_LARGE') }
        const request = JSON.parse(raw)
        if (!Object.hasOwn(roles, request.role) || !Object.hasOwn(signatures, request.name) || !request.args || typeof request.args !== 'object') throw Error('PREVIEW_RPC_DENIED')
        const parameters = signatures[request.name]
        if (Object.keys(request.args).some(key => !parameters.includes(key))) throw Error('PREVIEW_RPC_ARGUMENT_DENIED')
        const values = parameters.map(key => {
          const value = request.args[key] ?? null
          if (['p_module_ids', 'p_activity_ids'].includes(key) && Array.isArray(value)) {
            if (value.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) throw Error('PREVIEW_ARRAY_INVALID')
            return '{' + value.join(',') + '}'
          }
          return value && typeof value === 'object' ? JSON.stringify(value) : value
        })
        const data = await serialized(() => fixture.rpc(roles[request.role], request.name, values))
        return reply(res, 200, { data, error: null })
      } catch (error) { return reply(res, 200, { data: null, error: { code: error.code || '', message: error.message } }) }
    })
  } }], server: { host: '127.0.0.1', port, strictPort: true, hmr: false, allowedHosts: ['127.0.0.1', 'localhost'] } })
await server.listen()
console.log(`http://127.0.0.1:${port}/${directoryName}/index.html`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().then(() => db.close()).finally(() => process.exit(0)) })
