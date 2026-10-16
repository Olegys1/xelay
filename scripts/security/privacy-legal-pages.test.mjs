// Public document/content checks only. No production database, payment or mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64')
const legalUrl = asModule(await readFile(new URL('src/lib/legal.ts', root), 'utf8'))
const legal = await import(legalUrl)
const renderer = await import(asModule((await readFile(new URL('scripts/legalHtml.ts', root), 'utf8'))
  .replace("from '../src/lib/legal'", 'from ' + JSON.stringify(legalUrl))))
const privacyKinds = ['privacy-policy', 'personal-data-consent']
const plain = kind => legal.getLegalPage(kind).sections.flatMap(section => [section.title, ...(section.paragraphs || []), ...(section.items || [])]).join('\n')

test('all public legal pages use the corrected support email and mailto target', () => {
  assert.equal(legal.legalMerchant.email, 'mmv04042008@gmail.com')
  for (const kind of renderer.legalPageKinds) {
    const html = renderer.renderLegalHtml(kind)
    assert.ok(html.includes('href="mailto:mmv04042008@gmail.com"'))
    assert.ok(html.includes('>mmv04042008@gmail.com</a>'))
    assert.ok(!html.includes('mmy04042008@gmail.com'))
  }
})

test('privacy and personal-data consent keep independent dated versions when support terms change', () => {
  assert.equal(legal.PRIVACY_POLICY_VERSION, '2026-10-15.1')
  assert.equal(legal.PERSONAL_DATA_CONSENT_VERSION, '2026-10-15.1')
  assert.equal(legal.LEGAL_TERMS_VERSION, '2026-10-17.1')
  assert.notEqual(legal.getLegalPage('privacy-policy').title, legal.getLegalPage('personal-data-consent').title)
  for (const kind of privacyKinds) {
    assert.equal(legal.getLegalPage(kind).updatedAt, '15 жовтня 2026 року')
    assert.match(plain(kind), /2026-10-15\.1/)
    assert.ok(plain(kind).includes(legal.legalMerchant.name))
    assert.ok(plain(kind).includes(legal.legalMerchant.email))
    assert.ok(plain(kind).includes(legal.legalMerchant.taxId))
  }
})

test('policy describes actual scopes, providers, optional recognition, withdrawal and retention limits', () => {
  const policy = plain('privacy-policy')
  for (const name of ['Supabase', 'Vercel', 'Resend', 'WayForPay', 'OpenAI', 'Telegram']) assert.ok(policy.includes(name))
  assert.match(policy, /Електронна пошта акаунта не входить до звичайного публічного профілю/)
  assert.match(policy, /інші студенти не отримують доступу до чужих приватних балів/)
  assert.match(policy, /лише якщо.*«Розпізнати фото»/)
  assert.match(policy, /store: false/)
  assert.match(policy, /не є обіцянкою негайного видалення/)
  assert.match(policy, /без тексту приватної переписки, приватних балів або вкладень/)
  assert.match(policy, /не містить імен або електронних адрес заявників/)
  assert.match(policy, /не є заявою про наскрізне шифрування/)
  assert.match(policy, /законний інтерес.*з урахуванням ваших прав/)
  assert.match(policy, /можна вимкнути в налаштуваннях сповіщень/)
  assert.match(policy, /не підписують вас на сторонню рекламну розсилку/)
  assert.match(policy, /зберегти на іншій законній підставі/)
  assert.match(policy, /не обіцяємо їх миттєвого знищення/)
  assert.match(policy, /відкликати згоду/)
  assert.match(policy, /Пароль|пароля/)
})

test('consent is explicit, scoped and separate from marketing or employers', () => {
  const consent = plain('personal-data-consent')
  assert.match(consent, /Саме відкриття цієї сторінки не є наданням згоди/)
  assert.match(consent, /окремою дією у формі Xelay/)
  assert.match(consent, /не дозволяє надсилати мені сторонню рекламу/)
  assert.match(consent, /автоматично передавати резюме роботодавцям/)
  assert.match(consent, /не є відмовою від моїх законних прав/)
  assert.match(consent, /відкликати згоду на майбутнє/)
  assert.match(consent, /раніше створених акаунтів згода не виникає автоматично/)
})

test('legal links are fixed first-party, mailto or primary official sources', () => {
  const all = renderer.legalPageKinds.flatMap(kind => legal.getLegalPage(kind).sections.flatMap(section => section.links || []))
  for (const link of all) {
    assert.ok(link.label.trim())
    assert.ok(link.href.startsWith('/') || link.href === `mailto:${legal.legalMerchant.email}`
      || ['https://ombudsman.gov.ua/', 'https://zakon.rada.gov.ua/laws/show/2297-17#Text'].includes(link.href))
  }
  const privacyLinks = legal.getLegalPage('privacy-policy').sections.flatMap(section => section.links || [])
  assert.ok(privacyLinks.some(link => link.href === 'https://ombudsman.gov.ua/'))
  assert.ok(privacyLinks.some(link => link.href === 'https://zakon.rada.gov.ua/laws/show/2297-17#Text'))
})

test('both public documents render complete content and cross-links without JavaScript or login', () => {
  for (const kind of privacyKinds) {
    assert.ok(renderer.legalPageKinds.includes(kind))
    const document = legal.getLegalPage(kind)
    const html = renderer.renderLegalHtml(kind)
    assert.match(html, /^<!doctype html>/)
    assert.match(html, /<html lang="uk">/)
    assert.ok(html.includes(`<h1>${document.title}</h1>`))
    for (const section of document.sections) assert.ok(html.includes(`<h2>${section.title}</h2>`))
    assert.ok(html.includes(`href="https://www.xelay.ink/${kind}"`))
    for (const target of privacyKinds) assert.ok(html.includes(`href="/${target}"`))
    assert.ok(html.includes(`href="mailto:${legal.legalMerchant.email}"`))
    assert.doesNotMatch(html, /<script\b/i)
    assert.doesNotMatch(html, /<iframe\b/i)
    assert.doesNotMatch(html, /supabase\.co|Bearer /)
  }
  const html = renderer.renderLegalHtml('privacy-policy')
  assert.match(html, /href="https:\/\/ombudsman\.gov\.ua\/" target="_blank" rel="noopener noreferrer"/)
})

test('SPA routes, footer navigation and production rewrites include both documents', async () => {
  const app = await readFile(new URL('src/App.tsx', root), 'utf8')
  const links = await readFile(new URL('src/components/LegalLinks.tsx', root), 'utf8')
  const config = JSON.parse(await readFile(new URL('vercel.json', root), 'utf8'))
  for (const kind of privacyKinds) {
    assert.ok(app.includes(`path: '/${kind}'`))
    assert.ok(app.includes(`<LegalPage kind="${kind}" />`))
    assert.ok(links.includes(`href: '/${kind}'`))
    const rewriteIndex = config.rewrites.findIndex(item => item.source === '/' + kind)
    assert.ok(rewriteIndex >= 0)
    assert.equal(config.rewrites[rewriteIndex].destination, `/legal/${kind}.html`)
    assert.ok(rewriteIndex < config.rewrites.findIndex(item => item.destination === '/index.html'))
  }
  assert.match(app, /rootRoute\.addChildren\([\s\S]*privacyPolicyRoute,[\s\S]*personalDataConsentRoute,/)
})

test('public sitemap includes both document URLs using only a synthetic read', async () => {
  const source = ts.transpileModule(await readFile(new URL('api/sitemap.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  const mockClient = { from(name) {
    assert.equal(name, 'questions')
    return { select() { return { order() { return { limit() { return { data: [], error: null } } } } } } }
  } }
  vm.runInNewContext(source, {
    exports, require(name) { assert.equal(name, '@supabase/supabase-js'); return { createClient: () => mockClient } },
    process: { env: { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'synthetic-only' } },
    Date, encodeURIComponent,
  })
  let body = '', status = 0
  const response = { setHeader() {}, status(value) { status = value; return this }, send(value) { body = value }, end() {} }
  await exports.default({ method: 'GET' }, response)
  assert.equal(status, 200)
  for (const kind of privacyKinds) assert.ok(body.includes(`<loc>https://www.xelay.ink/${kind}</loc>`))
})
