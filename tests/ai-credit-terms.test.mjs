import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8')
function load(path,imports={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(read(path),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,require(name){if(Object.hasOwn(imports,name))return imports[name];throw Error('Unexpected '+name)}});return module.exports}
const base=load('src/lib/legal.ts'),credits=load('src/lib/aiCreditTerms.ts',{'./legal.ts':base}),html=load('scripts/legalHtml.ts',{'../src/lib/legal.ts':base,'../src/lib/aiCreditTerms.ts':credits})
test('credit terms explain approved prices, carryover, active Max and full fourteen-day refund without changing existing agreements',()=>{
 assert.equal(credits.AI_CREDIT_TERMS_VERSION,'2026-11-17.1')
 for(const kind of ['terms','refund-policy']){const before=base.getLegalPage(kind),after=credits.getLegalPage(kind),addendum=after.sections.find(section=>section.id==='ai-credits');assert.equal(addendum.id,'ai-credits');assert.deepEqual(JSON.parse(JSON.stringify(after.sections.filter(section=>!['ai-credits','winter-benefits'].includes(section.id)))),JSON.parse(JSON.stringify(before.sections)));const text=addendum.paragraphs.join(' ');for(const price of ['99 грн','249 грн','749 грн'])assert.ok(text.includes(price));assert.match(text,/не згорають/);assert.match(text,/активним доступом Макс/);assert.match(text,/14 календарних днів/);assert.match(text,/не змінює підписку, подарунки/)}
 assert.deepEqual(JSON.parse(JSON.stringify(credits.getLegalPage('privacy-policy'))),JSON.parse(JSON.stringify(base.getLegalPage('privacy-policy'))))
})
test('public static terms and refund documents render the same credit addendum as the app',()=>{
 for(const kind of ['terms','refund-policy']){const document=html.renderLegalHtml(kind);assert.match(document,/id="ai-credits"/);assert.match(document,/749 грн/);assert.match(document,/14 календарних днів/)}
 assert.match(read('src/pages/LegalPage.tsx'),/import \{ getLegalPage \} from '\.\.\/lib\/aiCreditTerms'/)
})

test('winter purchases have explicit separate consent, bounded gifts, refund rules and twelve calendar periods',()=>{
 assert.equal(credits.WINTER_BENEFITS_TERMS_VERSION,'2026-11-27.1')
 for(const kind of ['terms','refund-policy']){
  const page=credits.getLegalPage(kind),winter=page.sections.find(section=>section.id==='winter-benefits')
  assert.ok(winter);const text=winter.paragraphs.join(' ')
  for(const phrase of ['150 бонусних','31 січня 2027','28 лютого 2027','12 календарних місяців','місячного ліміту ШІ','не обнуляється','лише одну зимову знижку']) {
   assert.ok(text.includes(phrase),phrase)
  }
  assert.match(text,/Автоматичного поновлення чи списання немає/)
  assert.match(text,/14 календарних днів/)
  assert.match(text,/лише за власною дією/)
  assert.match(html.renderLegalHtml(kind),/id="winter-benefits"/)
 }
 assert.deepEqual(JSON.parse(JSON.stringify(credits.getLegalPage('personal-data-consent'))),JSON.parse(JSON.stringify(base.getLegalPage('personal-data-consent'))))
})
