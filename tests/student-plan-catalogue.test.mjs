import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8')
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(read('src/lib/studentPlans.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Number,Math,Object})
const p=module.exports,plain=value=>JSON.parse(JSON.stringify(value)),now=Date.parse('2026-11-17T12:00:00Z')
const audience={userId:'owner',initialAudience:'student',assignedAt:'2026-11-01T00:00:00Z'}
const grant=planId=>({userId:'owner',planId,startsAt:'2026-11-16T10:00:00Z',expiresAt:'2026-12-16T10:00:00Z'})
const resolve=extra=>p.resolveStudentEntitlements({authenticatedUserId:'owner',billingAudience:audience,now,...extra})

test('catalogue retains approved prices and distinguishes the actual internal Start, Plus and Max allowances',()=>{
 assert.deepEqual(plain(p.STUDENT_PLANS.map(plan=>[plan.id,plan.monthlyPriceUah,plan.monthlyAiBudgetUsd])),[['start',149,0],['plus',399,3],['max',999,10]])
 const economics=p.calculateStudentPlanEconomics('plus')
 assert.equal(economics.aiUah,150);assert.equal(economics.paymentFeeUah,7.98);assert.equal(economics.contributionUah,206.02)
 assert.ok(economics.excludes.includes('Податки'));assert.ok(economics.excludes.includes('Постійні витрати'))
 for(const plan of p.STUDENT_PLANS)assert.doesNotMatch([plan.description,...plan.features].join(' '),/\$|USD|gpt[- ]|мікродолар/iu)
})

test('Plus inherits every existing benefit while its new package stays separate from premium Max activities',()=>{
 const ids=plan=>new Set(p.getStudentPlanFeatures(plan).map(feature=>feature.id)),start=ids('start'),plus=ids('plus'),max=ids('max')
 for(const id of start)assert.ok(plus.has(id),id)
 for(const id of plus)assert.ok(max.has(id),id)
 for(const id of ['plus_cloud_library','plus_ai_chat','plus_ai_practice','plus_mistake_notebook','plus_review_queue']){assert.ok(plus.has(id));assert.equal(start.has(id),false)}
 for(const id of ['max_ai_study','max_ai_formats','timed_rehearsal','research_reader','coursework_projects']){assert.ok(max.has(id));assert.equal(plus.has(id),false)}
 const capability=p.STUDENT_PLAN_FEATURES.filter(feature=>feature.legacyCapability).map(feature=>feature.legacyCapability)
 assert.deepEqual(plain(capability),plain(p.LEGACY_PARTICIPANT_CAPABILITIES))
 assert.match(p.STUDENT_PLAN_FEATURES.find(feature=>feature.id==='plus_cloud_library').description,/на пристрої/)
 assert.ok(p.STUDENT_AI_ROADMAP.every(feature=>feature.status==='planned'||feature.status==='paused'))
 assert.ok(p.STUDENT_AI_ROADMAP.every(feature=>!['plus_ai_chat','plus_ai_practice','max_ai_study','max_ai_formats'].includes(feature.id)))
})

test('display entitlement follows a verified owner and original audience instead of granting AI to Start or teachers',()=>{
 for(const [plan,cap]of[['start',0],['plus',3],['max',10]]){const result=resolve({planGrant:grant(plan)});assert.equal(result.planId,plan);assert.equal(result.monthlyAiBudgetUsd,cap);assert.equal(result.aiAllowance,cap?'available':'not_included');assert.equal(result.ownSavedContentAccess,true)}
 for(const extra of [
  {planGrant:{...grant('plus'),userId:'foreign'}},
  {planGrant:{...grant('plus'),startsAt:'2026-12-01T00:00:00Z'}},
  {planGrant:{...grant('plus'),expiresAt:'2026-11-17T12:00:00Z'}},
  {billingAudience:{...audience,initialAudience:'teacher'},planGrant:grant('plus')},
  {billingAudience:{...audience,userId:'foreign'},planGrant:grant('max')},
 ]){const result=resolve(extra);assert.equal(result.planId,'free');assert.equal(result.aiAllowance,'not_included');assert.equal(result.monthlyAiBudgetUsd,0)}
})

test('legacy payments, gifts and lifetime privileges retain saved access without inventing an AI allowance',()=>{
 for(const kind of ['payment','gift','lifetime']){
  const legacyGrant={userId:'owner',kind,isPremium:true,isLifetime:kind==='lifetime',expiresAt:kind==='lifetime'?null:'2026-12-01T12:00:00Z'}
  const legacy=resolve({legacyGrant});assert.equal(legacy.planId,'start');assert.equal(legacy.legacyBenefits,true);assert.equal(legacy.isLifetime,kind==='lifetime');assert.equal(legacy.aiAllowance,'pending_legacy_policy');assert.equal(legacy.monthlyAiBudgetUsd,0);assert.equal(legacy.ownSavedContentAccess,true)
  const upgraded=resolve({legacyGrant,planGrant:grant('plus')});assert.equal(upgraded.planId,'plus');assert.equal(upgraded.monthlyAiBudgetUsd,3);assert.equal(upgraded.isLifetime,kind==='lifetime')
  assert.equal(legacyGrant.expiresAt,kind==='lifetime'?null:'2026-12-01T12:00:00Z')
 }
})

test('subscriber-facing catalogue and guides explain Plus AI and scoped cloud saving without exposing internal budget or model',()=>{
 const catalogue=read('src/components/student/StudentSubscriptionCatalogue.tsx'),guides=read('src/lib/studentGuides.ts'),local=read('src/components/student/StudentPlanCatalog.tsx')
 assert.match(catalogue,/Приватна хмарна бібліотека/);assert.match(catalogue,/ШІ-чат, тести та картки/)
 assert.match(catalogue,/Бібліотека Плюс і Макс зберігає нотатки, особисті тести, картки та повторення в акаунті/)
 assert.match(catalogue,/Інструменти з позначкою «на пристрої» зберігаються окремо/)
 assert.doesNotMatch(catalogue,/monthlyAiBudgetUsd|gpt-5\.4|gpt-6|\$3|\$10/)
 assert.match(guides,/Плюс працює з одним джерелом за запит, Макс — із трьома/)
 assert.match(guides,/У Плюс доступні звичайні тести й картки/)
 assert.doesNotMatch(local,/Жива ШІ-модель.*ще не підключена|коли повернемося до його підключення/)
})
