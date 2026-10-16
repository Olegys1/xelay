// Public legal-content/build integration only. No network, real accounts or DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

const root=new URL('../../',import.meta.url)
const require=createRequire(import.meta.url)
const loadSource=path=>readFile(new URL(path,root),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,
  target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText
function evaluate(source,imports={}){
  const module={exports:{}}
  vm.runInNewContext(compile(source),{module,exports:module.exports,__dirname:fileURLToPath(root),
    require(name){if(Object.hasOwn(imports,name))return imports[name];assert.ok(['react','react/jsx-runtime','path'].includes(name),`Unexpected import ${name}`);return require(name)}})
  return module.exports
}
const legal=evaluate(await loadSource('src/lib/legal.ts'))
const renderer=evaluate(await loadSource('scripts/legalHtml.ts'),{'../src/lib/legal':legal})
const linksSource=await loadSource('src/components/LegalLinks.tsx')
const links=evaluate(linksSource)
const iconStub=new Proxy({},{get:()=>()=>null})
const legalPageSource=await loadSource('src/pages/LegalPage.tsx')
const {LegalPage}=evaluate(legalPageSource,{'lucide-react':iconStub,'../components/LegalLinks':links,'../lib/legal':legal})
const document=legal.getLegalPage('community-rules')
const html=renderer.renderLegalHtml('community-rules')
const reactHtml=renderToStaticMarkup(React.createElement(LegalPage,{kind:'community-rules'}))
const decode=value=>value.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'",'&#x27;':"'"})[entity])
const plain=document.sections.flatMap(section=>[section.title,...(section.paragraphs||[]),...(section.items||[])]).join('\n')
const sourceConfig=JSON.parse(await loadSource('vercel.json'))

test('community rules are a separate Ukrainian public document without new consent or altered existing versions',()=>{
  assert.equal(document.title,'Правила спільноти')
  assert.ok(document.description.trim());assert.ok(document.updatedAt.trim());assert.ok(document.sections.length>=6)
  for(const topic of [/поваг|образ/i,/ненавист/i,/спам/i,/персональ|приватн/i,/скарг|повідомити/i,/блокув|обмежен/i])assert.match(plain,topic)
  assert.equal(legal.LEGAL_TERMS_VERSION,'2026-10-13.1')
  assert.equal(legal.PRIVACY_POLICY_VERSION,'2026-10-15.1')
  assert.equal(legal.PERSONAL_DATA_CONSENT_VERSION,'2026-10-15.1')
  assert.doesNotMatch(html,/<input\b|<form\b|type="checkbox"/i)
  assert.doesNotMatch(legalPageSource,/useAuth|useBilling|supabase|requireConsent/)
})

test('React and static HTML show the complete same source content and links to anonymous readers',()=>{
  assert.ok(renderer.legalPageKinds.includes('community-rules'))
  assert.match(html,/^<!doctype html>\s*<html lang="uk">/)
  assert.match(html,/<link rel="canonical" href="https:\/\/www\.xelay\.ink\/community-rules">/)
  assert.match(html,/<meta name="robots" content="index,follow">/)
  for(const output of [html,reactHtml]){
    const decoded=decode(output)
    assert.ok(decoded.includes(document.title));assert.ok(decoded.includes(document.description));assert.ok(decoded.includes(document.updatedAt))
    for(const section of document.sections){
      assert.ok(decoded.includes(section.title),section.title)
      for(const text of [...(section.paragraphs||[]),...(section.items||[])])assert.ok(decoded.includes(text),text)
      for(const link of section.links||[]){
        assert.ok(link.href.startsWith('/')||link.href===`mailto:${legal.legalMerchant.email}`,'Only trusted internal/contact destinations')
        assert.ok(decoded.includes(`href="${link.href}"`));assert.ok(decoded.includes(link.label))
      }
    }
    assert.match(output,/href="\/community-rules"[^>]*aria-current="page"/)
    assert.doesNotMatch(output,/<script\b|<iframe\b|Bearer |supabase\.co/i)
  }
})

test('SPA route, all legal navigation variants and production rewrite lead to the real rules page',async()=>{
  const app=await loadSource('src/App.tsx')
  assert.match(app,/const communityRulesRoute = createRoute\(\{[^\n]*path: '\/community-rules'[^\n]*<LegalPage kind="community-rules"/)
  assert.match(app,/rootRoute\.addChildren\([\s\S]*communityRulesRoute,/)
  assert.ok(linksSource.includes("href: '/community-rules', kind: 'community-rules', label: 'Правила спільноти'"))
  for(const variant of ['footer','page','checkout']){
    const rendered=renderToStaticMarkup(React.createElement(links.LegalLinks,{variant,activeKind:'community-rules'}))
    assert.match(rendered,/href="\/community-rules"[^>]*aria-current="page"/)
    if(variant==='checkout')assert.match(rendered,/href="\/community-rules"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
  }
  const position=sourceConfig.rewrites.findIndex(item=>item.source==='/community-rules')
  assert.ok(position>=0);assert.equal(sourceConfig.rewrites[position].destination,'/legal/community-rules.html')
  assert.ok(position<sourceConfig.rewrites.findIndex(item=>item.destination==='/index.html'))
  assert.match(html,/<nav aria-label="Правила платформи та контакти">[\s\S]*href="\/community-rules"/)
})

test('the actual Vite legal plugin emits a complete standalone page under the current CSP',async()=>{
  const viteSource=await loadSource('vite.config.ts')
  const config=evaluate(viteSource,{'vite':{defineConfig:value=>value},'@vitejs/plugin-react':()=>({name:'synthetic-react'}),
    './scripts/legalHtml':renderer}).default
  const emitted=[]
  const plugin=config.plugins.find(value=>value.name==='xelay-public-legal-pages')
  assert.ok(plugin);assert.equal(plugin.apply,'build')
  plugin.generateBundle.call({emitFile(asset){emitted.push(asset)}})
  const page=emitted.find(asset=>asset.fileName==='legal/community-rules.html')
  assert.ok(page);assert.equal(page.type,'asset');assert.equal(page.source,html)
  const csp=sourceConfig.headers.find(entry=>entry.source==='/(.*)').headers.find(header=>header.key==='Content-Security-Policy').value
  assert.match(csp,/(?:^|;)\s*style-src[^;]*'unsafe-inline'/)
  assert.match(csp,/(?:^|;)\s*img-src[^;]*'self'/)
  assert.doesNotMatch(html,/<script\b|\son\w+\s*=|javascript:/i)
  assert.equal((html.match(/<style>/g)||[]).length,1)
})

test('status warning contains an accessible real link without replacing the user draft',async()=>{
  let stateNumber=0
  const fakeReact={...React,useEffect(){},useRef:value=>({current:value}),useState(value){
    const state=stateNumber++===0?true:typeof value==='function'?value():value
    return [state,()=>{}]
  }}
  const noop=()=>null
  const participantStatus=evaluate(await loadSource('src/lib/participantStatus.ts'))
  const {ParticipantProfileCard}=evaluate(await loadSource('src/components/ParticipantProfileCard.tsx'),{
    react:fakeReact,'@tanstack/react-router':{useNavigate:()=>()=>{}},'lucide-react':iconStub,
    '../context/BillingContext':{useBilling:()=>({isPremium:true,isLoading:false,refreshBilling(){}})},
    '../context/AuthContext':{useAuth:()=>({authUser:{id:'synthetic-only'},xelayUser:{username:'synthetic'}})},
    '../context/ToastContext':{useToast:()=>({notify(){}})},'./PremiumBadge':{PremiumBadge:noop},
    './ParticipantStatusEmoji':{ParticipantStatusEmoji:noop},'./PushReminderSettings':{PushReminderSettings:noop},
    '../lib/databaseCompatibility':{isMissingDatabaseFunction:()=>false},'../lib/participantStatus':participantStatus,
    '../lib/supabase':{supabase:{rpc(){throw new Error('No backend call expected')}}},
  })
  const output=renderToStaticMarkup(React.createElement(ParticipantProfileCard))
  const warning=output.match(/<div id="participant-status-rules"[\s\S]*?<\/div>/)?.[0]
  assert.ok(warning)
  assert.match(warning,/<a href="\/community-rules" target="_blank" rel="noopener noreferrer"[^>]*>/)
  assert.match(warning,/правил спільноти/);assert.match(warning,/відкриється в новій вкладці/)
  assert.match(warning,/можуть призвести/)
  assert.doesNotMatch(warning,/акаунт буде заблоковано/)
  assert.match(output,/id="participant-status-text"[^>]*aria-describedby="participant-status-length participant-status-rules"/)
})

test('sitemap publishes the rules using only a bounded public synthetic query and robots permits indexing',async()=>{
  const queries=[]
  const client={from(name){queries.push(name);return {select(columns){assert.equal(columns,'id, created_at');return {
    order(column,options){assert.equal(column,'created_at');assert.equal(options.ascending,false);return {
      limit(n){assert.equal(n,1000);return {data:[],error:null}},
    }},
  }}}}}
  const module={exports:{}}
  vm.runInNewContext(compile(await loadSource('api/sitemap.ts')),{module,exports:module.exports,
    process:{env:{SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'synthetic-anon-key'}},Date,encodeURIComponent,
    require(name){assert.equal(name,'@supabase/supabase-js');return {createClient:()=>client}}})
  let status,body;const headers={}
  const response={setHeader(name,value){headers[name]=value},status(value){status=value;return this},send(value){body=value},end(){}}
  await module.exports.default({method:'GET'},response)
  assert.equal(status,200);assert.deepEqual(queries,['questions'])
  assert.ok(body.includes('<loc>https://www.xelay.ink/community-rules</loc>'))
  assert.equal(headers['Content-Type'],'application/xml; charset=utf-8')
  const robots=await loadSource('public/robots.txt')
  assert.match(robots,/Allow: \/(?:\r?\n|$)/)
  assert.doesNotMatch(robots,/Disallow:.*(?:community|rules)/i)
  assert.match(robots,/Sitemap: https:\/\/xelay\.ink\/api\/sitemap/)
})
