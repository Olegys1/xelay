import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.notification-center-preview.local')
const argument = process.argv.indexOf('--port'), port = argument < 0 ? 3092 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Сповіщення та підказки</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), `import React from'react'
import{createRoot}from'react-dom/client'
import'../src/index.css'
import{SeasonalThemePreviewProvider}from'../src/context/ThemeContext'
import{ToastProvider}from'../src/context/ToastContext'
import{LocalNotificationCenterPreview}from'../src/components/LocalNotificationCenterPreview'
const root=import.meta.hot?.data.xelayPreviewRoot||createRoot(document.getElementById('root')!);if(import.meta.hot)import.meta.hot.data.xelayPreviewRoot=root;
root.render(<React.StrictMode><SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><LocalNotificationCenterPreview/></ToastProvider></SeasonalThemePreviewProvider></React.StrictMode>)`)
if (process.argv.includes('--prepare-only')) process.exit(0)
const { notificationCenterFixture } = await import('./security/notification-center-fixture.mjs')
const { seedNotificationCenterPreview } = await import('./security/notification-center-preview-seed.mjs')
const { createPreviewNotificationMail } = await import('./security/notification-center-preview-mail.mjs')
const fixture = await notificationCenterFixture()
const seed = await seedNotificationCenterPreview(fixture)
const mail = await createPreviewNotificationMail(fixture, 'http://127.0.0.1:'+port)
const { db, ids, groups } = fixture
const roles = { teacher: ids.owner, student: ids.studentA, head: ids.headA, other: ids.studentB }
const names = { teacher: 'Олена Прикладенко', student: 'Марія Прикладенко', head: 'Андрій Прикладенко', other: 'Данило Прикладенко' }
const signatures = {
 xelay_notification_center:['p_filters','p_cursor','p_limit','p_expected_user_id'],
 xelay_notification_counts:['p_expected_user_id'],xelay_notification_mark_read:['p_ids','p_expected_user_id'],
 xelay_notification_acknowledge:['p_notification_id','p_expected_user_id'],
 xelay_notification_preferences_save:['p_settings','p_expected_user_id'],
 xelay_teaching_announcement_audience:['p_course_id','p_targets','p_expected_user_id'],
 xelay_teaching_announcement_receipts:['p_announcement_id','p_expected_user_id'],
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
  xelay_teaching_rubric: ['p_assignment_id', 'p_group_id'], xelay_teaching_rubric_mutate: ['p_action', 'p_payload'],
}
let queue = Promise.resolve()
function serialized(operation) { const result = queue.then(operation); queue = result.catch(() => {}); return result }
const reply = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)) }
const blocked = '\0xelay-notification-center-isolated'
const transport = `const deny=()=>{throw Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc:(name,args={})=>{let signal;const request={abortSignal(value){signal=value;return request},then(resolve,reject){const role=sessionStorage.getItem('xelay-notification-center-preview-role')||'teacher';return fetch('/__notification-center/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role,name,args}),signal}).then(response=>response.json()).then(resolve,reject)}};return request},from:deny,channel:()=>{const channel={on:()=>channel,subscribe:()=>channel};return channel},removeChannel:()=>{},storage:new Proxy({},{get:()=>deny}),auth:new Proxy({},{get:()=>deny})}`

const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules/.vite-teaching-notification-center-v2'), optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'lucide-react', 'xlsx'] },
  plugins: [react(), { name: 'notification-center-isolated', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return null
    const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
    return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
  }, load(id) { return id === blocked ? transport : null }, configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = req.url?.split('?')[0]
      if (!url?.startsWith('/__notification-center/')) return next()
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { error: { message: 'PREVIEW_ORIGIN_DENIED' } })
      try {
        if (url === '/__notification-center/config' && req.method === 'GET') return reply(res, 200, { courseId: ids.course, groupId: groups[0], otherGroupId: groups[1], ...seed, roles: Object.fromEntries(Object.entries(roles).map(([role, userId]) => [role, { userId, fullName: names[role] }])) })
        if(url === '/__notification-center/preferences' && req.method === 'GET') {
 const role=new URL(req.url,'http://127.0.0.1:'+port).searchParams.get('role');if(!Object.hasOwn(roles,role))throw Error('PREVIEW_ROLE_DENIED')
 const data=await serialized(async()=>{const result=await db.query('select notifications_enabled,email_notifications_enabled,category_settings from notification_preferences where user_id=$1',[roles[role]]);return result.rows[0]||{notifications_enabled:true,email_notifications_enabled:true,category_settings:{}}});return reply(res,200,{data,error:null})
}
if(url === '/__notification-center/mail' && req.method === 'POST'){
 let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024)throw Error('PREVIEW_REQUEST_TOO_LARGE')};const input=JSON.parse(raw);
 if(!Object.hasOwn(roles,input.role))throw Error('PREVIEW_ROLE_DENIED');const results=await serialized(()=>mail.deliver(roles[input.role],input.daily===true));return reply(res,200,{data:mail.messages.filter(row=>row.recipient===roles[input.role]),results,error:null})
}
if (url !== '/__notification-center/rpc' || req.method !== 'POST') return reply(res, 404, { error: { message: 'PREVIEW_ROUTE_UNKNOWN' } })
        let raw = ''
        for await (const chunk of req) { raw += chunk; if (raw.length > 2 * 1024 * 1024) throw Error('PREVIEW_REQUEST_TOO_LARGE') }
        const request = JSON.parse(raw)
        if (!Object.hasOwn(roles, request.role) || !Object.hasOwn(signatures, request.name) || !request.args || typeof request.args !== 'object') throw Error('PREVIEW_RPC_DENIED')
        const parameters = signatures[request.name]
        if (Object.keys(request.args).some(key => !parameters.includes(key))) throw Error('PREVIEW_RPC_ARGUMENT_DENIED')
        const values = parameters.map(key => {
          const value = request.args[key] ?? null
          if (['p_module_ids', 'p_activity_ids','p_ids'].includes(key) && Array.isArray(value)) {
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
console.log(`http://127.0.0.1:${port}/.notification-center-preview.local/index.html`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().then(() => db.close()).finally(() => process.exit(0)) })
