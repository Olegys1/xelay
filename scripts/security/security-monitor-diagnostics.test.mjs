import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {createSecurityMonitorFixture,zeroObservations} from './security-monitor-fixture.mjs'
const source=await readFile(new URL('../../server/securityMonitorPolicy.ts',import.meta.url),'utf8')
const policy={};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:policy,Date,Intl})
const end='2026-11-19T08:25:00Z'
const base={lease_token:'11111111-1111-4111-8111-111111111111',alert_id:'22222222-2222-4222-8222-222222222222',kind:'api_errors',source:'api',severity:'warning',event_count:222,total_count:2000,occurrences:1,threshold:{},window_start:'2026-11-19T08:20:00Z',window_end:end,created_at:end}
const evidence={api_total:2000,api_errors:222,unauthenticated_denials:29,database_shutdowns:8,database_starting:58,window_end:end,database_started_at:'2026-11-19T08:24:46Z'}
test('restart explanation distinguishes evidence from inference and never invents a tariff change or teacher clicks',()=>{
 const text=policy.formatAdminSecurityAlert({...base,diagnostics:evidence})
 assert.match(text,/10:24/);assert.match(text,/перезапускалася/);assert.match(text,/Імовірний/);assert.match(text,/не доводять, що змінювали тариф/)
 assert.match(text,/Втрату відповідей цими даними не встановлено/)
 assert.doesNotMatch(text,/три рази|3 рази|викладач натиснув/)
 for(const diagnostics of [undefined,{...evidence,window_end:'2026-11-19T08:30:00Z'},{...evidence,api_errors:221},{...evidence,api_total:1},{...evidence,database_starting:'PRIVATE_TEXT'}]){
  const unknown=policy.formatAdminSecurityAlert({...base,diagnostics});assert.match(unknown,/Причину ще не встановлено/);assert.doesNotMatch(unknown,/PRIVATE_TEXT|перезапускалася/)
 }
 const anonymous=policy.formatAdminSecurityAlert({...base,kind:'access_denials',event_count:29,diagnostics:evidence})
 assert.match(anonymous,/29 із 29/);assert.match(anonymous,/без підтвердженої ролі/);assert.match(anonymous,/Правила захисту залишаються чинними/)
})
test('diagnosis storage is service-only, numeric-only, window-bound and survives notification retries',async t=>{
 const fx=await createSecurityMonitorFixture();t.after(()=>fx.close())
 await fx.db.exec(await readFile(new URL('../../supabase/migrations/20261119091619_admin_error_diagnostics.sql',import.meta.url),'utf8'))
 const due=await fx.rpc('xelay_security_monitor_due')
 const proof={api_total:2000,api_errors:222,unauthenticated_denials:29,database_shutdowns:8,database_starting:58}
 const record=(token=due.lease_token,value=proof)=>fx.rpc('xelay_security_monitor_record_diagnostics',[token,JSON.stringify(value)])
 for(const role of ['anon','authenticated']) await assert.rejects(fx.asRole(role,()=>fx.db.query('select public.xelay_security_monitor_record_diagnostics($1,$2)',[due.lease_token,JSON.stringify(proof)])),e=>e.code==='42501')
 for(const value of [{...proof,email:'PRIVATE'}, {...proof,api_errors:-1},{...proof,api_errors:2001},{...proof,database_starting:'58'},{}]) await assert.rejects(record(undefined,value),e=>e.code==='22023')
 assert.equal(await record('33333333-3333-4333-8333-333333333333'),false)
 assert.equal(await record(),true)
 const observations=zeroObservations().map(x=>x.kind==='api_errors'?{...x,count:222,total:2000}:x)
 await fx.rpc('xelay_security_monitor_observe',[due.lease_token,JSON.stringify(observations),'healthy',null,null])
 assert.equal(await record(),false,'released observation lease cannot rewrite evidence')
 const claim=await fx.rpc('xelay_claim_admin_security_alert')
 assert.ok(claim)
 assert.equal(claim.diagnostics.api_errors,222)
 assert.equal(Date.parse(claim.diagnostics.window_end),Date.parse(claim.window_end))
 const live=await fx.rpc('xelay_admin_security_alert_delivery_context',[claim.lease_token])
 assert.deepEqual(live.diagnostics,claim.diagnostics)
 for(const role of ['anon','authenticated','service_role']) await assert.rejects(fx.asRole(role,()=>fx.db.query('select * from xelay_security_monitor.diagnostics')),e=>e.code==='42501')
})
