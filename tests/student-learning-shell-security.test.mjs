import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import postcss from 'postcss'

const root=new URL('../',import.meta.url),compile=file=>ts.transpileModule(readFileSync(new URL(file,root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
const owner={id:'shell-owner',email:'owner@example.invalid'},profile={id:owner.id,name:'Марія Студентка',firstName:'Марія',avatarUrl:'https://example.invalid/own-avatar.png',studyGroupIds:['own-group'],accountType:'student',isTeacher:false,has_seen_onboarding:true}
const sameDeps=(a,b)=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]))
const all=(node,result=[])=>{if(Array.isArray(node)){for(const item of node)all(item,result)}else if(node&&typeof node==='object'&&node.props){result.push(node);all(node.props.children,result)}return result}
const text=node=>Array.isArray(node)?node.map(text).join(' '):node&&typeof node==='object'?text(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):''

/** Executes the real Header hooks and its real unread scheduler. Every API,
 * channel and event is synthetic; route switches do not create a second header. */
function harness(options={}){
 const auth={isAuthenticated:true,authUser:{...owner},xelayUser:{...profile},...options.auth},location={pathname:options.pathname||'/',searchStr:''},state=[],effects=[],refs=[],memos=[],timers=new Map(),handlers=new Map(),dom=new Map(),channels=[],removed=[],calls=[],navigations=[],refresherCounts={created:0,disposed:0}
 let cursor=0,dirty=false,tree,queued=[],timerId=0,authRequests=0
 const eventTarget=prefix=>({addEventListener(name,listener){const key=prefix+name,list=handlers.get(key)||new Set();list.add(listener);handlers.set(key,list)},removeEventListener(name,listener){handlers.get(prefix+name)?.delete(listener)}})
 const setTimer=(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id},clearTimer=id=>timers.delete(id)
 const window={...eventTarget('window:'),setTimeout:setTimer,clearTimeout:clearTimer,setInterval:setTimer,clearInterval:clearTimer,matchMedia:()=>({matches:options.mobile===true}),location:{href:'https://www.xelay.ink/'}}
 const document={...eventTarget('document:'),visibilityState:'visible',documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}}}
 const hooks={
  useState(initial){const at=cursor++;if(!(at in state))state[at]=typeof initial==='function'?initial():initial;return[state[at],value=>{const next=typeof value==='function'?value(state[at]):value;if(!Object.is(next,state[at])){state[at]=next;dirty=true}}]},
  useRef(initial){const at=cursor++;return refs[at]||(refs[at]={current:initial})},
  useEffect(effect,deps){const at=cursor++,prior=effects[at];if(!sameDeps(prior?.deps,deps))queued.push(()=>{prior?.cleanup?.();effects[at]={deps,cleanup:effect()}})},
  useMemo(factory,deps){const at=cursor++;if(!sameDeps(memos[at]?.deps,deps))memos[at]={deps,value:factory()};return memos[at].value},
  useCallback(callback,deps){return hooks.useMemo(()=>callback,deps)},
 }
 hooks.useLayoutEffect=hooks.useEffect
 const jsx=(type,props)=>{const node={type,props:props||{}};if(typeof type==='string'&&props?.ref&&typeof props.ref==='object'){const key=props.id||type+':'+props.className;if(!dom.has(key))dom.set(key,{...eventTarget('dom:'+key+':')});props.ref.current=dom.get(key)}return node},navigate=value=>navigations.push(value)
 const scheduler={};vm.runInNewContext(compile('src/lib/notificationUnreadRefresh.ts'),{exports:scheduler,window,document,Date,AbortController})
 const realCreate=scheduler.createNotificationUnreadRefresher
 scheduler.createNotificationUnreadRefresher=value=>{refresherCounts.created++;const result=realCreate(value),dispose=result.dispose;result.dispose=()=>{refresherCounts.disposed++;dispose()};return result}
 const supabase={
  rpc(name,args){const call={kind:'rpc',name,args};calls.push(call);const value=options.rpc?.(name,args)||Promise.resolve({data:name==='xelay_notification_counts'?{badge_count:2}:0,error:null});return Object.assign(value,{abortSignal:signal=>{call.signal=signal;return value}})},
  from(table){return{select(columns,settings){const query={eq(column,value){calls.push({kind:'select',table,columns,settings,column,value});return query},is(){return Promise.resolve({count:0,error:null})}};return query}}},
  channel(name){const channel={name,on(){return channel},subscribe(){return channel}};channels.push(channel);return channel},
  removeChannel(channel){removed.push(channel);return Promise.resolve('ok')},
 }
 const components={BurgerMenu:()=>null,NotificationPanel:()=>null,ThemeToggle:()=>null,XelayLogo:()=>null,HalloweenHat:()=>null}
 const module={exports:{}}
 vm.runInNewContext(compile('src/components/Header.tsx'),{module,exports:module.exports,window,document,URL,URLSearchParams,Date,Promise,Set,Map,Number,Math,console,AbortController,setTimeout:setTimer,clearTimeout:clearTimer,require(name){
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'}
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)})
  if(name==='@tanstack/react-router')return{useNavigate:()=>navigate,useRouterState:({select})=>select({location})}
  if(name==='../context/AuthContext')return{useAuth:()=>auth}
  if(name==='../context/BillingContext')return{useBilling:()=>({isPremium:true})}
  if(name==='../context/NotificationPreferencesContext')return{useNotificationPreferences:()=>({preferences:{notificationsEnabled:true,categorySettings:{}}})}
  if(name==='../lib/supabase')return{supabase}
  if(name==='../hooks/useTranslation')return{useTranslation:()=>({t:key=>({profile:'Профіль',signIn:'Увійти'}[key]||key)})}
  if(name==='../lib/onboarding')return{guideKey:()=>'',hasSeenGuide:()=>true,rememberGuide(){}}
  if(name==='../lib/notificationUnreadRefresh')return scheduler
  if(name==='../lib/birthdayGifts')return{BIRTHDAY_REFRESH_EVENT:'birthday-test'}
  if(name==='../lib/appreciationGifts')return{APPRECIATION_REFRESH_EVENT:'appreciation-test'}
  if(name.endsWith('.css'))return{}
  const component=components[name.split('/').at(-1)];if(component)return{[name.split('/').at(-1)]:component}
  throw Error('Unexpected Header dependency '+name)
 }})
 const props={onAuthRequest(){authRequests++}}
 const render=()=>{let count=0;do{dirty=false;cursor=0;queued=[];tree=module.exports.Header(props);for(const effect of queued)effect();if(++count>30)throw Error('Header render loop')}while(dirty);return tree}
 const settle=async()=>{for(let index=0;index<5;index++){await Promise.resolve();if(dirty)render()}}
 render()
 return{auth,location,calls,channels,removed,navigations,refresherCounts,render,settle,get tree(){return tree},get authRequests(){return authRequests},snapshots:()=>state.filter(value=>value&&typeof value==='object'&&'userId'in value&&'count'in value),nodes:()=>all(tree),button:label=>all(tree).find(node=>node.type==='button'&&(node.props['aria-label']===label||text(node)===label)),emitNavigationClick(){for(const listener of handlers.get('dom:xelay-learning-navigation:click')||[])listener({target:{closest:()=>({tagName:'BUTTON'})}})},listeners:name=>handlers.get(name)?.size||0,unmount(){for(const effect of effects)effect?.cleanup?.()},timers}
}

test('one real Header retains one set of scoped unread subscriptions across route changes',async()=>{
 const h=harness();await h.settle();assert.equal(h.channels.length,2);assert.equal(h.refresherCounts.created,1);assert.equal(h.calls.filter(call=>call.name==='xelay_notification_counts').length,1)
 const listeners=h.listeners('window:focus'),readCount=h.calls.length
 for(const pathname of['/learning','/messages','/learning','/teaching','/']){h.location.pathname=pathname;h.render();await h.settle()}
 assert.equal(h.channels.length,2);assert.equal(h.refresherCounts.created,1);assert.equal(h.calls.length,readCount);assert.equal(h.listeners('window:focus'),listeners)
 h.unmount();assert.equal(h.removed.length,2);assert.equal(h.refresherCounts.disposed,1);assert.equal(h.listeners('window:focus'),0);assert.equal(h.timers.size,0)
})

test('guest navigation cannot subscribe to personal counts or expose a previous profile',async()=>{
 const h=harness({pathname:'/learning',auth:{isAuthenticated:false,authUser:null,xelayUser:null}});await h.settle()
 assert.equal(h.channels.length,0);assert.equal(h.calls.length,0);assert.equal(h.refresherCounts.created,0);assert.equal(text(h.tree).includes(profile.name),false)
 h.unmount();assert.equal(h.timers.size,0)
})

test('account replacement aborts the old unread read, replaces only scoped listeners and ignores its late result',async()=>{
 let releaseOld;const pending=new Promise(resolve=>{releaseOld=resolve})
 const h=harness({rpc:(name,args)=>name==='xelay_notification_counts'&&args.p_expected_user_id===owner.id?pending:undefined})
 await h.settle();const oldRead=h.calls.find(call=>call.name==='xelay_notification_counts');assert.equal(oldRead.signal.aborted,false)
 h.auth.authUser={id:'replacement-owner',email:'replacement@example.invalid'};h.auth.xelayUser={...profile,id:'replacement-owner',name:'Новий Власник',avatarUrl:undefined};h.render();await h.settle()
 assert.equal(oldRead.signal.aborted,true);assert.equal(h.channels.length,4);assert.equal(h.removed.length,2);assert.equal(h.refresherCounts.created,2);assert.equal(h.refresherCounts.disposed,1)
 assert.deepEqual(h.channels.slice(2).map(channel=>channel.name).sort(),['header-direct-replacement-owner','header-notifications-replacement-owner'])
 releaseOld({data:{badge_count:99},error:null});await h.settle();assert.deepEqual(JSON.parse(JSON.stringify(h.snapshots())),[{userId:'replacement-owner',count:2}]);assert.equal(text(h.tree).includes(profile.name),false)
 h.auth.authUser=null;h.auth.xelayUser=null;h.auth.isAuthenticated=false;h.render();await h.settle();assert.equal(h.removed.length,4);assert.equal(h.refresherCounts.disposed,2)
 h.unmount();assert.equal(h.listeners('window:focus'),0);assert.equal(h.timers.size,0)
})

test('only the exact learning route owns one navigation slot while ordinary routes keep their normal header',async()=>{
 const h=harness({pathname:'/learning'});await h.settle()
 assert.equal(h.nodes().filter(node=>node.type==='header').length,1);assert.equal(h.nodes().filter(node=>node.props.id==='xelay-learning-navigation').length,1)
 assert.equal(h.nodes().find(node=>node.type==='header').props['data-learning-immersive'],true)
 assert.equal(h.button('Відкрити меню навігації').props['aria-controls'],'xelay-learning-navigation');assert.equal(h.listeners('dom:xelay-learning-navigation:click'),1)
 assert.equal(h.nodes().filter(node=>node.props.className?.includes('xelay-header-profile')).length,1);assert.equal(typeof h.button('Профіль').props.onClick,'function')
 h.button('Профіль').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)),[{to:'/profile'}]);assert.equal(h.nodes().some(node=>node.type==='input'&&node.props.type==='password'),false)
 for(const pathname of['/learning/','/learning-copy','/teaching','/groups','/messages']){h.location.pathname=pathname;h.render();await h.settle();assert.equal(h.nodes().some(node=>node.props.id==='xelay-learning-navigation'),false,pathname);assert.equal(h.nodes().find(node=>node.type==='header').props['data-learning-immersive'],undefined,pathname);assert.equal(h.listeners('dom:xelay-learning-navigation:click'),0,pathname)}
 h.unmount()
})

test('bottom profile and teacher navigation never borrow the previous account identity or role',async()=>{
 const h=harness({pathname:'/learning',auth:{xelayUser:{...profile,isTeacher:true,accountType:'teacher'}}});await h.settle()
 assert.ok(h.button('Викладання'));h.button('Викладання').props.onClick();assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)),[{to:'/teaching'}]);assert.ok(h.nodes().find(node=>node.type==='img'&&node.props.src===profile.avatarUrl))
 h.auth.authUser={id:'new-owner',email:'new@example.invalid'};h.render();await h.settle()
 assert.equal(h.button('Викладання'),undefined);assert.equal(h.button('Мої навчальні групи'),undefined);assert.equal(h.nodes().some(node=>node.type==='img'&&node.props.src===profile.avatarUrl),false);assert.equal(text(h.tree).includes('Марія'),false)
 h.auth.xelayUser={...profile,id:'new-owner',name:'Олена Нова',accountType:'student',isTeacher:false};h.render();await h.settle();assert.equal(h.button('Викладання'),undefined);assert.ok(text(h.button('Профіль')).includes('Олена'))
 h.auth.authUser=null;h.auth.isAuthenticated=false;h.render();await h.settle();const before=h.navigations.length;h.button('Профіль').props.onClick();h.button('Повідомлення').props.onClick();h.button('Сповіщення').props.onClick();assert.equal(h.authRequests,3);assert.equal(h.navigations.length,before);assert.equal(text(h.tree).includes('Олена'),false)
 h.unmount()
})

test('mobile rail opens once and closes by section navigation, scrim and route change without extra reads',async()=>{
 const h=harness({pathname:'/learning',mobile:true});await h.settle();const initialReads=h.calls.length
 const open=async()=>{h.button('Відкрити меню навігації').props.onClick();h.render();await h.settle();assert.equal(h.nodes().find(node=>node.type==='header').props['data-learning-open'],true);assert.equal(h.nodes().filter(node=>node.props.className==='xelay-learning-scrim').length,1)}
 await open();h.emitNavigationClick();h.render();assert.equal(h.nodes().find(node=>node.type==='header').props['data-learning-open'],false)
 await open();h.nodes().find(node=>node.props.className==='xelay-learning-scrim').props.onClick();h.render();assert.equal(h.nodes().find(node=>node.type==='header').props['data-learning-open'],false)
 await open();h.location.pathname='/groups';h.render();await h.settle();assert.equal(h.nodes().some(node=>node.props.className==='xelay-learning-scrim'),false);assert.equal(h.calls.length,initialReads);assert.equal(h.channels.length,2)
 h.unmount();assert.equal(h.listeners('dom:xelay-learning-navigation:click'),0)
})

test('the roomy route keeps the protected application outlet and changes only global visual chrome',()=>{
 const source=ts.createSourceFile('App.tsx',readFileSync(new URL('src/App.tsx',root),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),nodes=[]
 const visit=node=>{nodes.push(node);ts.forEachChild(node,visit)};visit(source)
 const layout=nodes.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='RootLayout');assert.ok(layout)
 const descendants=node=>{const found=[];const walk=child=>{found.push(child);ts.forEachChild(child,walk)};walk(node);return found}
 const layoutNodes=descendants(layout),tag=node=>ts.isJsxElement(node)?node.openingElement.tagName.getText(source):ts.isJsxSelfClosingElement(node)?node.tagName.getText(source):''
 assert.equal(layoutNodes.filter(node=>tag(node)==='Header').length,1)
 const protectedOutlet=layoutNodes.find(node=>ts.isConditionalExpression(node)&&tag(node.whenFalse)==='AdminSecurityGate');assert.ok(protectedOutlet,'Protected pages retain their existing gate branch')
 const publicAudience=layoutNodes.find(node=>ts.isVariableDeclaration(node)&&node.name.getText(source)==='publicAudience');assert.ok(publicAudience)
 const audienceValue=vm.runInNewContext(publicAudience.initializer.getText(source),{pathname:'/learning'});assert.equal(audienceValue,false)
 assert.equal(vm.runInNewContext(protectedOutlet.condition.getText(source),{pathname:'/learning',publicAudience:audienceValue}),false,'Learning must enter protected branch')
 const gates=descendants(protectedOutlet.whenFalse).map(tag);for(const name of['GoogleRegistrationGate','PrivacyConsentNotice','ApplicationOnboarding','Outlet'])assert.ok(gates.includes(name),name)
 const footer=layoutNodes.find(node=>tag(node)==='SiteFooter');assert.ok(footer);const footerGuard=footer.parent;assert.ok(ts.isBinaryExpression(footerGuard)&&footerGuard.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken)
 assert.equal(vm.runInNewContext(footerGuard.left.getText(source),{immersiveLearning:true}),false);assert.equal(vm.runInNewContext(footerGuard.left.getText(source),{immersiveLearning:false}),true,'Other pages retain their footer')
})

test('legacy desktop and mobile canvas widths cannot override the immersive rail layout later in the stylesheet',()=>{
 const sheet=postcss.parse(readFileSync(new URL('src/pages/studentLearningPage.css',root),'utf8')),immersive=[];let mobileWidth
 sheet.walkRules(rule=>{
  for(const selector of rule.selectors){
   if(selector.includes('.slp-workspace')&&selector.includes(':has(.mls-production)')){
    const writesCanvas=selector.trim().endsWith(':has(.mls-production)')&&rule.nodes.some(node=>node.type==='decl'&&/^(?:width|max-width|padding(?:-top|-bottom)?)$/.test(node.prop))
    if(writesCanvas)assert.ok(selector.includes(':not(.slp-immersive)'),`Legacy canvas rule may clip the chat: ${selector}`)
   }
   if(selector==='.slp.slp-immersive'&&rule.parent.type==='root')for(const declaration of rule.nodes)if(declaration.type==='decl')immersive.push([declaration.prop,declaration.value])
   if(selector==='.slp.slp-immersive'&&rule.parent.type==='atrule'&&/max-width:\s*767px/.test(rule.parent.params))rule.walkDecls('width',decl=>{mobileWidth=decl.value})
  }
 })
 const properties=Object.fromEntries(immersive);assert.equal(properties.width,'calc(100% - var(--xelay-learning-rail-width, 248px))');assert.equal(properties['max-width'],'none');assert.equal(properties.padding,'0');assert.equal(mobileWidth,'100%')
 assert.equal(properties.height,'calc(100dvh - var(--xelay-learning-top-inset, 0px))')
})
