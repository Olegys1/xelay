import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function modules() {
  const catalog = { exports: {} }
  const renderer = { exports: {} }
  function load(path, module, require) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    vm.runInNewContext(result.outputText, { exports: module.exports, module, require })
    return module.exports
  }
  const content = load('../../src/lib/publicSeoContent.ts', catalog, () => { throw new Error('The public catalog must not load application state') })
  const html = load('../publicAudienceHtml.ts', renderer, name => {
    assert.equal(name, '../src/lib/publicSeoContent.ts')
    return content
  })
  return { ...content, ...html }
}

test('each public audience is complete in initial HTML with an individual heading and discoverable role links', () => {
  const api = modules()
  for (const [path, page] of Object.entries(api.PUBLIC_AUDIENCE_PAGES)) {
    const html = api.renderAudienceBody(path.slice(1))
    assert.equal((html.match(/<h1\b/g) || []).length, 1)
    assert.ok(html.includes(page.heading))
    assert.ok(html.includes(page.intro))
    for (const feature of page.features) {
      assert.ok(html.includes(feature.title))
      assert.ok(html.includes(feature.text))
    }
    for (const item of page.faq) {
      assert.ok(html.includes(item.question))
      assert.ok(html.includes(item.answer))
    }
    for (const role of Object.keys(api.PUBLIC_AUDIENCE_PAGES)) assert.ok(html.includes(`href="${role}"`))
    assert.ok(html.includes(`href="${page.primaryCta.href}"`))
    assert.ok(html.includes('href="/guides/"'))
    assert.doesNotMatch(html, /<script\b|on(?:click|error|load)\s*=/i)
  }
})

test('public text is escaped when prerendered, including headings and FAQ content', () => {
  const api = modules(), page = api.PUBLIC_AUDIENCE_PAGES['/students']
  page.heading = '<img src=x onerror="alert(1)"> & a'
  page.features[0].text = '<script>alert(2)</script>'
  page.faq[0].answer = '</p><iframe src="evil">'
  const html = api.renderAudienceBody('students')
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; a'))
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;/p&gt;&lt;iframe src=&quot;evil&quot;&gt;'))
  assert.doesNotMatch(html, /<img|<script|<iframe/)
})

test('home ecosystem copy remains useful without JavaScript and preserves the existing page h1', () => {
  const api = modules(), html = api.renderHomeEcosystemBody()
  assert.doesNotMatch(html, /<h1\b|<script\b/)
  assert.ok(html.includes(api.HOME_ECOSYSTEM_CONTENT.heading))
  assert.ok(html.includes(api.HOME_ECOSYSTEM_CONTENT.intro))
  for (const feature of api.HOME_ECOSYSTEM_CONTENT.features) assert.ok(html.includes(feature.text))
  for (const item of api.HOME_ECOSYSTEM_CONTENT.faq) assert.ok(html.includes(item.answer))
  for (const path of ['/students', '/headmen', '/teachers']) assert.ok(html.includes(`href="${path}"`))
})
