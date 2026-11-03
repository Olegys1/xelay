import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const [legalSource, pricing, settings] = await Promise.all([
  read('src/lib/legal.ts'), read('src/pages/SubscriptionPage.tsx'), read('src/components/NotificationPanel.tsx'),
])
const compiled = ts.transpileModule(legalSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const legal = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))

test('published subscription terms separate free email delivery from paid organizer and push', () => {
  const terms = legal.getLegalPage('terms')
  const paid = terms.sections.find(section => section.title.startsWith('2.')).paragraphs.join(' ')
  const free = terms.sections.find(section => section.title.startsWith('3.')).paragraphs.join(' ')
  assert.equal(terms.updatedAt, '4 листопада 2026 року')
  assert.equal(legal.LEGAL_TERMS_VERSION, '2026-11-04.1')
  assert.match(paid, /100 грн за один календарний місяць/)
  assert.match(paid, /нагадування також надходять на підтверджену електронну адресу без окремої плати/)
  assert.match(paid, /Для push потрібні.*активна підписка «Учасник»/)
  assert.match(free, /Підтверджені викладачі користуються кабінетом викладача без підписки/)
  assert.match(free, /Поштові сповіщення Xelay доступні без підписки.*нагадування про дедлайни/)
  assert.doesNotMatch(paid + pricing, /особисті нагадування не надсилаємо|Особисті нагадування не надсилаються поштою/)
})

test('the free pricing card and notification settings both disclose free email', () => {
  assert.match(pricing, /Сповіщення на пошту безкоштовні/)
  assert.match(pricing, /Push-нагадування особистого органайзера/)
  assert.match(settings, /Поштові сповіщення безкоштовні/)
  assert.match(settings, /нагадування входять до підписки «Учасник»/)
})
