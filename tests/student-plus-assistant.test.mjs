import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map(),plain=value=>JSON.parse(JSON.stringify(value))
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);vm.runInNewContext(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,TextEncoder,TextDecoder,Uint8Array,Response,JSON,Number,Date,Set,Map,Promise,require(name){if(!name.startsWith('.'))throw Error('Unexpected external dependency');return load(path.resolve(path.dirname(absolute),name.replace(/\.(?:js|ts)$/, ''))+'.ts')}});return module.exports}
const client=load('src/lib/maxTutorProductionClient.ts'),tutor=load('src/lib/maxTutor.ts'),scope={userId:'plus-owner',sessionId:'plus-session'}
const status=()=>({status:'ready',scope,audience:'student',planId:'plus',canGenerate:true,canEdit:true,available:true,model:'gpt-5.4-mini',budget:{limitUsd:3,spentUsd:0,reservedUsd:0,remainingUsd:3},localOnly:false,budgetPeriod:'subscription_month',budgetResetsAt:'2026-12-17T10:00:00Z'})
const run=id=>{const sample=plain(tutor.createTutorDemo(id,'quiz'));return{id,createdAt:'2026-11-17T10:00:00Z',demo:false,...sample,progress:plain(tutor.emptyTutorProgress()),revision:1}}

test('Plus accepts its paid-period server status and fails closed for a higher allowance, model, calendar reset or foreign owner',()=>{
 assert.equal(client.parseProductionMaxStatus(status(),scope.userId).budget.limitUsd,3)
 for(const changes of[{budget:{...status().budget,limitUsd:3.01}},{model:'gpt-5.4'},{budgetPeriod:'utc_calendar_month'},{audience:'teacher'},{budgetResetsAt:null},{scope:{...scope,userId:'foreign-owner'}}])assert.throws(()=>client.parseProductionMaxStatus({...status(),...changes},scope.userId))
 const max={...status(),planId:'max',model:'gpt-5.4',budget:{limitUsd:10,spentUsd:2,reservedUsd:0,remainingUsd:8}}
 assert.equal(client.parseProductionMaxStatus(max,scope.userId).budget.limitUsd,10)
 const old={...status(),canGenerate:false,available:false,budget:{limitUsd:0,spentUsd:0,reservedUsd:0,remainingUsd:0},budgetResetsAt:null,model:'gpt-5.4'}
 assert.equal(client.parseProductionMaxStatus(old,scope.userId).canGenerate,false)
})

test('only bounded owner-matching pending IDs can load private archived material',()=>{
 const envelope=(ownerId,items)=>JSON.stringify({version:1,ownerId,items}),pending={revision:1,progress:{answers:{},submitted:[],cardRatings:{},doneTasks:[]}}
 assert.deepEqual(plain(client.productionArchivePendingIds(envelope(scope.userId,{'older-run':pending}),scope.userId)),['older-run'])
 for(const raw of[envelope('foreign',{'older-run':pending}),envelope(scope.userId,{'../unsafe':pending}),envelope(scope.userId,{'older-run':{...pending,revision:-1}}),envelope(scope.userId,Object.fromEntries(Array.from({length:13},(_,i)=>['old-'+i,pending]))),'x'.repeat(client.MAX_PRODUCTION_PROGRESS_OUTBOX_BYTES+1),'{broken'])assert.deepEqual(plain(client.productionArchivePendingIds(raw,scope.userId)),[])
})

test('rehydrated archived run retains queued quiz answers and a different device answer stays an explicit conflict',()=>{
 const old=run('older-than-twelve'),q=old.bundle.questions[0],progress={...old.progress,answers:{[q.id]:1}},raw=JSON.stringify({version:1,ownerId:scope.userId,items:{[old.id]:{revision:old.revision,progress}}})
 const history={scope,runs:[old],activeRunId:old.id},restored=client.restoreProductionProgress(history,raw)
 assert.equal(restored.state.runs[0].progress.answers[q.id],1);assert.equal(restored.pending[old.id].progress.answers[q.id],1);assert.equal(restored.conflict,false)
 const server={...old,revision:2,progress:{...old.progress,answers:{[q.id]:0}}},conflict=client.restoreProductionProgress({...history,runs:[server]},raw)
 assert.equal(conflict.conflict,true);assert.equal(conflict.pending[old.id].progress.answers[q.id],1);assert.equal(server.progress.answers[q.id],0)
 assert.equal(client.restoreProductionProgress({...history,scope:{...scope,userId:'foreign'}},raw).recoveryRaw,raw)
})
