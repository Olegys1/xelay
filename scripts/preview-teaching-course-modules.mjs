import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const examControls = process.argv.includes('--exam-controls')
const lectureCourse = process.argv.includes('--lecture-course')
const richTests = process.argv.includes('--rich-tests')
if ([examControls, lectureCourse, richTests].filter(Boolean).length > 1) throw Error('Choose one preview')
const directoryName = richTests ? '.teaching-rich-tests-preview.local' : lectureCourse ? '.teaching-lecture-course-preview.local' : examControls ? '.teaching-exam-controls-preview.local' : '.teaching-course-modules-preview.local'
const directory = path.join(root, directoryName)
const argument = process.argv.indexOf('--port'), port = argument < 0 ? 3090 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), `<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · ${richTests ? 'Новий екран тестів' : lectureCourse ? 'Лекції й тести' : examControls ? 'Правила тестів' : 'Модулі та прогрес'}</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`)
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
const { addPreviewLectureFile } = await import('./security/lecture-course-preview-seed.mjs')
const clips = new Map(), signedClips = new Map()
const lecture = lectureCourse ? { clips, duration: 14, bytes: await readFile(path.join(directory, 'lecture-sample.mp4')) } : undefined
const richPhotos = richTests ? { parabola: await readFile(path.join(directory, 'parabola.jpg')), line: await readFile(path.join(directory, 'line.jpg')) } : undefined
const fixture = await courseModulesFixture({ additionalMigrations: [
  '202611040060_teaching_test_admission.sql', '202611050061_teaching_test_explicit_close.sql', '202611050070_teaching_personal_journal_view.sql',
  ...(examControls || lectureCourse || richTests ? ['202611060010_teaching_test_integrity.sql', '202611060020_teaching_test_manual_variants.sql', '202611060030_teaching_test_question_images.sql'] : []),
  ...(lectureCourse ? ['202611060040_teaching_module_lectures.sql'] : []),
  ...(richTests ? ['202611060050_teaching_test_rich_content.sql'] : []),
] })
const seed = await seedCourseModulesPreview(fixture, { advanced: true, examControls, lecture, richPhotos })
const { db, ids, groups } = fixture
const roles = { teacher: ids.owner, student: ids.studentA, head: ids.headA, other: ids.studentB }
const names = richTests ? { teacher: 'Олена Савчук', student: 'Марія Коваленко', head: 'Андрій Бондаренко', other: 'Данило Мельник' }
  : { teacher: 'Олена Прикладенко', student: 'Марія Прикладенко', head: 'Андрій Прикладенко', other: 'Данило Прикладенко' }
const signatures = {
  xelay_teaching_course_modules: ['p_course_id'], xelay_teaching_course_module_save: ['p_payload'],
  xelay_teaching_course_modules_reorder: ['p_course_id', 'p_module_ids', 'p_versions', 'p_expected_user_id'],
  xelay_student_course_modules: ['p_course_id', 'p_group_id'], xelay_student_module_acknowledge: ['p_item_id', 'p_group_id', 'p_expected_user_id'],
  xelay_student_module_lecture_progress: ['p_item_id', 'p_group_id', 'p_expected_user_id', 'p_position_seconds', 'p_expected_storage_path'],
  xelay_teaching_module_lecture_statistics: ['p_module_id', 'p_group_id'],
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
async function bodyBytes(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Error('PREVIEW_REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function sendClip(req, res, clip) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
  const first = range ? Number(range[1]) : 0
  const last = range?.[2] ? Math.min(Number(range[2]), clip.bytes.length - 1) : clip.bytes.length - 1
  if (first > last) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${clip.bytes.length}`); return res.end() }
  res.statusCode = range ? 206 : 200
  res.setHeader('Content-Type', clip.mime)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', last - first + 1)
  if (range) res.setHeader('Content-Range', `bytes ${first}-${last}/${clip.bytes.length}`)
  res.end(req.method === 'HEAD' ? undefined : clip.bytes.subarray(first, last + 1))
}
const blocked = '\0xelay-course-modules-isolated'
const transport = `const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};const actor=()=>sessionStorage.getItem('xelay-course-modules-preview-role')||'teacher';const roles=${JSON.stringify(roles)};export const supabase={rpc(name,args={}){const role=actor();const send=async signal=>{try{return await(await fetch('/__course-modules/rpc',{signal,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,name,args})})).json()}catch(error){return{data:null,error:{message:error.message}}}};return {then:(resolve,reject)=>send().then(resolve,reject),abortSignal:send}},from:deny,channel:deny,storage:new Proxy({},{get:()=>deny}),auth:{getSession:async()=>({data:{session:${lectureCourse}&&Object.hasOwn(roles,actor())?{user:{id:roles[actor()]},access_token:'synthetic-course-preview-token'}:null},error:null})}}`
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teaching-course-modules-v2'), optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'xlsx'] },
  plugins: [react(), { name: 'course-modules-isolated', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? transport : null }, configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
      const url = requestUrl.pathname
      if (!url.startsWith('/__course-modules/') && !(lectureCourse && url === '/api/assistant')) return next()
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { error: { message: 'PREVIEW_ORIGIN_DENIED' } })
      try {
        if (url === '/__course-modules/config' && req.method === 'GET') return reply(res, 200, { courseId: ids.course, groupId: groups[0], otherGroupId: groups[1], examControls, lectureCourse, richTests, ...seed, roles: Object.fromEntries(Object.entries(roles).map(([role, userId]) => [role, { userId, fullName: names[role] }])) })
        if (lectureCourse && url === '/api/assistant' && req.method === 'POST') {
          const request = JSON.parse(await bodyBytes(req, 900000))
          if (requestUrl.searchParams.get('route') !== 'tests/import-preview' || req.headers.authorization !== 'Bearer synthetic-course-preview-token'
            || request.courseId !== ids.course || request.consent !== true) return reply(res, 403, { error: 'PREVIEW_ASSISTANT_DENIED' })
          return reply(res, 200, {
            userId: ids.owner,
            draftText: '1. Що означає попит?\nA) Готовність покупців придбати товар\nB) Кількість продавців\nC) Витрати виробника\nD) Податок на продаж\nВідповідь: A\nБали: 2',
            notes: ['Локальний приклад розпізнавання. Модель не викликалася.'],
          })
        }
        if (lectureCourse && url === '/__course-modules/lecture-upload' && req.method === 'POST') {
          if (requestUrl.searchParams.get('actor') !== ids.owner || clips.size >= 6) throw Error('PREVIEW_UPLOAD_DENIED')
          const name = requestUrl.searchParams.get('name') || ''
          if (name.length > 240 || !/\.(mp4|webm)$/i.test(name)) throw Error('PREVIEW_VIDEO_TYPE')
          const bytes = await bodyBytes(req, 50 * 1024 * 1024)
          const webm = name.toLowerCase().endsWith('.webm')
          if (bytes.length < 12 || (webm ? bytes.subarray(0, 4).toString('hex') !== '1a45dfa3' : bytes.toString('ascii', 4, 8) !== 'ftyp')) throw Error('PREVIEW_VIDEO_TYPE')
          const file = await serialized(() => addPreviewLectureFile(fixture, clips, bytes, name, webm ? 'video/webm' : 'video/mp4'))
          return reply(res, 200, { file })
        }
        if (lectureCourse && url === '/__course-modules/lecture-url' && req.method === 'POST') {
          const { actor, storagePath } = JSON.parse(await bodyBytes(req, 2000))
          if (!Object.values(roles).includes(actor) || !clips.has(storagePath)) throw Error('PREVIEW_VIDEO_DENIED')
          const result = await serialized(() => fixture.asUser(actor, 'select public.xelay_teaching_can_read_file($1) as allowed', [storagePath]))
          if (!result.rows[0]?.allowed) throw Error('PREVIEW_VIDEO_DENIED')
          const token = randomUUID()
          signedClips.set(token, { storagePath, expiry: Date.now() + 3600000 })
          return reply(res, 200, { url: `/__course-modules/media/${token}` })
        }
        if (lectureCourse && url.startsWith('/__course-modules/media/') && ['GET', 'HEAD'].includes(req.method)) {
          const access = signedClips.get(url.split('/').at(-1))
          if (!access || access.expiry <= Date.now()) return reply(res, 403, { error: 'PREVIEW_VIDEO_DENIED' })
          return sendClip(req, res, clips.get(access.storagePath))
        }
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
