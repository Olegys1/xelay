import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import {renderToStaticMarkup} from 'react-dom/server'
const read=name=>readFile(new URL('../../src/components/'+name,import.meta.url),'utf8')
const source=await read('BadgeInfo.tsx'),module={exports:{}}
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{
  if(name==='react')return React;if(name==='react/jsx-runtime')return jsx;if(name==='react-dom')return{createPortal(){throw Error('Closed popover must not create a portal')}}
  if(name==='lucide-react')return{X:()=>null};throw Error(name)
}})
test('badge explanation starts closed and is a keyboard-accessible button without a form submission',()=>{
  const html=renderToStaticMarkup(React.createElement(module.exports.BadgeInfo,{label:'67 · Six Seven',description:'A paid badge'},'67'))
  assert.match(html,/<button/);assert.match(html,/type="button"/);assert.match(html,/aria-expanded="false"/);assert.match(html,/aria-haspopup="dialog"/)
  assert.doesNotMatch(html,/A paid badge|role="dialog"|aria-modal/)
})
test('explanations are small, dismissible, prevent parent activation and preserve profile settings on Escape',()=>{
  assert.match(source,/Math\.min\(300, window\.innerWidth - 16\)/);assert.match(source,/Math\.max\(8/)
  assert.match(source,/event\.preventDefault\(\); event\.stopPropagation\(\)/)
  assert.match(source,/document\.addEventListener\('keydown', escape, true\)/)
  assert.match(source,/Закрити пояснення бейджа/);assert.match(source,/pointerdown/)
  assert.doesNotMatch(source,/aria-modal="true"|inset-0|body\.style\.overflow/)
})
test('support, secret, subscription and verified teacher badges explain their actual origins',async()=>{
  const support=await read('SupporterBadge.tsx'),premium=await read('PremiumBadge.tsx'),teacher=await read('TeacherStatusCard.tsx')
  for(const data of [support,premium,teacher])assert.match(data,/<BadgeInfo/)
  assert.match(support,/за один підтверджений неповернений внесок рівно 67 грн/)
  assert.match(support,/Внески додаються/);assert.match(premium,/активну особисту підписку/);assert.match(teacher,/перевірила й підтвердила команда Xelay/)
})
