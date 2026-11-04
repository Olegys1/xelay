// Current React handlers, isolated synthetic responses. No live RPC or browser data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/components/teaching/TeachingCalendar.tsx', import.meta.url), 'utf8')
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const expand = node => node == null || typeof node !== 'object' ? node : Array.isArray(node) ? node.map(expand) : typeof node.type === 'function' ? expand(node.type(node.props)) : { ...node, props: { ...node.props, children: expand(node.props?.children) } }
const assignment = changes => ({ id: 'homework-one', title: 'Попит та пропозиція', body: 'Розв’язати задачі 1–3.\nПідготувати пояснення.', due_at: '2026-11-05T18:00:00Z', source: 'teacher', ...changes })
const lesson = changes => ({ id: 'schedule-one', course_id: 'course-one', course_title: 'Економіка', group_id: 'group-one', group_name: 'ЕУБ-4', subject_name: 'Економіка', lesson_date: '2026-11-04', starts_at: '09:40:00', ends_at: '11:00:00', lesson_type: 'seminar', location: null, assigned_to_me: true, source: 'timetable', homework: [], homework_count: 0, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function harness(repository, initial = {}) {
  const cells = [], effects = [], visibility = [], opens = []
  let index = 0, dirty = false, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useMemo(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn }; return cells[i].value },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
    '../../lib/assistant-v2/pageContext': { publishAssistantPageContext() {}, releaseAssistantPageContext() {} },
    '../../lib/seminars': { kyivToday: () => '2026-11-04', seminarStartMilliseconds: ({ lesson_date, starts_at }) => Date.parse(`${lesson_date}T${starts_at}Z`) },
    '../../lib/studyGroupTimetable': { LESSON_TYPES: { seminar: 'Семінар', lecture: 'Лекція' }, addTimetableDays: (from, days) => { const date = new Date(`${from}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) } },
    '../../lib/teaching': { teachingDate: value => value || '', teachingError: failure => failure.message },
    '../../lib/useTeachingVisibilityRefresh': { useTeachingVisibilityRefresh: callback => { visibility[0] = callback } },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', teachingInput: 'input' },
    './TeachingLessonRoleSettings': { TeachingLessonRoleSettings: 'TeachingLessonRoleSettings' },
    './teaching-workflow.css': {}, '../../lib/teachingHomeNavigation': { teachingHomeDate: date => date },
  }
  const module = { exports: {} }
  const code = ts.transpileModule(source + '\nexport { TeachingCalendarHomework };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { module, exports: module.exports, Date, Intl, encodeURIComponent, window: { setInterval: () => 1, clearInterval() {} }, require: name => { assert.ok(name in imports, 'Explicit synthetic import: ' + name); return imports[name] } })
  const props = { repository, userId: 'teacher-one', courses: [{ id: 'course-one', title: 'Економіка', semester: 'Осінь' }], onOpenJournal: value => opens.push(value), ...initial }
  const render = () => { for (let pass = 0; pass < 20; pass++) { dirty = false; index = 0; tree = expand(module.exports.TeachingCalendar(props)); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Synthetic hooks did not settle') }
  render()
  return { props, opens, get tree() { return tree }, render, pure: value => expand(module.exports.TeachingCalendarHomework({ lesson: value })),
    async settle() { for (let pass = 0; pass < 15; pass++) { await Promise.resolve(); render() } },
    refresh: () => visibility[0](), unmount: () => cells.forEach(cell => cell?.cleanup?.()),
  }
}
const articles = h => nodes(h.tree).filter(node => node.type === 'article')

test('legacy calendar data does not claim no homework; an enriched empty occurrence does', () => {
  const h = harness({ teacherCalendar: async () => ({ lessons: [] }) })
  assert.equal(h.pure(lesson({ homework: undefined, homework_count: undefined })), null)
  assert.match(text(h.pure(lesson())), /Опублікованих завдань до цієї пари немає/)
  assert.equal(nodes(h.pure(lesson())).filter(node => node.type === 'a').length, 0)
  h.unmount()
})

test('each lesson renders its own homework, source, full short body, deadline and safe group destination', async () => {
  const calls = []
  const rows = [lesson({ homework: [assignment({}), assignment({ id: 'group-work', title: 'Вивчити конспект', source: 'group', body: 'Тема 4', due_at: null })], homework_count: 2 }), lesson({ id: 'another-schedule', group_id: 'another-group', subject_name: 'Математика', homework: [assignment({ id: 'math-work', title: 'Інтеграли', audience_label: 'Обрані підгрупи' })], homework_count: 1 })]
  const h = harness({ teacherCalendar: async (...args) => { calls.push(args); return { lessons: rows } } }); await h.settle()
  assert.equal(articles(h).length, 2)
  assert.match(text(articles(h)[0]), /Що задано\s+· 2/)
  assert.match(text(articles(h)[0]), /Попит та пропозиція/)
  assert.match(text(articles(h)[0]), /Розв’язати задачі 1–3\.\nПідготувати пояснення\./)
  assert.match(text(articles(h)[0]), /Здати до 2026-11-05T18:00:00Z/)
  assert.match(text(articles(h)[0]), /Із розкладу групи/)
  assert.match(text(articles(h)[0]), /Без строку здачі/)
  assert.doesNotMatch(text(articles(h)[0]), /Інтеграли/)
  assert.match(text(articles(h)[1]), /Інтеграли/)
  assert.match(text(articles(h)[1]), /Обрані підгрупи/)
  assert.doesNotMatch(text(articles(h)[1]), /Вивчити конспект/)
  assert.equal(nodes(articles(h)[0]).find(node => node.type === 'a').props.href, '/groups/group-one?teaching=course-one')
  assert.deepEqual(calls, [['2026-11-04', '2026-11-10']], 'One authorized calendar read supplies every card')
  await h.refresh(); await h.settle(); assert.equal(calls.length, 2)
  h.unmount()
})

test('bounded calendar summaries preserve exact total and clearly identify truncated text', () => {
  const h = harness({ teacherCalendar: async () => ({ lessons: [] }) })
  const tree = h.pure(lesson({ homework: [assignment({ body: 'Початок довгого завдання', body_truncated: true })], homework_count: 12 }))
  assert.match(text(tree), /Що задано\s+· 12/)
  assert.match(text(tree), /Ще\s+11\s+завдань/)
  assert.match(text(tree), /Тут показано початок опису/)
  assert.equal(nodes(tree).filter(node => node.type === 'details').length, 1)
  const unsafe = h.pure(lesson({ group_id: 'group/?outside=x', homework: [assignment({ title: '<img src=x onerror=alert(1)>', body: '<script>unsafe()</script>' })], homework_count: 1 }))
  assert.ok(nodes(unsafe).every(node => !node.props?.dangerouslySetInnerHTML && node.type !== 'script' && node.type !== 'img'))
  assert.equal(nodes(unsafe).find(node => node.type === 'a').props.href, '/groups/group%2F%3Foutside%3Dx?teaching=course-one')
  h.unmount()
})

test('account or repository replacement immediately hides old homework and ignores late responses', async () => {
  const requests = [], repository = { teacherCalendar: () => { const request = deferred(); requests.push(request); return request.promise } }
  const h = harness(repository)
  requests[0].resolve({ lessons: [lesson({ homework: [assignment({ title: 'FIRST_ACCOUNT_PRIVATE' })], homework_count: 1 })] }); await h.settle()
  assert.match(text(h.tree), /FIRST_ACCOUNT_PRIVATE/)
  h.props.userId = 'teacher-two'; h.render(); assert.doesNotMatch(text(h.tree), /FIRST_ACCOUNT_PRIVATE/)
  const next = deferred(); h.props.repository = { teacherCalendar: () => next.promise }; h.render()
  requests[1].resolve({ lessons: [lesson({ homework: [assignment({ title: 'LATE_ACCOUNT_PRIVATE' })], homework_count: 1 })] }); await h.settle()
  assert.doesNotMatch(text(h.tree), /LATE_ACCOUNT_PRIVATE/)
  next.resolve({ lessons: [lesson({ homework: [assignment({ title: 'CURRENT_AUTHORIZED_HOMEWORK' })], homework_count: 1 })] }); await h.settle()
  assert.match(text(h.tree), /CURRENT_AUTHORIZED_HOMEWORK/)
  assert.doesNotMatch(text(h.tree), /FIRST_ACCOUNT_PRIVATE|LATE_ACCOUNT_PRIVATE/)
  h.unmount()
})

test('a failed calendar refresh hides stale homework rather than presenting it as current', async () => {
  let fail = false
  const h = harness({ teacherCalendar: async () => { if (fail) throw Error('Тимчасово не вдалося оновити'); return { lessons: [lesson({ homework: [assignment({ title: 'OLD_HOMEWORK' })], homework_count: 1 })] } } }); await h.settle()
  assert.match(text(h.tree), /OLD_HOMEWORK/)
  fail = true; await h.refresh(); await h.settle()
  assert.doesNotMatch(text(h.tree), /OLD_HOMEWORK|Опублікованих завдань до цієї пари немає/)
  assert.match(text(h.tree), /Тимчасово не вдалося оновити/)
  h.unmount()
})
