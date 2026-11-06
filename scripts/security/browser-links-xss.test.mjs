import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(path, dependencies = {}, testExport = '') {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  const code = ts.transpileModule(source + testExport, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const exports = {}
  runInNewContext(code, { exports, URL, require: (name) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) })
  return exports
}
const browserLinks = load('src/lib/browserLinks.ts')
const { externalHttpUrl } = browserLinks

const unsafe = [
  'javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
  'blob:https://xelay.example/a', '//attacker.example/', '/local', 'https://trusted.example@attacker.example/',
  'https://a:b@attacker.example/', 'https://\\attacker.example/', 'https://attack\ter.example/', 'https://',
]

test('only explicit HTTP(S) browser destinations without credentials or URL control characters are accepted', () => {
  for (const value of unsafe) assert.equal(externalHttpUrl(value), null, value)
  assert.equal(externalHttpUrl(' HTTPS://example.org:443/допомога?a=1&b=2 '),
    'https://example.org/%D0%B4%D0%BE%D0%BF%D0%BE%D0%BC%D0%BE%D0%B3%D0%B0?a=1&b=2')
  assert.equal(externalHttpUrl('http://example.org/guide'), 'http://example.org/guide')
})

test('a community article keeps raw HTML, fake markdown links and credentialed URLs inert', () => {
  const { ChatArticleText } = load('src/components/ChatArticleText.tsx', { '../lib/browserLinks': browserLinks })
  const html = renderToStaticMarkup(createElement(ChatArticleText, { body: [
    '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    '[JavaScript](javascript:alert(1)) [Data](data:text/html,<svg/onload=alert(1)>)',
    '[Impostor](https://trusted.example@attacker.example/) [Backslash](https://\\attacker.example/)',
    '[Valid](https://example.org/guide?a=1&b=2)',
  ].join('\n') }))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /\[Impostor\]\(https:\/\/trusted\.example@attacker\.example\/\)/)
  assert.equal((html.match(/<a\b/g) ?? []).length, 1)
  assert.match(html, /href="https:\/\/example\.org\/guide\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/)
})

test('the employer UI rejects executable or misleading URLs in stored resume snapshots', () => {
  const { EmployerApplication } = load('src/components/opportunities/CompanyPanel.tsx', {
    './OpportunitiesContext': { useOpportunities: () => ({ busy: false }) },
    './shared': { CareerModal: ({ children }) => children, Field: ({ children }) => children, StatusPill: () => null, dateLabel: () => '' },
    '../../lib/browserLinks': browserLinks,
    '../../lib/opportunities/types': { APPLICATION_LABELS: {} },
    './BusinessPanels.css': {},
  }, '\nexport { EmployerApplication }')
  const render = (portfolioUrl) => renderToStaticMarkup(createElement(EmployerApplication, { application: {
    resumeSnapshot: { portfolioUrl, headline: '<img src=x onerror=alert(1)>', skills: [] },
    status: 'sent', messages: [], studentName: 'Test student',
  } }))
  for (const value of [...unsafe, 'http://example.org/portfolio']) assert.doesNotMatch(render(value), /<a\b/, value)
  const html = render('https://example.org/portfolio')
  assert.match(html, /href="https:\/\/example\.org\/portfolio" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})
