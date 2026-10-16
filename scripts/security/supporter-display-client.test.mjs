import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read=name=>readFile(new URL('../../'+name,import.meta.url),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
function load(source,imports,globals={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,...globals,require:name=>{assert.ok(name in imports,name);return imports[name]}});return module.exports}
const tiers=load(await read('src/lib/supporterTiers.ts'),{})
const prefsSource=await read('src/lib/supporterBadgePreferences.ts')
function prefs(respond=()=>({data:{tier:3,sixSeven:true,showTier:true,showSixSeven:false,orders:'strip'},error:null})){
  const calls=[]
  return {calls,api:load(prefsSource,{'./supporterTiers':tiers,'./supabase':{supabase:{rpc:async(name,args)=>{calls.push({name,args});return respond(name,args)}}}})}
}
test('own badge settings send no requested owner, earned flags or financial fields',async()=>{
  const fx=prefs();assert.deepEqual(plain(await fx.api.loadMySupporterBadgePreferences()),{tier:3,sixSeven:true,showTier:true,showSixSeven:false})
  await fx.api.saveMySupporterBadgePreferences(false,true)
  assert.deepEqual(plain(fx.calls),[{name:'xelay_my_supporter_badges'},{name:'xelay_set_my_supporter_badges',args:{p_show_tier:false,p_show_six_seven:true}}])
  for(const values of [[null,true],['true',false],[1,true],[true,undefined]])await assert.rejects(fx.api.saveMySupporterBadgePreferences(...values))
  assert.equal(fx.calls.length,2)
})
test('settings reject malformed earned data and unavailable requests without pretending a save succeeded',async()=>{
  const fx=prefs()
  for(const data of [null,[],{}, {tier:0,sixSeven:true,showTier:false,showSixSeven:true},{tier:1,sixSeven:false,showTier:1,showSixSeven:true},
    {tier:6,sixSeven:false,showTier:true,showSixSeven:true},{tier:1,sixSeven:false,showTier:true}])assert.throws(()=>fx.api.parseSupporterBadgePreferences(data))
  const bad=prefs(()=>({data:null,error:{code:'42501'}}));await assert.rejects(bad.api.loadMySupporterBadgePreferences());await assert.rejects(bad.api.saveMySupporterBadgePreferences(false,false))
})
const noticeSource=await read('src/lib/secretBadgeAnnouncement.ts')
function notice({readResult={data:null,error:null},writeResult={error:null},brokenStorage=false,write}={}){
  const calls=[],writes=[],storage=new Map()
  const api=load(noticeSource,{'./supabase':{supabase:{from(table){const call={table,filters:[]};const query={
    select(columns){call.columns=columns;return query},eq(key,value){call.filters.push([key,value]);return query},abortSignal(signal){call.signal=signal;return query},
    maybeSingle(){calls.push(call);return Promise.resolve(readResult)},upsert(row,options){writes.push(plain({table,row,options}));return write?write():Promise.resolve(writeResult)}
  };return query}}}}, {localStorage:{getItem:key=>{if(brokenStorage)throw Error('blocked');return storage.get(key)},setItem:(key,value)=>{if(brokenStorage)throw Error('blocked');storage.set(key,value)}}})
  return {api,calls,writes,storage}
}
test('checking the notice reads only the own receipt and never records an unseen banner',async()=>{
  const fx=notice(),signal=new AbortController().signal
  assert.equal(await fx.api.loadSecretBadgeAnnouncementSeen('owner',signal),false)
  assert.equal(fx.writes.length,0)
  const {signal:received,...call}=fx.calls[0];assert.equal(received,signal)
  assert.deepEqual(plain(call),{table:'account_announcement_receipts',columns:'announcement_id',filters:[['user_id','owner'],['announcement_id','secret-six-seven-2026-10-17']]})
  fx.api.rememberSecretBadgeAnnouncement('owner');await fx.api.persistSecretBadgeAnnouncement('owner');await fx.api.persistSecretBadgeAnnouncement('owner')
  assert.equal(fx.writes.length,1);assert.equal(fx.api.hasSeenSecretBadgeAnnouncement('owner'),true);assert.equal(fx.api.hasSeenSecretBadgeAnnouncement('other'),false)
  assert.deepEqual(fx.writes[0].row,{user_id:'owner',announcement_id:'secret-six-seven-2026-10-17'})
  assert.deepEqual(fx.writes[0].options,{onConflict:'user_id,announcement_id',ignoreDuplicates:true})
})
test('guest and account receipts are separate; guests never query or write the database',async()=>{
  const fx=notice();assert.equal(await fx.api.loadSecretBadgeAnnouncementSeen(undefined,new AbortController().signal),false)
  fx.api.rememberSecretBadgeAnnouncement();await fx.api.persistSecretBadgeAnnouncement()
  assert.equal(fx.api.hasSeenSecretBadgeAnnouncement(),true);assert.equal(fx.api.hasSeenSecretBadgeAnnouncement('owner'),false)
  assert.equal(fx.calls.length,0);assert.equal(fx.writes.length,0)
  const blocked=notice({brokenStorage:true});blocked.api.rememberSecretBadgeAnnouncement('owner');assert.equal(blocked.api.hasSeenSecretBadgeAnnouncement('owner'),true)
})
test('server receipt suppresses repeats across devices, but errors or unexpected campaigns cannot consume the notice',async()=>{
  const fx=notice({readResult:{data:{announcement_id:'secret-six-seven-2026-10-17'},error:null}})
  assert.equal(await fx.api.loadSecretBadgeAnnouncementSeen('owner',new AbortController().signal),true);assert.equal(fx.api.hasSeenSecretBadgeAnnouncement('owner'),true)
  await fx.api.persistSecretBadgeAnnouncement('owner');assert.equal(fx.writes.length,0)
  for(const readResult of [{data:null,error:{code:'offline'}},{data:{announcement_id:'another'},error:null}]){
    const bad=notice({readResult});await assert.rejects(bad.api.loadSecretBadgeAnnouncementSeen('owner',new AbortController().signal));assert.equal(bad.api.hasSeenSecretBadgeAnnouncement('owner'),false)
  }
})
test('receipt writes deduplicate concurrent effects and failed writes remain retryable',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r)
  const fx=notice({write:()=>pending});const first=fx.api.persistSecretBadgeAnnouncement('owner'),second=fx.api.persistSecretBadgeAnnouncement('owner')
  assert.equal(fx.writes.length,1);resolve({error:null});await Promise.all([first,second]);await fx.api.persistSecretBadgeAnnouncement('owner');assert.equal(fx.writes.length,1)
  const failed=notice({writeResult:{error:{code:'offline'}}});await assert.rejects(failed.api.persistSecretBadgeAnnouncement('owner'));await assert.rejects(failed.api.persistSecretBadgeAnnouncement('owner'));assert.equal(failed.writes.length,2)
})
test('home integration is an inline dismissible notice; settings are independent of mandatory academic fields',async()=>{
  const [home,ui,settings,modal,badge]=await Promise.all(['src/pages/HomePage.tsx','src/components/SecretBadgeAnnouncement.tsx','src/components/SupporterBadgeSettings.tsx','src/components/ProfileSettingsModal.tsx','src/components/SupporterBadge.tsx'].map(read))
  assert.ok(home.includes('<SecretBadgeAnnouncement blocked={showAuthModal} />'))
  assert.match(ui,/<aside ref={card}/);assert.doesNotMatch(ui,/createPortal|<[^>\n]+ aria-modal=|fixed inset|document\.body\.style\.overflow|\.focus\(/)
  assert.match(ui,/IntersectionObserver/);assert.match(ui,/visibilityState/);assert.match(ui,/700/)
  assert.match(ui,/href="\/support"/);assert.match(ui,/Закрити підказку/)
  assert.ok(modal.indexOf('<SupporterBadgeSettings')<modal.indexOf('<form ref={formRef}'))
  assert.match(settings,/role="switch"/);assert.match(settings,/saveMySupporterBadgePreferences/);assert.match(settings,/SUPPORTER_BADGES_CHANGED/)
  assert.match(badge,/current === generation/);assert.match(badge,/window\.addEventListener\(SUPPORTER_BADGES_CHANGED/)
})
