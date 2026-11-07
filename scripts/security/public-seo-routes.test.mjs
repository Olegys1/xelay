import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { metadataForPath, questionSeo, isMissingPublicQuestion, PUBLIC_STATIC_PATHS, PRIVATE_SPA_PATHS, categorySeoPaths } from '../../src/lib/seo.ts'
import { renderSeoHtml, seoStaticDocuments, seoOutputPath } from '../publicSeoHtml.ts'
const root=new URL('../../',import.meta.url)
const read=path=>readFile(new URL(path,root),'utf8')
const template='<!doctype html><html lang="uk"><head><title>Old</title><meta name="description" content="old"><meta property="og:url" content="https://www.xelay.ink/"><link rel="canonical" href="https://www.xelay.ink/"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>'
test('temporary public-data failures never classify an existing question as404/noindex',()=>{
  for(const error of [{status:500},{status:503},{status:429},{code:'PGRST000'},new TypeError('Failed to fetch'),{}]) assert.equal(isMissingPublicQuestion(error),false)
  for(const error of [null,{code:'PGRST116'},{code:'42501'},{status:403},{status:404}]) assert.equal(isMissingPublicQuestion(error),true)
})

test('public canonical addresses are individual, fixed-origin and free of tracking or secret queries',()=>{
  const titles=new Set()
  for(const path of [...PUBLIC_STATIC_PATHS,...categorySeoPaths()]) {
    const meta=metadataForPath(path+'?invite=synthetic-private-token#grade')
    assert.equal(meta.canonical,'https://www.xelay.ink'+path)
    assert.ok(meta.title);assert.ok(meta.description)
    assert.ok(!titles.has(meta.title),'distinct public route title: '+path);titles.add(meta.title)
  }
  const question=questionSeo('11111111-1111-4111-8111-111111111111','  Тема\n   обговорення  ')
  assert.equal(question.title,'Тема обговорення | Xelay')
  assert.equal(question.canonical,'https://www.xelay.ink/question/11111111-1111-4111-8111-111111111111')
})
test('account areas and unknown paths are not indexable and never inherit the homepage canonical',()=>{
  for(const path of [...PRIVATE_SPA_PATHS,'/groups/hidden-group','/user/user-id','/news/news-id','/not-a-page','/category/not-real','https://evil.example/']) {
    const meta=metadataForPath(path)
    assert.equal(meta.index,false,path);assert.equal(meta.canonical,undefined,path)
  }
  assert.equal(metadataForPath('/not-a-page').notFound,true)
})
test('HTML rendering replaces old tags once and escapes head values without executing user text',()=>{
  const meta={title:'A </title><script>bad()</script>',description:'" onload="bad() & text',canonical:'https://www.xelay.ink/students',index:true}
  const first=renderSeoHtml(template,meta,'<main><h1>Students</h1></main>'),second=renderSeoHtml(first,meta,'<main><h1>Students</h1></main>')
  assert.equal(first,second)
  assert.equal((first.match(/<title>/g)||[]).length,1)
  assert.equal((first.match(/rel="canonical"/g)||[]).length,1)
  assert.match(first,/&lt;\/title&gt;&lt;script&gt;/)
  assert.doesNotMatch(first,/<script>bad|content="" onload/)
  assert.match(first,/src="\/assets\/app.js"/)
})
test('routing retains every app route while leaving arbitrary paths and missing assets to the real404',async()=>{
  const config=JSON.parse(await read('vercel.json'))
  assert.equal(config.buildCommand,'node scripts/security-ci/release-gate.mjs && npm run build','build cost changes stay rolled back')
  assert.ok(!config.rewrites.some(rule=>rule.source.includes('(?!api/') || rule.source==='/(.*)'))
  for(const path of [...PUBLIC_STATIC_PATHS.filter(x=>x!=='/'),...PRIVATE_SPA_PATHS,...categorySeoPaths()]) assert.equal(config.rewrites.find(x=>x.source===path)?.destination,'/'+seoOutputPath(path),path)
  assert.equal(config.rewrites.find(x=>x.source==='/question/:id')?.destination,'/api/seo?question=:id')
  assert.equal(config.rewrites.find(x=>x.source==='/sitemap.xml')?.destination,'/api/sitemap')
  assert.equal(config.functions['api/seo.ts'].includeFiles,'dist/index.html')
  assert.ok(config.rewrites.find(x=>x.source==='/api/supabase/rest/v1/:path*'))
})
test('generated pages contain public text beforeJavaScript and never seed a private dashboard',()=>{
  const docs=seoStaticDocuments(template)
  for(const role of ['students','headmen','teachers']) {
    const html=docs.get(`seo/${role}.html`)
    assert.equal((html.match(/<h1\b/g)||[]).length,1)
    assert.match(html,/href="\/guides\/"/)
    assert.match(html,new RegExp(`rel="canonical" href="https://www.xelay.ink/${role}"`))
  }
  for(const path of PRIVATE_SPA_PATHS) {
    const html=docs.get(seoOutputPath(path));assert.match(html,/content="noindex,follow"/)
    assert.doesNotMatch(html,/rel="canonical"|Ваш тестовий бал|Михайло|score|grade_id/)
  }
  const missing=docs.get('404.html');assert.match(missing,/content="noindex,follow"/);assert.doesNotMatch(missing,/<script\b|rel="canonical"/)
})
test('built public pages retain the strict CSP and one authoritative metadata set',async()=>{
  const config=JSON.parse(await read('vercel.json')),csp=config.headers.find(x=>x.source==='/(.*)').headers.find(x=>x.key==='Content-Security-Policy').value
  assert.match(csp,/script-src-attr 'none'/);assert.doesNotMatch(csp,/script-src[^;]*unsafe-(inline|eval)/)
  for(const path of ['index.html','seo/students.html','seo/headmen.html','seo/teachers.html','404.html']) {
    const html=await read('dist/'+path)
    assert.equal((html.match(/<title>/g)||[]).length,1,path)
    assert.equal((html.match(/name="description"/g)||[]).length,1,path)
    for(const [,script] of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) assert.ok(csp.includes("'sha256-"+createHash('sha256').update(script).digest('base64')+"'"),path)
  }
})
