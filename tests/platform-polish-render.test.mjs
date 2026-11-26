import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const root=fileURLToPath(new URL('../',import.meta.url)),native=createRequire(import.meta.url),cache=new Map()
function load(file) {
 const path=resolve(root,file)
 if(cache.has(path))return cache.get(path)
 const module={exports:{}}
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,require:id=>{
  if(id.endsWith('/OnboardingContext'))return {useOnboarding:()=>({suspended:false})}
  if(!id.startsWith('.'))return native(id)
  const target=resolve(dirname(path),id),resolved=[target+'.ts',target+'.tsx'].find(existsSync)
  if(!resolved)throw Error('Unexpected dependency '+id)
  return load(resolved)
 }},{filename:path})
 cache.set(path,module.exports);return module.exports
}
const {StudyGroupGuide}=load('src/components/StudyGroupGuide.tsx')
const {GroupBillingPanelView}=load('src/components/GroupBillingPanelView.tsx')
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props))

test('first visit to any group role only shows the hints button, not an instructional panel',()=>{
 for(const role of ['member','representative','deputy']) {
  const html=render(StudyGroupGuide,{userId:'synthetic',groupId:'synthetic-group',role,permissions:['schedule','materials'],accessActive:true,onAction:()=>{}})
  assert.match(html,/<button[^>]*aria-label="Повторити підказки:/)
  assert.match(html,/>Підказки</)
  assert.doesNotMatch(html,/<aside|<h2|<p\b/)
 }
})
test('successful group access has no promotional banner; a denied or failed check retains retry and explanation',()=>{
 const base={freeAccess:true,loading:false,error:'',returnedOrder:false,onRefresh:()=>{}}
 assert.equal(render(GroupBillingPanelView,base),'')
 const denied=render(GroupBillingPanelView,{...base,freeAccess:false})
 assert.match(denied,/role="status"/);assert.match(denied,/Перевірити доступ/)
 const failure=render(GroupBillingPanelView,{...base,error:'Не вдалося перевірити доступ',loading:true})
 assert.match(failure,/role="alert"/);assert.match(failure,/<button[^>]*disabled/)
 const returned=render(GroupBillingPanelView,{...base,returnedOrder:true})
 assert.match(returned,/Попередні оплати/);assert.doesNotMatch(returned,/безкоштов/i)
})
