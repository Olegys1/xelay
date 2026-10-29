import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const nativeRequire = createRequire(import.meta.url)
const React = nativeRequire('react')
const { renderToStaticMarkup } = nativeRequire('react-dom/server')
const jsx = nativeRequire('react/jsx-runtime')

function load(name, react = React) {
  const source = readFileSync(resolve(root, 'src/components/birthday', name), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require(id) {
    if (id.endsWith('.css')) return {}
    assert.ok(['react', 'react/jsx-runtime', 'lucide-react'].includes(id), 'Unexpected dependency: ' + id)
    return id === 'react' ? react : id === 'react/jsx-runtime' ? jsx : nativeRequire(id)
  } })
  return module.exports
}
const { BirthdayProfileSettings } = load('BirthdayProfileSettings.tsx')
const { GroupBirthdayList } = load('GroupBirthdayList.tsx')
const { BirthdayGiftReminder } = load('BirthdayGiftReminder.tsx')
const { BirthdayGiftCard } = load('BirthdayGiftCard.tsx')
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props))
const empty = { day: null, month: null, showToGroup: false }
const noop = () => {}
const plain = value => JSON.parse(JSON.stringify(value))

test('birthday settings collect only day and month, with the group opt-in visibly off by default', () => {
  const html = render(BirthdayProfileSettings, { value: empty, onChange: noop, onSave: noop })
  assert.equal([...html.matchAll(/<select\b/g)].length, 2)
  assert.doesNotMatch(html, /type="date"|type="number"|name="(?:birth_year|age|year)"|value="(?:19|20)\d{2}"/)
  const checkbox = html.match(/<input\b[^>]*type="checkbox"[^>]*>/)?.[0]
  assert.ok(checkbox)
  assert.doesNotMatch(checkbox, /\bchecked/)
  assert.match(html, /Рік народження та вік не запитуємо/)
  assert.match(html, /Видимість для групи на подарунок не впливає/)
  assert.match(html, /Дата та видимість зберігаються кнопкою «Зберегти дату»/)
  assert.doesNotMatch(html, /У роки без 29 лютого/)
  assert.match(html, /<button[^>]*disabled=""[^>]*>Зберегти дату/)
})

test('month choices allow leap day, constrain April and refuse an incomplete or impossible saved date', () => {
  const february = render(BirthdayProfileSettings, { value: { day: 29, month: 2, showToGroup: false }, onChange: noop, onSave: noop })
  assert.match(february, /<option value="29" selected="">29<\/option>/)
  assert.match(february, /У роки без 29 лютого привітаємо тебе 28 лютого/)
  const februaryDays = february.match(/<select[^>]*id="[^"]*-day"[^>]*>(.*?)<\/select>/)?.[1]
  assert.doesNotMatch(februaryDays, /value="30"|value="31"/)
  const april = render(BirthdayProfileSettings, { value: { day: 31, month: 4, showToGroup: true }, onChange: noop, onSave: noop })
  const aprilDays = april.match(/<select[^>]*id="[^"]*-day"[^>]*>(.*?)<\/select>/)?.[1]
  assert.doesNotMatch(aprilDays, /value="31"/)
  assert.match(april, /<button[^>]*disabled=""[^>]*>Зберегти дату/)
  assert.match(april, /<input[^>]*checked=""/)
})

test('changing month clears an invalid day without silently changing the birthday to another date', () => {
  let changed
  const { BirthdayProfileSettings: Fields } = load('BirthdayProfileSettings.tsx', { useId: () => 'test-birthday' })
  const tree = Fields({ value: { day: 31, month: 1, showToGroup: false }, onChange: next => { changed = next } })
  const walk = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(walk)]
  const nodes = walk(tree)
  const select = nodes.find(node => node.type === 'select' && node.props.id === 'test-birthday-month')
  assert.ok(select)
  select.props.onChange({ target: { value: '4' } })
  assert.deepEqual(plain(changed), { day: null, month: 4, showToGroup: false })
})

test('loading and saving expose their status and prevent controls from submitting another mutation', () => {
  const loading = render(BirthdayProfileSettings, { value: empty, onChange: noop, loading: true })
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /role="status"/)
  assert.doesNotMatch(loading, /<select/)
  const saving = render(BirthdayProfileSettings, { value: { day: 29, month: 10, showToGroup: true }, onChange: noop, onSave: noop, onRemove: noop, saving: true })
  assert.match(saving, /<fieldset[^>]*disabled=""/)
  assert.ok([...saving.matchAll(/<button\b([^>]*)>/g)].every(match => match[1].includes('disabled=""')))
  const error = render(BirthdayProfileSettings, { value: empty, onChange: noop, error: 'Synthetic failure' })
  assert.match(error, /role="alert">Synthetic failure/)
})

test('the compact group card lists only supplied members and never prints an age or birth year', () => {
  const html = render(GroupBirthdayList, { members: [
    { userId: 'fixture-tomorrow', name: 'Synthetic Tomorrow', day: 30, month: 10, isToday: false, daysUntil: 1 },
    { userId: 'fixture-today', name: 'Synthetic Today', day: 29, month: 10, isToday: true, daysUntil: 0 },
  ] })
  assert.ok(html.indexOf('Synthetic Today') < html.indexOf('Synthetic Tomorrow'))
  assert.match(html, /Сьогодні день народження/)
  assert.match(html, /30 жовтня/)
  assert.match(html, /Завтра/)
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /2000|2026|років|рочків/)
  assert.doesNotMatch(html, /dialog|aria-modal/)
  assert.match(html, /Тільки ті, хто сам дозволив показувати дату/)
})

test('empty and unavailable group data do not invent birthdays or turn into a full-screen popup', () => {
  const emptyCard = render(GroupBirthdayList, { members: [] })
  assert.match(emptyCard, /Тут з’являться дні народження/)
  assert.doesNotMatch(emptyCard, /<li\b|dialog|aria-modal/)
  const error = render(GroupBirthdayList, { members: [], error: 'Synthetic failure', onRetry: noop })
  assert.match(error, /role="alert">Synthetic failure/)
  assert.match(error, /Спробувати ще раз/)
  const reminder = render(BirthdayGiftReminder, { recipientName: 'Synthetic Person', onOpen: noop })
  assert.match(reminder, /<aside/)
  assert.match(reminder, /Мій подарунок/)
  assert.doesNotMatch(reminder, /dialog|aria-modal/)
})

test('loading or failed group reload does not show a birthday indicator or stale member from the prior group', () => {
  const stale = [{ userId: 'previous-group-member', name: 'Previous Group Name', day: 29, month: 10, isToday: true, daysUntil: 0 }]
  for (const state of [{ loading: true }, { error: 'Synthetic failure' }]) {
    const html = render(GroupBirthdayList, { members: stale, ...state })
    assert.doesNotMatch(html, /Previous Group Name|Сьогодні є іменинники|bp-today-dot|bp-birthday-today/)
  }
})

test('the gift uses a simple claim action while keeping the month benefit and payment explanation', () => {
  const html = render(BirthdayGiftCard, { recipientName: 'Synthetic', onClaim: noop })
  assert.match(html, /Забрати подарунок/)
  assert.doesNotMatch(html, /Забрати місяць/)
  assert.match(html, /1 місяць «Учасника»/)
  assert.match(html, /Без оплати та автопродовження/)
})
