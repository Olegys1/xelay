// Actual profile/report UI with synthetic auth, hooks and SDK responses. No live writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root=new URL('../../',import.meta.url)
const reporter='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002'
const receipt={id:'00000000-0000-4000-8000-000000000003',status:'open',duplicate:false}
const read=path=>readFile(new URL(path,root),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
const sources=Object.fromEntries(await Promise.all(['src/components/ProfileReportDialog.tsx','src/pages/PublicProfilePage.tsx','src/components/CommunityChatPrimitives.tsx','src/lib/profileReports.ts'].map(async path=>[path,await read(path)])))
const jsx=(type,props,key)=>({type,props,key})
function nodes(tree,predicate=()=>true){
  if(!tree||typeof tree!=='object')return[]
  if(Array.isArray(tree))return tree.flatMap(item=>nodes(item,predicate))
  return[...(predicate(tree)?[tree]:[]),...nodes(tree.props?.children,predicate)]
}
const find=(tree,type)=>nodes(tree,node=>node.type===type)[0]
const named=(tree,name)=>nodes(tree,node=>node.type?.name===name)[0]
const text=tree=>typeof tree==='string'?tree:Array.isArray(tree)?tree.map(text).join(' '):tree&&typeof tree==='object'?text(tree.props?.children):''
const flush=()=>new Promise(resolve=>setImmediate(resolve))

function fixture(path='src/components/ProfileReportDialog.tsx',exportName='ProfileReportDialog',props={},document){
  const source=sources[path],parsed=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const component=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===exportName)
  const declarations=component.body.statements.filter(ts.isVariableStatement).flatMap(node=>[...node.declarationList.declarations])
  const stateNames=declarations.filter(node=>node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(parsed)==='useState').map(node=>node.name.elements[0].name.text)
  const refNames=declarations.filter(node=>node.initializer&&ts.isCallExpression(node.initializer)&&node.initializer.expression.getText(parsed)==='useRef').map(node=>node.name.getText(parsed))
  const fx={states:[],refs:[],effects:[],pending:[],cursor:0,refCursor:0,effectCursor:0,idCursor:0,audit:[],closes:0,routeId:target,auth:{authUser:{id:reporter},isAuthenticated:true},uuid:10,
    rpc:async()=>({data:receipt,error:null}),props:{targetUserId:target,targetName:'Тестовий учасник',onClose:()=>{fx.closes++},...props}}
  const react={Fragment:'Fragment',useState(initial){const i=fx.cursor++;if(!(i in fx.states))fx.states[i]=typeof initial==='function'?initial():initial;return[fx.states[i],value=>{fx.states[i]=typeof value==='function'?value(fx.states[i]):value}]},
    useRef(initial){const i=fx.refCursor++;return fx.refs[i]||={current:initial}},useId(){return'fixture-id-'+fx.idCursor++},
    useEffect(effect,deps){const i=fx.effectCursor++,previous=fx.effects[i];if(!previous||!deps||deps.some((value,index)=>!Object.is(previous.deps?.[index],value))){fx.effects[i]||={};fx.effects[i].deps=deps;fx.pending=fx.pending.filter(item=>item.i!==i);fx.pending.push({i,effect})}}}
  const database={rpc:async(name,args)=>{fx.audit.push({name,args});return fx.rpc(name,args)},from(){throw new Error('Unexpected profile query in isolated UI fixture')}}
  const reports={}
  vm.runInNewContext(compile(sources['src/lib/profileReports.ts']),{exports:reports,require(name){if(name==='./supabase')return{supabase:database};throw new Error(name)}})
  const modules={react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'Fragment'},'../context/AuthContext':{useAuth:()=>fx.auth},
    '@tanstack/react-router':{Link:function Link(){},useParams:()=>({id:fx.routeId}),useNavigate:()=>()=>{}},
    '../lib/profileReports':reports,'../lib/supabase':{supabase:database},
    './CommunityChatPrimitives':{ChatDialog:function ChatDialog(){},chatButton:'secondary',chatPrimary:'primary',chatInput:'input'},
  }
  const exports={}
  vm.runInNewContext(compile(source),{exports,document,crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++fx.uuid).padStart(12,'0')}`},console,
    require(name){if(modules[name])return modules[name];return new Proxy({},{get(_,key){if(key==='__esModule')return true;return{[key]:function(){return''}}[key]}})}})
  fx.render=()=>{fx.cursor=0;fx.refCursor=0;fx.effectCursor=0;fx.idCursor=0;fx.tree=exports[exportName](fx.props);return fx.tree}
  fx.commit=()=>{for(const{i,effect}of fx.pending.splice(0)){fx.effects[i].cleanup?.();fx.effects[i].cleanup=effect()}}
  fx.unmount=()=>{for(const effect of fx.effects)effect.cleanup?.()}
  fx.set=(name,value)=>{const index=stateNames.indexOf(name);assert.ok(index>=0,'Unknown state '+name);fx.states[index]=value}
  fx.get=name=>fx.states[stateNames.indexOf(name)]
  fx.ref=name=>fx.refs[refNames.indexOf(name)]
  fx.render()
  return fx
}
function ready(overrides={}){
  const fx=fixture();fx.commit();fx.set('reason','harassment');fx.set('details','  Конкретний опис порушення правил.  ')
  Object.assign(fx,overrides);fx.render();return fx
}
const submit=fx=>find(fx.render(),'form').props.onSubmit({preventDefault(){}})

test('report form exposes both targets, seven reasons, details limits and a safe rules link without premium gating',()=>{
  const fx=ready(),tree=fx.tree,selects=nodes(tree,node=>node.type==='select')
  assert.deepEqual(Array.from(selects[0].props.children,item=>item.props.value),['profile','status'])
  assert.deepEqual(Array.from(selects[1].props.children[1],item=>item.props.value),['harassment','hate','impersonation','inappropriate','spam','privacy','other'])
  const details=find(tree,'textarea');assert.equal(details.props.minLength,10);assert.equal(details.props.maxLength,2000)
  const rules=find(tree,'a');assert.equal(rules.props.href,'/community-rules');assert.equal(rules.props.target,'_blank');assert.equal(rules.props.rel,'noopener noreferrer');assert.match(rules.props.className,/focus-visible:ring/)
  assert.match(text(tree),/Скаргу побачить лише команда модерації/)
  assert.match(text(tree),/не спричиняє автоматичного блокування/)
  assert.equal(fx.audit.length,0)
})

test('invalid reason/details are refused before any RPC, even if the submit callback is invoked directly',async()=>{
  for(const patch of [{reason:''},{reason:'invalid'},{details:' коротко '},{details:'x'.repeat(2001)}]){
    const fx=ready();for(const[name,value]of Object.entries(patch))fx.set(name,value)
    submit(fx);await flush();assert.equal(fx.audit.length,0);assert.ok(fx.get('error'))
  }
})

test('one manual submit sends only the approved identifiers/details and prevents double clicks or busy close',async()=>{
  let complete
  const fx=ready({rpc:()=>new Promise(resolve=>{complete=resolve})}),form=find(fx.tree,'form')
  form.props.onSubmit({preventDefault(){}});form.props.onSubmit({preventDefault(){}})
  assert.equal(fx.audit.length,1);assert.equal(fx.get('saving'),true)
  const pending=fx.render();assert.equal(pending.props.busy,true);pending.props.onClose();assert.equal(fx.closes,0)
  for(const control of nodes(pending,node=>['textarea','select','button'].includes(node.type)))assert.equal(control.props.disabled,true)
  const request=fx.audit[0];assert.equal(request.name,'xelay_submit_profile_report')
  assert.deepEqual(Object.keys(request.args).sort(),['p_details','p_kind','p_reason','p_request_id','p_target_user_id'])
  assert.equal(request.args.p_target_user_id,target);assert.equal(request.args.p_details,'Конкретний опис порушення правил.')
  complete({data:receipt,error:null});await flush()
  assert.equal(fx.get('receipt').id,receipt.id);assert.equal(fx.get('saving'),false)
  form.props.onSubmit({preventDefault(){}});assert.equal(fx.audit.length,1)
  assert.match(text(fx.render()),/не означає автоматичного блокування/)
})

test('failed retries retain draft and idempotency key; a changed normalized payload receives a new key',async()=>{
  const fx=ready({rpc:async()=>{throw new Error('Failed to fetch')}})
  submit(fx);await flush()
  const first=fx.audit[0].args.p_request_id
  assert.equal(fx.get('details'),'  Конкретний опис порушення правил.  ');assert.equal(fx.get('reason'),'harassment')
  assert.ok(fx.get('error'));assert.match(text(fx.render()),/Повторити надсилання/)
  submit(fx);await flush();assert.equal(fx.audit[1].args.p_request_id,first)
  fx.set('targetKind','status');submit(fx);await flush();assert.notEqual(fx.audit[2].args.p_request_id,first)
  fx.set('reason','privacy');submit(fx);await flush();assert.notEqual(fx.audit[3].args.p_request_id,fx.audit[2].args.p_request_id)
  fx.set('details','Інший конкретний опис порушення.');submit(fx);await flush();assert.notEqual(fx.audit[4].args.p_request_id,fx.audit[3].args.p_request_id)
  fx.set('details','  Інший конкретний опис порушення.  ');submit(fx);await flush();assert.equal(fx.audit[5].args.p_request_id,fx.audit[4].args.p_request_id)
})

test('duplicate receipts show acknowledgement without resubmission or an automatic moderation promise',async()=>{
  const fx=ready({rpc:async()=>({data:{...receipt,duplicate:true},error:null})})
  submit(fx);await flush();const tree=fx.render()
  assert.equal(tree.props.title,'Скаргу вже передано');assert.match(text(tree),/Повторну скаргу не створено/)
  assert.equal(find(tree,'form'),undefined)
})

test('disabled/replaced submit controls keep focus inside the dialog during busy and acknowledgement states',async()=>{
  let complete
  const events=[],fx=ready({rpc:()=>new Promise(resolve=>{complete=resolve})})
  fx.ref('reportForm').current={closest(selector){assert.equal(selector,'[role="dialog"]');return{focus(){events.push('busy-panel')}}}}
  submit(fx);fx.render();fx.commit();assert.deepEqual(events,['busy-panel'])
  complete({data:receipt,error:null});await flush();fx.render()
  fx.ref('successAction').current={focus(){events.push('acknowledgement')}}
  fx.commit();assert.deepEqual(events,['busy-panel','acknowledgement'])
})

test('closing/unmounting or changing account/target permanently prevents stale callbacks and response state writes',async()=>{
  const closed=ready(),oldForm=find(closed.tree,'form');closed.tree.props.onClose();oldForm.props.onSubmit({preventDefault(){}})
  assert.equal(closed.closes,1);assert.equal(closed.audit.length,0)
  for(const change of [fx=>{fx.auth={authUser:{id:target},isAuthenticated:true}},fx=>{fx.props.targetUserId=reporter},fx=>{fx.auth={authUser:null,isAuthenticated:false}}]){
    let complete
    const fx=ready({rpc:()=>new Promise(resolve=>{complete=resolve})}),form=find(fx.tree,'form')
    submit(fx);change(fx);assert.equal(fx.render(),null)
    fx.auth={authUser:{id:reporter},isAuthenticated:true};fx.props.targetUserId=target
    assert.equal(fx.render(),null)
    complete({data:receipt,error:null});await flush();assert.equal(fx.get('receipt'),null)
    form.props.onSubmit({preventDefault(){}});assert.equal(fx.audit.length,1)
  }
  let complete
  const fx=ready({rpc:()=>new Promise(resolve=>{complete=resolve})});submit(fx);fx.unmount()
  const before=[...fx.states];complete({data:receipt,error:null});await flush();assert.deepEqual(fx.states,before)
})

function profile(auth={authUser:{id:reporter},isAuthenticated:true},profileId=target){
  const fx=fixture('src/pages/PublicProfilePage.tsx','PublicProfilePage')
  fx.auth=auth;fx.routeId=profileId;fx.set('profile',{id:profileId,full_name:'Тестовий профіль',username:'test_profile',categories:[]});fx.set('loading',false);fx.render();return fx
}
const reportButton=tree=>nodes(tree,node=>node.type==='button'&&text(node).trim()==='Поскаржитися')[0]

test('public profile exposes reports for any authenticated foreign profile, hides own reports and gates guests through AuthModal',()=>{
  const fx=profile();assert.ok(reportButton(fx.tree));reportButton(fx.tree).props.onClick()
  const dialog=named(fx.render(),'ProfileReportDialog');assert.ok(dialog);assert.equal(dialog.props.targetUserId,target);assert.equal(dialog.key,`${reporter}:${target}`)
  assert.equal(reportButton(profile({authUser:{id:reporter},isAuthenticated:true},reporter).tree),undefined)
  const guest=profile({authUser:null,isAuthenticated:false});reportButton(guest.tree).props.onClick()
  const guestTree=guest.render();assert.ok(named(guestTree,'AuthModal'));assert.equal(named(guestTree,'ProfileReportDialog'),undefined);assert.equal(guest.audit.length,0)
})

test('a profile route/account switch hides old report dialogs and cannot target a cached profile under a different ID',()=>{
  for(const change of [fx=>{fx.routeId=reporter},fx=>{fx.auth={authUser:{id:target},isAuthenticated:true}}]){
    const fx=profile(),oldButton=reportButton(fx.tree);oldButton.props.onClick();assert.ok(named(fx.render(),'ProfileReportDialog'))
    change(fx);const next=fx.render();assert.equal(named(next,'ProfileReportDialog'),undefined)
    const previous=fx.get('reportTarget');oldButton.props.onClick();assert.equal(fx.get('reportTarget'),previous)
  }
  const loading=profile();loading.set('loading',true);assert.equal(reportButton(loading.render()),undefined)
})

test('the shared dialog traps focus, blocks Escape/backdrop while busy, locks scroll and restores trigger focus',()=>{
  const events=[],document={body:{style:{overflow:'scroll'}},activeElement:null}
  const element=name=>({tabIndex:0,offsetParent:{},isConnected:true,focus(){document.activeElement=this;events.push(name)}})
  const trigger=element('trigger'),first=element('first'),rules=element('rules-link'),last=element('last')
  document.activeElement=trigger
  const panel={...element('panel'),querySelectorAll(selector){assert.match(selector,/a\[href\]/);return[first,rules,last]},contains(value){return[this,first,rules,last].includes(value)}}
  let closes=0
  const fx=fixture('src/components/CommunityChatPrimitives.tsx','ChatDialog',{title:'Поскаржитися',busy:false,onClose:()=>{closes++}},document)
  fx.ref('ref').current=panel;fx.commit();assert.equal(document.body.style.overflow,'hidden');assert.equal(document.activeElement,panel)
  const event=(key,shiftKey=false)=>({key,shiftKey,preventDefault(){this.prevented=true},stopPropagation(){}})
  const dialog=nodes(fx.render(),node=>node.props?.role==='dialog')[0]
  assert.equal(dialog.props['aria-modal'],'true');assert.equal(dialog.props['aria-label'],'Поскаржитися')
  document.activeElement=first;dialog.props.onKeyDown(event('Tab',true));assert.equal(document.activeElement,last)
  dialog.props.onKeyDown(event('Tab'));assert.equal(document.activeElement,first)
  fx.props.busy=true;const busyTree=fx.render(),busyDialog=nodes(busyTree,node=>node.props?.role==='dialog')[0]
  busyDialog.props.onKeyDown(event('Escape'));busyTree.props.onMouseDown({target:busyTree,currentTarget:busyTree});assert.equal(closes,0)
  fx.props.busy=false;const open=fx.render();nodes(open,node=>node.props?.role==='dialog')[0].props.onKeyDown(event('Escape'));assert.equal(closes,1)
  open.props.onMouseDown({target:open,currentTarget:open});assert.equal(closes,2)
  fx.unmount();assert.equal(document.body.style.overflow,'scroll');assert.equal(document.activeElement,trigger)
})
