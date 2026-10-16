// Actual admin UI callbacks and server rendering with synthetic data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as runtime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

const root=new URL('../../',import.meta.url)
const source=await readFile(new URL('src/components/AdminProfileReports.tsx',root),'utf8')
const parse=ts.createSourceFile('AdminProfileReports.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const queue=parse.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='ProfileReportQueue')
const declaration=name=>queue.body.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations]).find(node=>node.name.getText(parse)===name)?.initializer
const compile=code=>ts.transpileModule(code.replaceAll('import.meta.env.VITE_SUPABASE_URL',"'https://our-project.supabase.co'"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText
const api={}
vm.runInNewContext(compile(await readFile(new URL('src/lib/profileReports.ts',root),'utf8')),{exports:api,require:()=>({supabase:{rpc(){throw new Error('No provider requests allowed')}}}),URL,Date})
let auth={authUser:{id:'admin'},xelayUser:{id:'admin',isPlatformAdmin:true},isLoading:false}
const renderer={}
vm.runInNewContext(compile(source)+'\nexports.__test={ProfileSnapshot,ReportHistory,ReportDecisionDialog};',{
  exports:renderer,URL,Date,Intl,Map,window:{},document:{},
  require(name){
    if(name==='react')return React
    if(name==='react/jsx-runtime')return runtime
    if(name==='lucide-react')return new Proxy({},{get:()=>()=>React.createElement('svg')})
    if(name==='../context/AuthContext')return {useAuth:()=>auth}
    if(name==='../lib/profileReports')return api
    if(name==='./ParticipantStatusEmoji')return {ParticipantStatusEmojis:({status,label})=>React.createElement('span',{'aria-label':label},status)}
    throw new Error('Unexpected live import '+name)
  },
})
const report={id:'report',kind:'status',status:'open',version:1,created_at:'2026-10-16T10:00:00Z',target_user_id:'target',reporter_id:'reporter',
  target_snapshot:{user_id:'target',full_name:'Synthetic <target>',username:'target',avatar_url:null,bio:'Saved <bio>',faculty:'Faculty',specialty:'Programme',study_year:2,experience:'bachelor',university_id:'university',academic_unit_id:'unit',is_premium:true,status_text:'Saved status',emoji_status:'sticker:penguin'},
  reporter_snapshot:{user_id:'reporter',full_name:'Reporter',username:'reporter',avatar_url:null},reason:'other',details:'Synthetic report details'}
const detail={report,history:[],current_status:{is_premium:true,status_text:'Saved status',emoji_status:'sticker:penguin'}}
function callback(name,context){
  const node=declaration(name)
  assert.ok(node,'Actual callback must exist: '+name)
  const expression=ts.isCallExpression(node)?node.arguments[0]:node
  return vm.runInNewContext(compile(`(context)=>{const {${Object.keys(context).join(',')}}=context;return ${expression.getText(parse)}}`),{Date,Map})(context)
}
const plain=value=>JSON.parse(JSON.stringify(value))

test('same-account platform-admin guard rejects stale profiles, loading and regular users',()=>{
  for(const next of [
    {authUser:null,xelayUser:{id:'old',isPlatformAdmin:true}},
    {authUser:{id:'new'},xelayUser:{id:'old',isPlatformAdmin:true}},
    {authUser:{id:'user'},xelayUser:{id:'user',isPlatformAdmin:false}},
    {authUser:{id:'admin'},xelayUser:{id:'admin',isPlatformAdmin:true},isLoading:true},
  ]){auth=next;assert.equal(renderToStaticMarkup(React.createElement(renderer.AdminProfileReports)),'')}
  auth={authUser:{id:'admin'},xelayUser:{id:'admin',isPlatformAdmin:true},isLoading:false}
  const html=renderToStaticMarkup(React.createElement(renderer.AdminProfileReports))
  assert.match(html,/Скарги на профілі та статуси/)
  assert.match(html,/Кількість скарг сама по собі не спричиняє блокування/)
})

test('clear-status eligibility requires an active status report, active premium and exact saved text/emoji',()=>{
  assert.equal(renderer.canClearReportedStatus(detail),true)
  for(const changed of [
    {...detail,current_status:null}, {...detail,current_status:{...detail.current_status,is_premium:false}},
    {...detail,current_status:{...detail.current_status,status_text:'New status'}},
    {...detail,current_status:{...detail.current_status,emoji_status:null}},
    {...detail,report:{...report,status:'resolved'}}, {...detail,report:{...report,status:'dismissed'}},
    {...detail,report:{...report,kind:'profile'}},
  ])assert.equal(renderer.canClearReportedStatus(changed),false)
  assert.equal(renderer.canClearReportedStatus({...detail,report:{...report,target_snapshot:{...report.target_snapshot,status_text:null}},current_status:{...detail.current_status,status_text:''}}),false)
})

test('avatar snapshot accepts only the configured HTTPS public avatars origin and never external trackers or unsafe URLs',()=>{
  const trusted='https://our-project.supabase.co/storage/v1/object/public/avatars/user/photo.png'
  assert.equal(renderer.safeReportAvatarUrl(trusted),trusted)
  for(const unsafe of ['javascript:alert(1)','data:image/svg+xml,<svg/>','https://tracker.example/avatar.png',
    'https://our-project.supabase.co.evil.example/storage/v1/object/public/avatars/photo.png',
    'https://user:secret@our-project.supabase.co/storage/v1/object/public/avatars/photo.png',trusted+'#fragment',
    'http://our-project.supabase.co/storage/v1/object/public/avatars/photo.png',
    'https://our-project.supabase.co/storage/v1/object/public/other/photo.png',
    'https://our-project.supabase.co/storage/v1/object/public/avatars/%2e%2e/other/photo.png',
    'https://our-project.supabase.co/storage/v1/object/public/avatars/%2f..%2fother/photo.png'])assert.equal(renderer.safeReportAvatarUrl(unsafe),null)
  const html=renderToStaticMarkup(React.createElement(renderer.__test.ProfileSnapshot,{report:{...report,target_snapshot:{...report.target_snapshot,avatar_url:trusted}}}))
  assert.match(html,/referrerPolicy="no-referrer"/i)
  assert.match(html,/Фото профілю на момент скарги/)
  assert.match(html,/Saved &lt;bio&gt;/)
  assert.match(html,/2 курс/)
  const blocked=renderToStaticMarkup(React.createElement(renderer.__test.ProfileSnapshot,{report:{...report,target_snapshot:{...report.target_snapshot,avatar_url:'https://tracker.example/x'}}}))
  assert.doesNotMatch(blocked,/tracker\.example|<img/)
  assert.match(blocked,/Фото на момент скарги недоступне/)
})

test('the initial history actor is a reporter and review actors are administrators',()=>{
  const base={id:'history',actor_id:'actor',from_status:null,to_status:'open',action:'submit',note:'',created_at:report.created_at,version:1}
  const html=renderToStaticMarkup(React.createElement(renderer.__test.ReportHistory,{history:[base,{...base,id:'review',action:'none',to_status:'resolved',note:'Saved decision'}]}))
  assert.match(html,/Подання скарги/);assert.match(html,/Автор скарги/);assert.match(html,/Адміністратор/)
})

test('begin decision restores only its own cached note and never starts a stale or closed decision',()=>{
  const events=[],notes=new Map([[renderer.decisionDraftKey(report.id,'resolved',true),'Keep this draft']])
  const context={current:()=>true,loading:false,stale:false,detailLoading:false,detailError:'',lock:{current:false},activeReport:r=>['open','in_review'].includes(r.status),
    setDecision:value=>events.push(['decision',plain(value)]),setNote:value=>events.push(['note',value]),setDecisionError(){},noteDrafts:{current:notes},decisionDraftKey:renderer.decisionDraftKey}
  callback('beginDecision',context)(report,'resolved',true)
  assert.equal(events.find(([name])=>name==='note')[1],'Keep this draft')
  events.length=0;callback('beginDecision',context)(report,'dismissed',false)
  assert.equal(events.find(([name])=>name==='note')[1],'')
  for(const patch of [{stale:true},{loading:true},{current:()=>false}]){events.length=0;callback('beginDecision',{...context,...patch})(report,'resolved',true);assert.equal(events.length,0)}
})

function submitFixture(overrides={}){
  const events=[],notes=new Map([[renderer.decisionDraftKey(report.id,'resolved',true),'Keep network draft']])
  const context={decision:{report,status:'resolved',clearStatus:true},current:()=>true,lock:{current:false},loading:false,stale:false,detailLoading:false,detailError:'',
    note:'A sufficiently detailed decision',detail,activeReport:r=>['open','in_review'].includes(r.status),canClearReportedStatus:renderer.canClearReportedStatus,
    setDecisionError:value=>events.push(['decisionError',value]),setSaving(){},setError:value=>events.push(['error',value]),
    reviewProfileReport:async value=>{events.push(['review',plain(value)]);return {report:{...report,status:'resolved'},history:[]}},
    setDecision:value=>events.push(['decision',value]),closeDetail:()=>events.push(['closeDetail']),setNotice:value=>events.push(['notice',value]),
    profileReportError:()=> 'Synthetic network failure',setStale:value=>events.push(['stale',value]),latestDetail:{current:'report'},load:async()=>{},
    noteDrafts:{current:notes},decisionDraftKey:renderer.decisionDraftKey,...overrides}
  return {events,context,notes,submit:()=>callback('submit',context)({preventDefault(){}})}
}

test('only explicit confirmed clear uses clear_status; ordinary resolution never clears or bans',async()=>{
  const clear=submitFixture();await clear.submit()
  assert.equal(clear.events.find(([name])=>name==='review')[1].action,'clear_status')
  assert.equal(clear.events.find(([name])=>name==='review')[1].expectedVersion,1)
  assert.equal(clear.notes.size,0,'Successful decision releases its cached note')
  const ordinary=submitFixture({decision:{report,status:'resolved',clearStatus:false}});await ordinary.submit()
  assert.equal(ordinary.events.find(([name])=>name==='review')[1].action,'none')
  assert.doesNotMatch(JSON.stringify(ordinary.events),/ban_user|block_user|delete_report/)
  for(const patch of [{note:'short'},{detail:{...detail,report:{...report,version:2}}},{detail:{...detail,current_status:{...detail.current_status,status_text:'New status'}}},{current:()=>false}]){
    const fx=submitFixture(patch);await fx.submit();assert.equal(fx.events.some(([name])=>name==='review'),false)
  }
})

test('a network failure preserves the note for cancel, refresh and reopening the same decision',async()=>{
  const fx=submitFixture({reviewProfileReport:async()=>{throw new Error('Network')}});await fx.submit()
  assert.equal(fx.events.some(([name,value])=>name==='stale'&&value===true),true)
  assert.equal(fx.notes.get(renderer.decisionDraftKey(report.id,'resolved',true)),'Keep network draft')
  assert.equal(fx.events.some(([name])=>name==='closeDetail'),false)
  assert.equal(fx.context.lock.current,false)
})

test('list errors retain the last queue and mark it stale; late old-scope/account results cannot replace it',async()=>{
  const events=[]
  const base={PAGE_SIZE:20,current:()=>true,lock:{current:false},listBusy:{current:null},listGeneration:{current:0},filter:'open',offset:0,
    latestScope:{current:{filter:'open',offset:0}},setLoading:value=>events.push(['loading',value]),lastRefresh:{current:0},
    loadAdminProfileReports:async()=>{throw new Error('Network')},setPage:value=>events.push(['page',value]),setError:value=>events.push(['error',value]),
    setStale:value=>events.push(['stale',value]),profileReportError:()=> 'Load failure',latestDetail:{current:''},detailSnapshot:{current:null},setDetailError(){}}
  await callback('load',base)();assert.equal(events.some(([name])=>name==='page'),false);assert.equal(events.some(([name,value])=>name==='stale'&&value),true)
  for(const change of ['scope','account']){
    let finish,active=true;events.length=0
    const context={...base,current:()=>active,listBusy:{current:null},listGeneration:{current:0},latestScope:{current:{filter:'open',offset:0}},loadAdminProfileReports:()=>new Promise(resolve=>{finish=resolve})}
    const pending=callback('load',context)()
    if(change==='account')active=false;else context.latestScope.current={filter:'all',offset:0}
    finish({items:[report],total:1,open_count:1});await pending
    assert.equal(events.some(([name])=>name==='page'),false)
  }
})

test('visible refresh is bounded and cleaned up, and the queue is mounted before unrelated admin loading',async()=>{
  assert.match(source,/window\.setInterval\(refresh, 60_000\)/)
  assert.match(source,/window\.clearInterval\(interval\)/)
  assert.match(source,/document\.visibilityState === 'visible'/)
  assert.match(source,/!latestDecision\.current/)
  assert.match(source,/listBusy\.current !== null/)
  const admin=await readFile(new URL('src/pages/AdminPage.tsx',root),'utf8')
  assert.ok(admin.indexOf('<AdminProfileReports')<admin.indexOf('{loading ? <div className="xelay-card'))
})

test('StrictMode cleanup releases the request guard and old completion cannot unlock the remounted request',async()=>{
  const events=[],pending=[]
  const context={PAGE_SIZE:20,current:()=>true,lock:{current:false},listBusy:{current:null},listGeneration:{current:0},filter:'open',offset:0,
    latestScope:{current:{filter:'open',offset:0}},setLoading(){},lastRefresh:{current:0},loadAdminProfileReports:()=>new Promise(resolve=>pending.push(resolve)),
    setPage:value=>events.push(value),setError(){},setStale(){},profileReportError:()=>'',latestDetail:{current:''},detailSnapshot:{current:null},setDetailError(){}}
  const load=callback('load',context),old=load()
  // Mirrors the actual effect cleanup during StrictMode's setup/cleanup/setup.
  assert.match(source,/mounted\.current = false; \+\+listGeneration\.current; \+\+detailGeneration\.current; listBusy\.current = null/)
  context.listGeneration.current++;context.listBusy.current=null
  const remounted=load(),ticket=context.listBusy.current
  assert.equal(pending.length,2)
  pending[0]({items:[],total:0,open_count:0});await old
  assert.equal(context.listBusy.current,ticket)
  assert.equal(events.length,0)
  pending[1]({items:[report],total:1,open_count:1});await remounted
  assert.equal(events.length,1);assert.equal(context.listBusy.current,null)
})
