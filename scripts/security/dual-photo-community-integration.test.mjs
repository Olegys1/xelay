import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const dataModule = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const source = await readFile(new URL('src/components/CommunityChatTimeline.tsx', root), 'utf8')
const parsed = ts.createSourceFile('CommunityChatTimeline.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CommunityChatTimeline')
const declarations = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
const stateNames = declarations.filter(node => ts.isCallExpression(node.initializer) && node.initializer.expression.getText(parsed) === 'useState').map(node => node.name.elements[0].name.text)
const refNames = declarations.filter(node => node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(parsed) === 'useRef').map(node => node.name.getText(parsed))
const fixture = { states: [], refs: [], stateCursor: 0, refCursor: 0, audit: [] }
globalThis.__dualPhotoCommunityFixture = fixture
globalThis.requestAnimationFrame = () => 0
globalThis.document = { visibilityState: 'visible' }

const react = dataModule(`const x=globalThis.__dualPhotoCommunityFixture;export const Fragment='Fragment';export const useState=initial=>{const i=x.stateCursor++;if(!(i in x.states))x.states[i]=typeof initial==='function'?initial():initial;return[x.states[i],v=>{x.states[i]=typeof v==='function'?v(x.states[i]):v}];};export const useRef=initial=>{const i=x.refCursor++;return x.refs[i]||=( {current:initial} );};export const useEffect=()=>{};export const useMemo=fn=>fn();export const useCallback=fn=>fn;`)
const jsx = dataModule(`export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment='Fragment';`)
const chatSource = await readFile(new URL('src/lib/chatSpaces.ts', root), 'utf8')
const chatParsed = ts.createSourceFile('chatSpaces.ts', chatSource, ts.ScriptTarget.Latest, true)
const validationSource = chatParsed.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['CHAT_MAX_FILES','CHAT_MAX_FILE_BYTES','CHAT_MAX_TOTAL_BYTES','safeTypes'].includes(item.name.getText(chatParsed))) || ts.isFunctionDeclaration(node) && node.name?.text === 'validateChatFiles').map(node => node.getText(chatParsed)).join('\n')
const modules = {
  react,
  'react/jsx-runtime': jsx,
  '../context/BillingContext': dataModule('export const useBilling=()=>({isPremium:true})'),
  '../context/ToastContext': dataModule('export const useToast=()=>({notify:()=>{}})'),
  '../lib/participantAppearance': dataModule('export const useParticipantAppearance=()=>({chatTheme:"default",chatWallpaper:"none"})'),
  '../hooks/useRecentItemMotion': dataModule('export const useRecentItemMotion=()=>new Set()'),
  '../lib/chatSpaces': dataModule(compile(`${validationSource}\nconst x=globalThis.__dualPhotoCommunityFixture;export const chatRpc=async(name,args)=>{x.audit.push({name,args});return[];};export const uploadChatFiles=async(space,user,files)=>{x.audit.push({name:'upload',space,user,files});return files.map(file=>({storage_path:'private/'+file.name,file_name:file.name}));};export const signChatPosts=async posts=>posts;export const loadChatProfiles=async()=>({});export const announceChatUpdate=()=>{};export const chatError=error=>error.message;export const discardChatFiles=async()=>{};export const cleanupDetachedChatFiles=async()=>true;`)),
}
for (const node of parsed.statements.filter(ts.isImportDeclaration)) {
  const specifier = node.moduleSpecifier.text
  if (modules[specifier] || !node.importClause) continue
  const names = node.importClause.namedBindings?.elements?.filter(item => !item.isTypeOnly).map(item => item.propertyName?.text || item.name.text) || []
  modules[specifier] = dataModule(names.map(name => name === 'supabase' ? 'export const supabase={}' : `export function ${name}(){return null}`).join(';'))
}
let compiled = compile(source).replace(/^import ['"][^'"]+\.css['"];?\s*$/gm, '')
for (const [specifier, url] of Object.entries(modules)) compiled = compiled.replaceAll(`from '${specifier}'`, `from ${JSON.stringify(url)}`).replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`)
const { CommunityChatTimeline } = await import(dataModule(compiled))

const initialDetail = () => ({ space: { id: 'space-a', kind: 'group', comments_enabled: true }, my_membership: { role: 'member' }, members: [], pins: [] })
const file = (name='dual-photo.jpg', size=1000, type='image/jpeg') => ({ name, size, type })
const setState = (name, value) => { fixture.states[stateNames.indexOf(name)] = value }
const getState = name => fixture.states[stateNames.indexOf(name)]
const getRef = name => fixture.refs[refNames.indexOf(name)]
function setup(overrides={}) {
  fixture.states=[];fixture.refs=[];fixture.audit=[]
  const props={ detail:initialDetail(),userId:'user-a',onRefresh:async()=>{},...overrides }
  const render=()=>{fixture.stateCursor=0;fixture.refCursor=0;return CommunityChatTimeline(props)}
  return {props,render}
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree,...nodes(tree.props?.children)]
}
const modal = tree => nodes(tree).find(node => node.type?.name === 'DualPhotoCapture')
function open(fx) {
  let tree=fx.render()
  const attachment=nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='Додати файл, подвійне фото, опитування або статтю')
  assert.ok(attachment&&!attachment.props.disabled)
  attachment.props.onClick();tree=fx.render()
  const action=nodes(tree).find(node=>node.props?.['aria-label']==='Зробити подвійне фото для повідомлення')
  assert.ok(action&&!action.props.disabled)
  action.props.onClick();tree=fx.render()
  assert.ok(modal(tree))
  return modal(tree).props
}

test('group capture adds one validated draft attachment and preserves optional text until manual send',async()=>{
  const fx=setup();fx.render();setState('draft','Після пари');setState('files',[file('existing.png')])
  const camera=open(fx),photo=file()
  assert.equal(camera.onCapture(photo),true)
  assert.deepEqual(getState('files').map(item=>item.name),['existing.png','dual-photo.jpg'])
  assert.equal(getState('draft'),'Після пари')
  assert.equal(fixture.audit.length,0)
  assert.equal(modal(fx.render()),undefined)
  assert.equal(camera.onCapture(file('duplicate.jpg')),false)
  nodes(fx.render()).find(node=>node.type==='form').props.onSubmit({preventDefault(){}})
  await new Promise(resolve=>setImmediate(resolve))
  const upload=fixture.audit.find(call=>call.name==='upload')
  const send=fixture.audit.find(call=>call.name==='xelay_chat_send')
  assert.deepEqual(upload.files.map(item=>item.name),['existing.png','dual-photo.jpg'])
  assert.equal(upload.space,'space-a');assert.equal(upload.user,'user-a')
  assert.equal(send.args.p_body,'Після пари');assert.equal(send.args.p_parent_post_id,null)
})

test('group capture keeps existing count, MIME, per-file and total limits and allows retry after rejection',()=>{
  const cases=[
    {existing:Array.from({length:10},(_,i)=>file(`existing-${i}.jpg`)),photo:file()},
    {existing:[],photo:file('large.jpg',25*1024*1024+1)},
    {existing:[],photo:file('unsafe.html',100,'text/html')},
    {existing:Array.from({length:4},(_,i)=>file(`existing-${i}.jpg`,25*1024*1024)),photo:file()},
  ]
  for(const item of cases){
    const fx=setup();fx.render();setState('files',item.existing)
    const camera=open(fx)
    assert.equal(camera.onCapture(item.photo),false)
    assert.deepEqual(getState('files'),item.existing)
    assert.ok(getState('error'));assert.ok(modal(fx.render()));assert.equal(fixture.audit.length,0)
    setState('files',[]);fx.render()
    assert.equal(camera.onCapture(file('retry.jpg')),true)
    assert.equal(getState('files')[0].name,'retry.jpg')
  }
})

test('channel publication permission and disabled comments never expose a camera session',()=>{
  for(const override of [
    {detail:{...initialDetail(),space:{...initialDetail().space,kind:'channel'}}},
    {detail:{...initialDetail(),space:{...initialDetail().space,comments_enabled:false}},parentPost:{id:'parent',body:'Публікація'}},
  ]){
    const fx=setup(override),tree=fx.render()
    assert.equal(nodes(tree).some(node=>node.type==='form'),false)
    assert.equal(modal(tree),undefined)
  }
  const detail=initialDetail();detail.space.kind='channel';detail.my_membership.role='admin'
  const fx=setup({detail}),camera=open(fx)
  detail.my_membership.role='member'
  assert.equal(modal(fx.render()),undefined)
  assert.equal(camera.onCapture(file()),false)
  assert.deepEqual(getState('files'),[])
})

test('editing, sending, revoked comments, another modal and unmount reject pending results',()=>{
  for(const change of [
    ()=>setState('editing',{id:'edit',body:'Текст',attachments:[]}),
    ()=>setState('busy','send'),
    ()=>setState('publicationEditor',{kind:'poll'}),
    ()=>setState('comments',{id:'other-parent'}),
  ]){
    const fx=setup(),camera=open(fx);change()
    assert.equal(modal(fx.render()),undefined);assert.equal(camera.onCapture(file()),false)
    assert.deepEqual(getState('files'),[])
  }
  const fx=setup({parentPost:{id:'parent',body:'Публікація'}}),camera=open(fx)
  fx.props.detail.space.comments_enabled=false
  assert.equal(modal(fx.render()),undefined);assert.equal(camera.onCapture(file()),false)
  const unmounted=setup(),pending=open(unmounted);getRef('alive').current=false
  assert.equal(pending.onCapture(file()),false)
})

test('space, account and parent changes invalidate old sessions permanently, including after returning',()=>{
  for(const change of [
    props=>{props.detail={...props.detail,space:{...props.detail.space,id:'space-b'}}},
    props=>{props.userId='user-b'},
    props=>{props.parentPost={id:'parent-b',body:'Публікація'}},
  ]){
    const fx=setup(),original={...fx.props},old=open(fx)
    change(fx.props)
    assert.equal(modal(fx.render()),undefined);assert.equal(old.onCapture(file()),false)
    Object.assign(fx.props,original);fx.render()
    const fresh=open(fx);old.onClose()
    assert.ok(modal(fx.render()));assert.equal(old.onCapture(file('stale.jpg')),false)
    assert.equal(fresh.onCapture(file('current.jpg')),true)
    assert.deepEqual(getState('files').map(item=>item.name),['current.jpg'])
    assert.equal(fixture.audit.length,0)
  }
})

test('an in-flight mutation prevents opening and accepting the camera even before a state render',()=>{
  const fx=setup(),camera=open(fx)
  getRef('mutation').current=true
  assert.equal(camera.onCapture(file()),false)
  assert.equal(fixture.audit.length,0)
  assert.deepEqual(getState('files'),[])
})
