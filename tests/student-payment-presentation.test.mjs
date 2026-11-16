import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/studentPaymentPresentation.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date,Number,Object})
const now=Date.parse('2026-11-16T12:00:00Z'),order={id:'own-order',product:'participant',group_id:null,order_reference:'xelay_own-order',amount:999,currency:'UAH',mode:'live',status:'approved',created_at:'2026-11-16T11:00:00Z',approved_at:'2026-11-16T11:01:00Z',student_plan_id:'max'}
test('approved own student purchase is presented independently of old finite or lifetime Participant expiry',()=>{
 for(const [plan,amount]of [['start',149],['plus',399],['max',999]])assert.equal(exports.confirmedStudentPayment({...order,student_plan_id:plan,amount},'owner','owner',now),plan)
})
test('a return URL, another owner, pending/test payment, wrong amount or untrusted tier never confirms payment',()=>{
 for(const changed of [{status:'pending'},{mode:'test'},{amount:100},{student_plan_id:'__proto__'},{student_plan_id:null},{approved_at:null},{approved_at:'not-a-date'},{approved_at:'2027-01-01T00:00:00Z'},{product:'group'}])assert.equal(exports.confirmedStudentPayment({...order,...changed},'owner','owner',now),null)
 for(const args of [[undefined,'owner'],['owner','other']])assert.equal(exports.confirmedStudentPayment(order,...args,now),null)
 assert.equal(exports.confirmedStudentPayment(undefined,'owner','owner',now),null)
})
