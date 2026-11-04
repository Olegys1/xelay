import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { audienceFixture } from './security/teaching-audience-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const assessment = process.argv.includes('--assessment')
const directory = path.join(root, assessment ? '.assessment-phase1-preview.local' : '.teaching-tests-preview.local')
const argument = process.argv.indexOf('--port')
const port = argument < 0 ? assessment ? 3085 : 3084 : Number(process.argv[argument + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Конструктор тестів</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>\n')
await writeFile(path.join(directory, 'main.tsx'), "import React from 'react'\nimport{createRoot}from'react-dom/client'\nimport'../src/index.css'\nimport{ToastProvider}from'../src/context/ToastContext'\nimport{SeasonalThemePreviewProvider}from'../src/context/ThemeContext'\nimport{LocalTeachingTestsPreview}from'../src/components/teaching/LocalTeachingTestsPreview'\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><SeasonalThemePreviewProvider initialTheme='light'><ToastProvider><LocalTeachingTestsPreview/></ToastProvider></SeasonalThemePreviewProvider></React.StrictMode>)\n")
if (process.argv.includes('--prepare-only')) process.exit(0)

// This database contains only synthetic identities and runs in this local process.
const fixture = await audienceFixture()
for (const migration of ['202611030104_academic_notification_priority.sql', '202611030106_teaching_common_deadline_notifications.sql',
  '202611040001_fix_teaching_gradebook_dispatch.sql', '202611040010_teaching_tests.sql',
  '202611040011_teaching_journal_preferences_absence.sql', ...(assessment ? ['202611040020_assessment_bank_variants.sql', '202611040021_teaching_rubrics.sql'] : [])]) {
  await fixture.db.exec(await readFile(path.join(root, 'supabase/migrations', migration), 'utf8'))
}
const { db, ids, groups } = fixture
const roles = { teacher: ids.owner, student: ids.studentA, head: ids.headA, other: ids.studentB }
const names = { teacher: 'Олена Прикладенко', student: 'Марія Прикладенко', head: 'Андрій Прикладенко', other: 'Данило Прикладенко' }
for (const [role, id] of Object.entries(roles)) {
  await db.query('update profiles set full_name=$1 where id=$2', [names[role], id])
  await db.query('update teaching_entries set full_name=$1 where user_id=$2', [names[role], id])
}
await db.query("update teaching_courses set title='Основи економіки',semester='Осінній семестр' where id=$1", [ids.course])
await db.query("update study_groups set group_name='ЕУБ · навчальний приклад' where id=$1", [groups[0]])
await db.query("update study_groups set group_name='Інша група · приклад' where id=$1", [groups[1]])
const option = (id, text) => ({ id, text })
const common = { points: 5, partial_credit: false, time_limit_seconds: 30, buckets: [] }
const questions = [
  { ...common, id: 'demand', kind: 'choice', text: 'Що найточніше описує попит?', options: [option('a', 'Бажання й можливість придбати товар'), option('b', 'Усі вироблені товари'), option('c', 'Витрати підприємства'), option('d', 'Прибуток продавця')], answer: 'a' },
  { ...common, id: 'scarcity', kind: 'boolean', text: 'Економічні ресурси обмежені.', options: [option('true', 'Так'), option('false', 'Ні')], answer: 'true' },
  { ...common, id: 'sort', kind: 'sorting', partial_credit: true, text: 'Розподіліть приклади між ресурсами та результатами виробництва.', options: [option('labour', 'Праця'), option('capital', 'Капітал'), option('goods', 'Товари'), option('services', 'Послуги')], buckets: [option('inputs', 'Ресурси'), option('outputs', 'Результати')], answer: { labour: 'inputs', capital: 'inputs', goods: 'outputs', services: 'outputs' } },
  { ...common, id: 'order', kind: 'sequence', partial_credit: true, text: 'Розташуйте етапи виконання проєкту.', options: [option('analyse', 'Аналіз завдання'), option('plan', 'Планування'), option('do', 'Виконання'), option('check', 'Оцінювання результату')], answer: ['analyse', 'plan', 'do', 'check'] },
]
const now = Date.now()
const { today, yesterday, earlier, exam_day } = (await db.query("select (clock_timestamp() at time zone 'Europe/Kyiv')::date::text today,((clock_timestamp() at time zone 'Europe/Kyiv')::date-1)::text yesterday,((clock_timestamp() at time zone 'Europe/Kyiv')::date-2)::text earlier,((clock_timestamp() at time zone 'Europe/Kyiv')::date+5)::text exam_day")).rows[0]
await fixture.rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify({ id: randomUUID(), version: 0, expected_user_id: ids.owner,
  course_id: ids.course, title: 'Економіка · чотири типи запитань', description: 'Спробуйте тест від імені студентки, потім перевірте результати як викладачка.',
  status: 'published', opens_at: new Date(now - 60000).toISOString(), closes_at: new Date(now + 86400000).toISOString(), duration_seconds: 1200,
  max_points: 20, category: '', journal_date: today, work_type: 'Тест', allow_skip: true, allow_return: true, question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 20, bonus_points: 2,
  targets: [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [] }], questions,
})])

const fictionalNames = ['Софія Прикладенко', 'Максим Зразковий', 'Анастасія Навчальна', 'Дмитро Дослідний', 'Вікторія Тестова',
  'Богдан Прикладенко', 'Катерина Зразкова', 'Назар Навчальний', 'Ірина Дослідна', 'Артем Тестовий']
const template = (await db.query('select university_id,academic_unit_id,specialty_id,account_type,categories,experience from profiles where id=$1', [ids.studentA])).rows[0]
const participants = [{ id: ids.studentA, name: names.student }]
for (const name of fictionalNames) {
  const id = randomUUID()
  await fixture.seedUser(id, { ...template, full_name: name })
  await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())", [groups[0], id, ids.headA])
  participants.push({ id, name })
}
await fixture.mutate(ids.owner, 'sync_roster', { course_id: ids.course, group_id: groups[0] })

// A separate completed work lets the teacher inspect a full class without waiting a day.
const reviewTestId = randomUUID()
await fixture.rpc(ids.owner, 'xelay_teaching_test_mutate', ['save_test', JSON.stringify({ id: reviewTestId, version: 0, expected_user_id: ids.owner,
  course_id: ids.course, title: 'МКР · результати для перевірки', description: 'Одинадцять вигаданих робіт із різними відповідями та часом. Перевірте запитання, затвердьте бонуси й перенесіть бали в журнал.',
  status: 'published', opens_at: new Date(now - 86400000).toISOString(), closes_at: new Date(now + 3600000).toISOString(), duration_seconds: 1200,
  max_points: 20, category: '', journal_date: yesterday, work_type: 'МКР', allow_skip: true, allow_return: true, question_timer_policy: 'continue', restrict_copy: true,
  bonus_percent: 20, bonus_points: 2, targets: [{ group_id: groups[0], audience_mode: 'all', subgroup_ids: [] }], questions,
})])
const responses = [
  ['a', 'true', questions[2].answer, questions[3].answer],
  ['a', 'true', { labour: 'inputs', capital: 'inputs', goods: 'outputs', services: 'inputs' }, questions[3].answer],
  ['a', 'false', questions[2].answer, questions[3].answer],
  ['b', 'true', questions[2].answer, questions[3].answer],
  ['a', 'true', questions[2].answer, ['analyse', 'do', 'plan', 'check']],
  ['b', 'false', questions[2].answer, questions[3].answer],
  [null, 'true', null, null],
  ['a', null, { labour: 'inputs', capital: 'outputs', goods: 'outputs', services: 'inputs' }, ['analyse', 'check', 'do', 'plan']],
  ['d', 'false', { labour: 'outputs', capital: 'outputs', goods: 'inputs', services: 'inputs' }, ['check', 'do', 'plan', 'analyse']],
  [null, null, { labour: 'inputs', capital: 'outputs', goods: 'outputs', services: 'inputs' }, ['plan', 'do', 'analyse', 'check']],
  ['a', 'true', questions[2].answer, questions[3].answer],
]
const elapsed = [480, 290, 150, 180, 340, 120, 90, 260, 70, 310, 240]
for (const [index, participant] of participants.entries()) {
  let detail = await fixture.rpc(participant.id, 'xelay_teaching_test_mutate', ['start', JSON.stringify({ id: reviewTestId, group_id: groups[0] })])
  for (const [questionIndex, question] of questions.entries()) {
    const answer = responses[index][questionIndex]
    if (answer !== null) detail = await fixture.rpc(participant.id, 'xelay_teaching_test_mutate', ['save_answer', JSON.stringify({ id: reviewTestId, version: detail.attempt.version, question_id: question.id, answer })])
    if (questionIndex < questions.length - 1) detail = await fixture.rpc(participant.id, 'xelay_teaching_test_mutate', ['navigate', JSON.stringify({ id: reviewTestId, version: detail.attempt.version, index: questionIndex + 1 })])
  }
  detail = await fixture.rpc(participant.id, 'xelay_teaching_test_mutate', ['finish', JSON.stringify({ id: reviewTestId, version: detail.attempt.version })])
  await db.query("update teaching_test_attempts set started_at=clock_timestamp()-make_interval(secs=>$2::int+120),submitted_at=clock_timestamp()-interval '120 seconds',expires_at=clock_timestamp()-interval '30 seconds',elapsed_seconds=$2 where id=$1", [detail.attempt.id, elapsed[index]])
}
await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '30 seconds' where id=$1", [reviewTestId])

const seminarId = randomUUID()
await fixture.rpc(ids.owner, 'xelay_teaching_classified_activity', [JSON.stringify({ id: seminarId, version: 0, expected_user_id: ids.owner, course_id: ids.course,
  group_id: groups[0], title: 'Семінар · попит і пропозиція', category: '', work_type: 'Семінар', activity_date: earlier, max_points: 5 })])
await fixture.rpc(ids.owner, 'xelay_teaching_classified_activity', [JSON.stringify({ id: randomUUID(), version: 0, expected_user_id: ids.owner, course_id: ids.course,
  group_id: groups[0], title: 'Залік · підсумкова робота', category: '', work_type: 'Залік', activity_date: exam_day, max_points: 20 })])
const seminarEntries = (await db.query('select id,user_id from teaching_entries where course_id=$1 and group_id=$2 and active', [ids.course, groups[0]])).rows
for (const [index, entry] of seminarEntries.entries()) await fixture.mutate(ids.owner, 'save_grade', { activity_id: seminarId, entry_id: entry.id, version: 0,
  score: entry.user_id === ids.headA ? null : 2 + index % 4, absent: entry.user_id === ids.headA, comment: '', reason: '' })

if (assessment) {
  const { seedAssessmentPreview } = await import('./security/assessment-preview-fixture.mjs')
  await seedAssessmentPreview(fixture)
}

const signatures = {
  xelay_teaching_workspace: [], xelay_classroom_workspace: [], xelay_teaching_course: ['p_course_id'], xelay_teaching_group: ['p_group_id'],
  xelay_teaching_tests: ['p_course_id', 'p_group_id'], xelay_teaching_test: ['p_test_id'], xelay_teaching_test_mutate: ['p_action', 'p_payload'],
  xelay_teaching_mutate: ['p_action', 'p_payload'], xelay_teaching_classified_activity: ['p_payload'],
  xelay_save_teaching_grades_batch: ['p_request_id', 'p_course_id', 'p_group_id', 'p_activity_id', 'p_expected_user_id', 'p_rows'],
  xelay_teaching_audience: ['p_course_id'], xelay_teaching_audience_mutate: ['p_action', 'p_payload'], xelay_teaching_group_announcements: ['p_group_id'],
  xelay_teaching_grade_requests: ['p_course_id'], xelay_group_teacher_materials: ['p_group_id'],
  xelay_teaching_journal_preferences: ['p_course_id', 'p_group_id'],
  xelay_teaching_save_journal_preferences: ['p_course_id', 'p_group_id', 'p_activity_ids', 'p_version', 'p_expected_user_id'],
  xelay_teaching_question_bank: ['p_course_id'], xelay_teaching_question_bank_mutate: ['p_action', 'p_payload'],
  xelay_teaching_rubric: ['p_assignment_id', 'p_group_id'], xelay_teaching_rubric_mutate: ['p_action', 'p_payload'],
}
let queue = Promise.resolve()
function serialized(operation) {
  const result = queue.then(operation)
  queue = result.catch(() => {})
  return result
}
const reply = (res, status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(data)) }
async function body(req) {
  let text = ''
  for await (const chunk of req) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error('PREVIEW_REQUEST_TOO_LARGE') }
  return JSON.parse(text)
}
const blocked = '\0xelay-isolated-test-transport'
const transport = `const deny=()=>{throw new Error('LOCAL_PREVIEW_ONLY')};export const supabase={rpc:async(name,args={})=>{try{const response=await fetch('/__test-preview/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:sessionStorage.getItem('xelay-test-preview-role')||'teacher',name,args})});return await response.json()}catch(error){return {data:null,error:{message:error.message}}}},from:deny,channel:deny,storage:new Proxy({},{get:()=>deny}),auth:new Proxy({},{get:()=>deny})};`
const server = await createServer({ root, configFile: false, envDir: path.join(directory, 'no-env'), envPrefix: 'XELAY_UNUSED_PREVIEW_',
  cacheDir: path.join(root, 'node_modules', assessment ? '.vite-assessment-phase1' : '.vite-teaching-tests'),
  optimizeDeps: { entries: [path.relative(root, path.join(directory, 'index.html'))] }, plugins: [react(), {
    name: 'xelay-isolated-tests-preview', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      const candidate = path.resolve(path.dirname(importer.split('?')[0]), source).replaceAll('\\', '/')
      return ['src/lib/supabase', 'src/lib/supabase.ts'].some(file => candidate === path.join(root, file).replaceAll('\\', '/')) ? blocked : null
    },
    load(id) { return id === blocked ? transport : null },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0]
        if (!url?.startsWith('/__test-preview/')) return next()
        const expectedOrigin = `http://127.0.0.1:${port}`
        if (req.headers.origin && req.headers.origin !== expectedOrigin) return reply(res, 403, { error: { message: 'PREVIEW_ORIGIN_DENIED' } })
        try {
          if (url === '/__test-preview/config' && req.method === 'GET') return reply(res, 200, { assessment, courseId: ids.course, groupId: groups[0], otherGroupId: groups[1], roles: Object.fromEntries(Object.entries(roles).map(([role, userId]) => [role, { userId, fullName: names[role] }])) })
          if (url === '/__test-preview/close' && req.method === 'POST') {
            await serialized(() => db.exec("update teaching_tests set closes_at=greatest(clock_timestamp()-interval '1 second',opens_at+interval '1 second') where closes_at>clock_timestamp()"))
            return reply(res, 200, { ok: true })
          }
          if (url !== '/__test-preview/rpc' || req.method !== 'POST') return reply(res, 404, { error: { message: 'PREVIEW_ROUTE_UNKNOWN' } })
          const request = await body(req)
          if (!Object.hasOwn(roles, request.role) || !Object.hasOwn(signatures, request.name) || !request.args || typeof request.args !== 'object') throw new Error('PREVIEW_RPC_DENIED')
          const parameters = signatures[request.name]
          if (Object.keys(request.args).some(key => !parameters.includes(key))) throw new Error('PREVIEW_RPC_ARGUMENT_DENIED')
          const values = parameters.map(key => {
            const value = request.args[key] ?? null
            if (key === 'p_activity_ids' && Array.isArray(value)) {
              if (value.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id))) throw new Error('PREVIEW_ARRAY_INVALID')
              return '{' + value.join(',') + '}'
            }
            return value && typeof value === 'object' ? JSON.stringify(value) : value
          })
          const data = await serialized(() => fixture.rpc(roles[request.role], request.name, values))
          return reply(res, 200, { data, error: null })
        } catch (error) { return reply(res, 200, { data: null, error: { code: error.code || '', message: error.message } }) }
      })
    },
  }], server: { host: '127.0.0.1', port, strictPort: true, hmr: false, allowedHosts: ['127.0.0.1', 'localhost'] } })
await server.listen()
console.log(`http://127.0.0.1:${port}/${path.basename(directory)}/index.html`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void server.close().then(() => fixture.close()).finally(() => process.exit(0)) })
