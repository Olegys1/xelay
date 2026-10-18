import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../../src/components/TimetablePhotoRecognition.tsx', import.meta.url), 'utf8')
const group = '11111111-1111-4111-8111-111111111111'
const candidate = { id: 'c1', group_name: 'МА-2', study_year: 1, study_level: 'bachelor', program: 'Менеджмент', section_label: 'Блок бакалаврату' }
const candidate2 = { ...candidate, id: 'c2', study_level: 'master', section_label: 'Блок магістратури' }
const single = { id: 'single', group_name: '', study_year: null, study_level: null, program: '', section_label: '' }
const analysis = { version: 2, kind: 'source_analysis', layout: 'multiple', candidates: [candidate, candidate2], warnings: [], analysis_token: 'synthetic-token' }
const result = (selection = candidate) => ({ version: 1, source_match: { status: selection.id === 'single' ? 'single_unlabelled' : 'matched', ...Object.fromEntries(Object.entries(selection).filter(([key]) => key !== 'id')) }, week_mode: 'every', days: [1], slots: [{ number: 1, starts_at: '08:00', ends_at: '09:20' }], lessons: [{ weekday: 1, lesson_number: 1, week_pattern: 'every', subject: 'Економічна теорія', lesson_type: 'lecture', location: '', online_url: '', online_url_secondary: '', date_note: '', needs_review: false, review_note: '' }], warnings: [] })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const textOf = tree => tree === undefined || tree === null || typeof tree === 'boolean' ? '' : ['string', 'number'].includes(typeof tree) ? String(tree) : Array.isArray(tree) ? tree.map(textOf).join(' ') : textOf(tree.props?.children)
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const plain = value => JSON.parse(JSON.stringify(value))

function fixture({ user = 'alice', hasDraft = false } = {}) {
  let account = user, index = 0, dirty = false, tree
  const cells = [], effects = [], preparations = [], analyses = [], extractions = [], applies = [], revoked = []
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const hooks = {
    useId() { const i = index++; cells[i] ??= { value: 'photo-' + i }; return cells[i].value },
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, update => { const next = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(cells[i].value, next)) { cells[i].value = next; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  class TimetableRecognitionRequestError extends Error { constructor(message, status) { super(message); this.status = status } }
  const helpers = {
    TimetableRecognitionRequestError,
    timetableRecognitionAvailability: async () => ({ available: true }),
    prepareTimetablePhoto: async (file, options, signal) => { const image = 'data:image/png;base64,prepared-' + (preparations.length + 1); preparations.push({ file, options: plain(options), signal, image }); return image },
    analyzeTimetablePhoto: (groupId, image, signal) => { const operation = { ...deferred(), groupId, image, signal }; analyses.push(operation); return operation.promise },
    recognizeTimetablePhoto: (groupId, image, selection, token, signal) => { const operation = { ...deferred(), groupId, image, selection, token, signal }; extractions.push(operation); return operation.promise },
    timetableSourceMatches: (value, selected) => {
      const match = value.source_match
      return match.status === (selected.id === 'single' ? 'single_unlabelled' : 'matched') && ['group_name', 'study_year', 'study_level', 'program', 'section_label'].every(key => match[key] === selected[key])
    },
  }
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const imports = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': Object.fromEntries(['Check', 'Crop', 'ImagePlus', 'Loader2', 'RotateCw', 'ScanText', 'TriangleAlert', 'X'].map(name => [name, name])), '../context/AuthContext': { useAuth: () => ({ authUser: account ? { id: account } : null }) }, '../lib/studyGroupTimetable': { LESSON_TYPES: { lecture: 'Лекція', seminar: 'Семінар' } }, '../lib/timetableRecognitionClient': helpers }
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(name in imports, name); return imports[name] }, AbortController, Error, URL: { createObjectURL: file => 'blob:' + file.name, revokeObjectURL: url => revoked.push(url) } })
  const props = { groupId: group, destinationName: 'МА-2', destinationCourse: 1, destinationStudyLevel: 'bachelor', destinationProgram: 'Менеджмент', hasDraft, onApply: value => applies.push(value) }
  const render = () => {
    for (let turn = 0; turn < 30; turn++) {
      index = 0; dirty = false; tree = module.exports.TimetablePhotoRecognition(props)
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return tree
    }
    throw Error('Too many component renders')
  }
  const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); return render() }
  const button = label => { const found = nodes(render()).find(node => node.type === 'button' && textOf(node).trim() === label); assert.ok(found, 'Missing button: ' + label); return found }
  const select = label => { const found = nodes(render()).find(node => node.type === 'label' && textOf(node).startsWith(label)); assert.ok(found, 'Missing label: ' + label); return nodes(found).find(node => node.type === 'select') }
  const check = label => { const found = nodes(render()).find(node => node.type === 'label' && textOf(node).includes(label)); assert.ok(found, 'Missing checkbox: ' + label); const input = nodes(found).find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(input); input.props.onChange({ target: { checked: true } }); render() }
  render()
  return { props, preparations, analyses, extractions, applies, revoked, helpers, render, flush, button, select, check,
    get tree() { return tree },
    async upload(name = 'sheet.png') { const input = nodes(render()).find(node => node.type === 'input' && node.props.type === 'file'); input.props.onChange({ target: { files: [{ name, size: 128, type: 'image/png' }], value: 'file' } }); render(); await flush() },
    async click(label) { const selected = button(label); assert.equal(Boolean(selected.props.disabled), false, 'Disabled button: ' + label); selected.props.onClick(); render(); await flush() },
    choose(label, value) { select(label).props.onChange({ target: { value } }); render() },
    async findSources(value = analysis) { await this.click('Знайти групи на фото'); analyses.at(-1).resolve(value); await flush() },
    switchUser(next) { account = next; return render() },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('selecting a photo does not send it; multi-group analysis requires an explicit level/course/group choice', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload()
  assert.equal(fx.analyses.length, 0); assert.equal(fx.extractions.length, 0); assert.equal(fx.applies.length, 0)
  await fx.findSources()
  assert.equal(fx.select('Група та освітня програма на фото').props.value, '')
  assert.equal(fx.button('Розпізнати обраний розклад').props.disabled, true)
  fx.choose('Рівень освіти на фото', 'master'); fx.choose('Курс на фото', '1')
  const options = nodes(fx.select('Група та освітня програма на фото')).filter(node => node.type === 'option')
  assert.equal(options.length, 2); assert.match(textOf(options[1]), /Магістратура.*1 курс/)
  assert.equal(options[1].props.value, 'c2')
  fx.choose('Група та освітня програма на фото', 'c2')
  await fx.click('Розпізнати обраний розклад')
  assert.equal(fx.extractions.length, 1)
  const extraction = fx.extractions[0]
  assert.equal(extraction.groupId, group); assert.equal(extraction.image, fx.analyses[0].image); assert.equal(extraction.image, fx.preparations[0].image)
  assert.deepEqual(plain(extraction.selection), candidate2); assert.equal(extraction.token, analysis.analysis_token)
  assert.equal(fx.applies.length, 0); fx.unmount()
})

test('different source and an existing draft require separate acknowledgements; applying the same result twice is blocked', async () => {
  const fx = fixture({ hasDraft: true }); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c2'); await fx.click('Розпізнати обраний розклад')
  fx.extractions[0].resolve(result(candidate2)); await fx.flush()
  assert.match(textOf(fx.tree), /Підпис обраного розкладу відрізняється/)
  assert.equal(fx.button('Перенести в чернетку').props.disabled, true)
  fx.button('Перенести в чернетку').props.onClick(); assert.equal(fx.applies.length, 0)
  fx.check('Перевірив(-ла) підписи'); assert.equal(fx.button('Перенести в чернетку').props.disabled, true)
  fx.check('Замінити відповідні клітинки'); const apply = fx.button('Перенести в чернетку')
  assert.equal(apply.props.disabled, false); apply.props.onClick(); apply.props.onClick(); fx.render()
  assert.equal(fx.applies.length, 1); assert.match(textOf(fx.tree), /Перенесено в чернетку/); fx.unmount()
})

test('one unlabelled schedule is preselected but cannot apply without ownership confirmation', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources({ ...analysis, layout: 'single', candidates: [single] })
  await fx.click('Розпізнати обраний розклад'); fx.extractions[0].resolve(result(single)); await fx.flush()
  assert.equal(fx.button('Перенести в чернетку').props.disabled, true)
  fx.check('цей розклад без назви групи'); await fx.click('Перенести в чернетку')
  assert.equal(fx.applies.length, 1); fx.unmount()
})

test('a same-named group on the wrong course/degree returned by extraction is blocked in the preview', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  fx.extractions[0].resolve(result(candidate2)); await fx.flush()
  assert.match(textOf(fx.tree), /Група у результаті не збігається/)
  assert.equal(fx.button('Перенести в чернетку').props.disabled, true)
  fx.button('Перенести в чернетку').props.onClick(); assert.equal(fx.applies.length, 0); fx.unmount()
})

test('replacing a photo cancels analysis and a late response cannot select candidates for the new image', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.click('Знайти групи на фото')
  const old = fx.analyses[0]
  await fx.click('Скасувати'); await fx.upload('new-sheet.png'); old.resolve(analysis); await fx.flush()
  assert.equal(old.signal.aborted, true); assert.doesNotMatch(textOf(fx.tree), /1\. Оберіть розклад на фото/)
  assert.equal(fx.preparations.at(-1).file.name, 'new-sheet.png'); assert.equal(fx.extractions.length, 0); fx.unmount()
})

test('rotation and real crop changes invalidate candidates, token and preview result before another request', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  await fx.click('Повернути на 90°')
  assert.equal(fx.preparations.at(-1).options.rotation, 90); assert.doesNotMatch(textOf(fx.tree), /1\. Оберіть розклад на фото/)
  await fx.click('Обрізати фото')
  const left = nodes(fx.tree).find(node => node.type === 'label' && textOf(node).trim() === 'Ліва')
  nodes(left).find(node => node.type === 'input').props.onChange({ target: { value: '25' } }); fx.render(); await fx.flush()
  assert.equal(fx.preparations.at(-1).options.crop.left, 25)
  const preview = nodes(fx.tree).find(node => node.type === 'img')
  assert.equal(preview.props.src, fx.preparations.at(-1).image)
  assert.equal(fx.analyses.length, 1); assert.equal(fx.extractions.length, 0); fx.unmount()
})

test('cancelled extraction and a changed source cannot restore the old lessons', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  const old = fx.extractions[0]; await fx.click('Скасувати'); fx.choose('Група та освітня програма на фото', 'c2')
  old.resolve(result(candidate)); await fx.flush()
  assert.equal(old.signal.aborted, true); assert.doesNotMatch(textOf(fx.tree), /2\. Перевірте результат/); assert.equal(fx.applies.length, 0); fx.unmount()
})

test('changing account or destination group aborts in-flight work and prevents an old apply handler', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  fx.extractions[0].resolve(result(candidate)); await fx.flush()
  const previousApply = fx.button('Перенести в чернетку').props.onClick
  fx.props.groupId = '22222222-2222-4222-8222-222222222222'; fx.render(); previousApply()
  assert.equal(fx.applies.length, 0); assert.doesNotMatch(textOf(fx.tree), /2\. Перевірте результат/)
  await fx.flush(); await fx.upload(); await fx.click('Знайти групи на фото')
  const old = fx.analyses.at(-1); fx.switchUser('bob'); old.resolve(analysis); await fx.flush()
  assert.equal(old.signal.aborted, true); assert.doesNotMatch(textOf(fx.tree), /1\. Оберіть розклад на фото/); fx.unmount()
})

test('expired analysis clears the source selector and requires fresh analysis; unreadable images never expose extraction', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  fx.extractions[0].reject(new fx.helpers.TimetableRecognitionRequestError('Повторіть пошук груп на фото.', 409)); await fx.flush()
  assert.doesNotMatch(textOf(fx.tree), /1\. Оберіть розклад на фото/); assert.match(textOf(fx.tree), /Повторіть пошук/)
  await fx.findSources({ ...analysis, layout: 'unreadable', candidates: [], warnings: ['Дрібний текст неможливо прочитати.'] })
  assert.match(textOf(fx.tree), /чіткіший знімок/)
  assert.ok(!nodes(fx.tree).some(node => node.type === 'button' && textOf(node) === 'Розпізнати обраний розклад')); fx.unmount()
})

test('date/count restrictions and missing times remain visible for review, without automatic saving', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  const parsed = result(candidate); parsed.lessons[0].date_note = 'початок з 01.10.2026 (9 пар)'; parsed.slots[0].starts_at = ''
  fx.extractions[0].resolve(parsed); await fx.flush()
  assert.match(textOf(fx.tree), /Період:.*початок з 01\.10\.2026 \(9 пар\)/)
  assert.match(textOf(fx.tree), /Встановіть окремий період/); assert.match(textOf(fx.tree), /Вкажіть його у блоці/)
  assert.equal(fx.applies.length, 0); fx.unmount()
})

test('a matching group name with unknown degree/course/program still requires explicit identity acknowledgement', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload()
  const unknown = { ...candidate, study_year: null, study_level: null, program: '' }
  await fx.findSources({ ...analysis, layout: 'single', candidates: [unknown] })
  assert.match(textOf(fx.tree), /На фото не визначено\s+курс, рівень освіти, освітню програму/)
  await fx.click('Розпізнати обраний розклад'); fx.extractions[0].resolve(result(unknown)); await fx.flush()
  assert.equal(fx.button('Перенести в чернетку').props.disabled, true)
  fx.button('Перенести в чернетку').props.onClick(); assert.equal(fx.applies.length, 0)
  fx.check('Підтверджую належність розкладу'); await fx.click('Перенести в чернетку')
  assert.equal(fx.applies.length, 1); fx.unmount()
})

test('every result warns to verify all lessons even when no review flags or missing times were found', async () => {
  const fx = fixture(); await fx.flush(); await fx.upload(); await fx.findSources()
  fx.choose('Група та освітня програма на фото', 'c1'); await fx.click('Розпізнати обраний розклад')
  const clean = result(candidate)
  assert.equal(clean.lessons.filter(lesson => lesson.needs_review || !lesson.subject || lesson.date_note).length, 0)
  assert.ok(clean.slots.every(slot => slot.starts_at && slot.ends_at))
  fx.extractions[0].resolve(clean); await fx.flush()
  const warning = /ШІ може помилятися навіть без позначок\. Звірте всі заняття з фото перед додаванням\./
  assert.match(textOf(fx.tree), warning)
  await fx.click('Перенести в чернетку')
  assert.match(textOf(fx.tree), warning); fx.unmount()
})
