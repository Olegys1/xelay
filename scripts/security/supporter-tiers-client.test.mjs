import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
const root=new URL('../../',import.meta.url)
const read=file=>readFile(new URL(file,root),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
function load(source,imports={}){const module={exports:{}};vm.runInNewContext(compile(source),{module,exports:module.exports,Intl,Number,require:name=>{if(!(name in imports))throw Error('Unexpected import '+name);return imports[name]}});return module.exports}
const tiers=load(await read('src/lib/supporterTiers.ts'))
const support=load(await read('src/lib/teamSupport.ts'))
const plain=value=>JSON.parse(JSON.stringify(value))
const boundaries=[[0,0],[99,0],[100,1],[9999,1],[10000,2],[24999,2],[25000,3],[49999,3],[50000,4],[99999,4],[100000,5],[14999900,5],[2999980000,5]]

test('integer-kopiyka thresholds implement the agreed five cumulative levels exactly',()=>{
  for(const [amount,expected] of boundaries)assert.equal(tiers.supporterTierForTotal(amount),expected,String(amount))
  assert.deepEqual(plain(tiers.SUPPORTER_TIERS.map(t=>t.minimumKopiykas)),[100,10000,25000,50000,100000])
  assert.deepEqual(plain(tiers.SUPPORTER_TIERS.map(t=>t.label)),['Підтримую Xelay','Бронза Xelay','Срібло Xelay','Золото Xelay','Діамант Xelay'])
})

test('invalid totals and malformed summaries cannot mint or overstate a badge',()=>{
  for(const value of [null,undefined,'10000',NaN,Infinity,-100,0.5,Number.MAX_SAFE_INTEGER+1])assert.equal(tiers.supporterTierForTotal(value),0)
  for(const [totalKopiykas,tier] of boundaries)assert.deepEqual(plain(tiers.parseSupporterSummary({tier,totalKopiykas,private:'drop'})),{tier,totalKopiykas})
  for(const value of [null,[],{},true,{tier:2,totalKopiykas:9999},{tier:5,totalKopiykas:100},{tier:6,totalKopiykas:100000},
    {tier:'2',totalKopiykas:10000},{tier:2,totalKopiykas:'10000'},{tier:1,totalKopiykas:100.1},{tier:0,totalKopiykas:-100},
    {tier:5,totalKopiykas:Number.MAX_SAFE_INTEGER+1}])assert.throws(()=>tiers.parseSupporterSummary(value),/SUMMARY_INVALID/)
})

test('preview adds contributions without changing the actual level or rounding a payment',()=>{
  assert.equal(tiers.previewSupporterTier(5000,5000),2)
  assert.equal(tiers.previewSupporterTier(9999,100),2)
  assert.equal(tiers.previewSupporterTier(24900,100),3)
  assert.equal(tiers.previewSupporterTier(99900,100),5)
  assert.equal(tiers.previewSupporterTier(Number.MAX_SAFE_INTEGER,100),5)
  for(const pair of [[-1,100],[0,99],[0,100.1],[0,NaN],[NaN,100],[Number.MAX_SAFE_INTEGER+1,100]])assert.equal(tiers.previewSupporterTier(...pair),0)
  for(const [input,expected] of [['1',100],['99,99',9999],['100',10000],['149999',14999900],['150000',null],['1.001',null]])assert.equal(support.parseSupportAmount(input),expected)
})

test('next-tier progress never asks a top-tier supporter for another upgrade',()=>{
  assert.equal(tiers.nextSupporterTier(100000),null)
  assert.equal(tiers.nextSupporterTier(1000000),null)
  assert.equal(tiers.nextSupporterTier(9999).remainingKopiykas,1)
  assert.equal(tiers.nextSupporterTier(10000).remainingKopiykas,15000)
  assert.equal(tiers.nextSupporterTier(0).remainingKopiykas,100)
})

const badgeSource=await read('src/lib/supporterBadge.ts')
function badgeFixture(results){const calls=[];const api=load(badgeSource,{'./supabase':{supabase:{rpc:async(name,args)=>{calls.push({name,args});const result=results.shift();if(result instanceof Error)throw result;return result}}},'./supporterTiers':tiers});return{api,calls}}
test('public badge loading accepts only the server level and sends only the requested profile identity',async()=>{
  for(let tier=0;tier<=5;tier++){
    const fx=badgeFixture([{data:tier,error:null}]);assert.equal(await fx.api.loadSupporterTier('profile-id'),tier)
    assert.deepEqual(plain(fx.calls),[{name:'xelay_supporter_tier',args:{p_user_id:'profile-id'}}])
  }
  for(const value of [null,true,'5',6,-1,1.5,{tier:5,totalKopiykas:100000}])await assert.rejects(badgeFixture([{data:value,error:null}]).api.loadSupporterTier('id'),/TIER_INVALID/)
})
test('only a missing new RPC falls back to the legacy basic badge, never to a fabricated higher level',async()=>{
  for(const code of ['PGRST202','42883'])for(const value of [true,false]){
    const fx=badgeFixture([{data:null,error:{code}},{data:value,error:null}]);assert.equal(await fx.api.loadSupporterTier('id'),value?1:0)
    assert.equal(fx.calls[1].name,'xelay_supporter_badge')
  }
  for(const error of [{code:'42501'},{code:'08006'},new Error('offline')]){
    const fx=badgeFixture([error instanceof Error?error:{data:null,error}]);await assert.rejects(fx.api.loadSupporterTier('id'));assert.equal(fx.calls.length,1)
  }
})

const icons=new Proxy({}, {get:()=>()=>React.createElement('svg')})
const infoUi=load(await read('src/components/BadgeInfo.tsx'),{'react':React,'react/jsx-runtime':jsx,'lucide-react':icons,'react-dom':{createPortal(){throw Error('Closed explanation must not create a portal')}}})
const badgeUi=load(await read('src/components/SupporterBadge.tsx'),{'react':React,'react/jsx-runtime':jsx,'lucide-react':icons,'../lib/supporterBadge':{loadSupporterBadges(){throw Error('No traffic')}} ,'../lib/supporterBadgePreferences':{SUPPORTER_BADGES_CHANGED:'changed'},'../lib/supporterTiers':tiers,'./supporterBadge.css':{},'./BadgeInfo':infoUi})
const levelsUi=load(await read('src/components/SupporterLevels.tsx'),{'react/jsx-runtime':jsx,'lucide-react':icons,'../lib/teamSupport':support,'../lib/supporterTiers':tiers,'./SupporterBadge':badgeUi})
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props))
test('all five actual badge renderings have distinct visible labels/styles without exposing an amount',()=>{
  for(const row of tiers.SUPPORTER_TIERS){const html=render(badgeUi.SupporterMark,{tier:row.tier});assert.ok(html.includes(row.label));assert.ok(html.includes(`data-supporter-tier="${row.key}"`));assert.doesNotMatch(html,/грн|копій|totalKopiykas|order_reference/)}
  assert.equal(render(badgeUi.SupporterBadge,{userId:'id'}),'')
})
test('support overview shows the five agreed prices, distinguishes actual and preview tiers, and explains accumulation',()=>{
  const html=render(levelsUi.SupporterLevels,{currentTier:2,previewTier:4})
  for(const text of ['Від 1 грн','Від 100 грн','Від 250 грн','Від 500 грн','Від 1 000 грн','Ваш рівень','За вибраною сумою','Два внески по 50 грн'])assert.ok(html.includes(text),text)
})
test('private lifetime progress handles no support, exact boundaries and the highest level',()=>{
  for(const [amount,tier] of [[0,0],[9999,1],[10000,2],[100000,5]]){
    const html=render(levelsUi.SupporterProgress,{summary:{totalKopiykas:amount,tier}})
    assert.ok(html.includes('Ваша підтверджена підтримка'))
    if(tier===5){assert.match(html,/найвищий рівень/);assert.doesNotMatch(html,/progressbar/)}else assert.match(html,/role="progressbar"/)
  }
})
test('preview is explicit about confirmation, unknown private totals and test payments',()=>{
  const cumulative=render(levelsUi.SupporterContributionPreview,{amountKopiykas:5000,summary:{tier:1,totalKopiykas:5000},authenticated:true,testMode:false})
  assert.match(cumulative,/Бронза Xelay/);assert.match(cumulative,/Попередній перегляд/);assert.match(cumulative,/після підтвердження оплати/)
  const unknown=render(levelsUi.SupporterContributionPreview,{amountKopiykas:10000,summary:null,authenticated:true,testMode:false});assert.match(unknown,/Щонайменше/)
  const synthetic=render(levelsUi.SupporterContributionPreview,{amountKopiykas:100000,summary:null,authenticated:true,testMode:true});assert.match(synthetic,/Тестова оплата не змінює робочий бейдж/)
  assert.equal(render(levelsUi.SupporterContributionPreview,{amountKopiykas:null,authenticated:true,testMode:false}),'')
})

test('secret public data is boolean, bounded, strips extras and cannot invent a payment',async()=>{
  for(const tier of [1,2,3,4,5]){
    const fx=badgeFixture([{data:{tier,sixSeven:true,amount:6700,history:['private']},error:null}])
    assert.deepEqual(plain(await fx.api.loadSupporterBadges('profile-id')),{tier,sixSeven:true})
    assert.deepEqual(plain(fx.calls),[{name:'xelay_supporter_badges',args:{p_user_id:'profile-id'}}])
  }
  assert.deepEqual(plain(tiers.parseSupporterBadges({tier:0,sixSeven:true})),{tier:0,sixSeven:true})
  for(const data of [null,{},[],{tier:1},{tier:6,sixSeven:true},{tier:1,sixSeven:'true'},{tier:1,sixSeven:1}])
    await assert.rejects(badgeFixture([{data,error:null}]).api.loadSupporterBadges('id'),/BADGES_INVALID/)
  for(const code of ['PGRST202','42883']){
    const fx=badgeFixture([{data:null,error:{code}},{data:3,error:null}])
    assert.deepEqual(plain(await fx.api.loadSupporterBadges('id')),{tier:3,sixSeven:false})
    assert.equal(fx.calls[1].name,'xelay_supporter_tier')
  }
  const fx=badgeFixture([{data:null,error:{code:'42501'}}]);await assert.rejects(fx.api.loadSupporterBadges('id'));assert.equal(fx.calls.length,1)
})

test('private summaries accept verified secret ownership, retain legacy compatibility and reject invalid flags',()=>{
  assert.deepEqual(plain(tiers.parseSupporterSummary({tier:1,totalKopiykas:6700,sixSeven:true,history:'private'})),{tier:1,totalKopiykas:6700,sixSeven:true})
  assert.deepEqual(plain(tiers.parseSupporterSummary({tier:0,totalKopiykas:0,sixSeven:false})),{tier:0,totalKopiykas:0,sixSeven:false})
  for(const sixSeven of [null,'true',1,{}])assert.throws(()=>tiers.parseSupporterSummary({tier:1,totalKopiykas:6700,sixSeven}),/SUMMARY_INVALID/)
  assert.throws(()=>tiers.parseSupporterSummary({tier:1,totalKopiykas:6699,sixSeven:true}),/SUMMARY_INVALID/)
})

test('67 preview is additional to the cumulative tier and never awards an actual badge',()=>{
  const preview=amount=>render(levelsUi.SupporterContributionPreview,{amountKopiykas:amount,summary:{tier:3,totalKopiykas:25000,sixSeven:false},authenticated:true,testMode:false})
  assert.match(preview(6700),/Срібло Xelay/);assert.match(preview(6700),/data-supporter-secret="six-seven"/)
  assert.match(preview(6700),/після підтвердження оплати/)
  for(const amount of [6699,6701,13400,10000])assert.doesNotMatch(preview(amount),/data-supporter-secret/)
  const owned=render(levelsUi.SupporterProgress,{summary:{tier:3,totalKopiykas:31700,sixSeven:true}})
  assert.match(owned,/Срібло Xelay/);assert.match(owned,/data-supporter-secret="six-seven"/)
  const pending=render(levelsUi.SupporterProgress,{summary:{tier:3,totalKopiykas:25000,sixSeven:false}})
  assert.doesNotMatch(pending,/data-supporter-secret/)
  const synthetic=render(levelsUi.SupporterContributionPreview,{amountKopiykas:6700,summary:null,authenticated:true,testMode:true})
  assert.match(synthetic,/Тестова оплата не змінює робочий бейдж/);assert.doesNotMatch(synthetic,/Цей внесок також відкриє/)
})

test('secret hint is a quiet disclosure, makes the price clear and never opens a modal',()=>{
  const hint=render(levelsUi.SupporterSecretHint,{unlocked:false,disabled:false,onSelectAmount(){}})
  assert.match(hint,/<details/);assert.doesNotMatch(hint,/<details[^>]*\bopen|role="dialog"|aria-modal|fixed inset/)
  assert.match(hint,/Псс…/);assert.match(hint,/рівно 67 грн/);assert.match(hint,/Обрати 67 грн/)
  assert.match(hint,/Кілька менших внесків не відкривають/)
  const owned=render(levelsUi.SupporterSecretHint,{unlocked:true,disabled:false,onSelectAmount(){}})
  assert.match(owned,/Секрет знайдено/);assert.doesNotMatch(owned,/Обрати 67 грн/)
  const mark=render(badgeUi.SixSevenMark,{compact:false});assert.match(mark,/67/);assert.match(mark,/Six Seven/)
  assert.doesNotMatch(mark,/amount_kopiykas|totalKopiykas|order_reference/)
})
