// Real current teaching components/helpers; synthetic hooks and already-scoped
// repository responses only. List exceptions never establish data-access rights.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const root=new URL('../../',import.meta.url)
const read=path=>readFileSync(new URL(path,root),'utf8')
const plain=value=>JSON.parse(JSON.stringify(value))
const OLEG='04f587f8-1604-4f53-aabc-d1699c938b1d',MISHA='b6d61792-89c5-48af-ad52-73806352ae61'
const OTHER='99999999-9999-4999-8999-999999999999',REGULAR='77777777-7777-4777-8777-777777777777'
const HIDDEN=['437c96ae-19d1-4bed-ae69-0b83ae9ec1b4','445fcadc-95e2-4f8c-bfb3-6d0998030a01']
const COURSE='88888888-8888-4888-8888-888888888888'
const groups=[{group_id:REGULAR,group_name:'Regular group',status:'accepted'},...HIDDEN.map((group_id,index)=>({group_id,group_name:'Hidden group '+(index+1),status:'accepted'}))]
const course={id:COURSE,title:'Example subject',semester:'Autumn 2026',starts_on:'2026-09-01',ends_on:'2026-12-31',archived_at:null,permissions:['materials','assignments','grades','manage'],grading_rules:{categories:[]}}
const snapshot=()=>({course,groups,teachers:[],entries:[],activities:[],assignments:[],materials:[],grades:[],audit:[],roster_claims:[],members:[],seminars:{seminars:[],questions:[],teams:[],reservations:[],profiles:{}}})
const target=groupId=>({groupId,lessonDate:'2026-11-02',scheduleItemId:'',placementMode:'unplaced',deadline:'',deadlineMode:'free',closesAt:''})
const nodes=node=>node==null||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(nodes):[node,...nodes(node.props?.children)]
const text=node=>node==null||typeof node==='boolean'?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.props?.children):String(node)

function renderer(){
  const cells=[],effects=[],unexpected=[],cache=new Map(),components=new Map()
  let index=0,dirty=false,tree,component,props
  const fail=name=>(..._args)=>{unexpected.push(name);throw Error('Unexpected visibility-test transport '+name)}
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i]))
  const hooks={
    useState(initial){const i=index++;if(!cells[i]){const cell={value:typeof initial==='function'?initial():initial};cell.set=next=>{const value=typeof next==='function'?next(cell.value):next;if(!Object.is(value,cell.value)){cell.value=value;dirty=true}};cells[i]=cell}return [cells[i].value,cells[i].set]},
    useRef(initial){const i=index++;return cells[i]??={current:initial}},useId(){return 'visibility-'+index++},
    useCallback(callback,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,callback};return cells[i].callback},
    useMemo(callback,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:callback()};return cells[i].value},
    useEffect(callback,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const previous=cells[i];cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[i].cleanup=callback()})}},
    lazy(){return 'UnopenedViewer'},Suspense:'Suspense',memo:value=>value,
  }
  const jsx=(type,props,key)=>({type,props,key}),runtime={jsx,jsxs:jsx,Fragment:'fragment'}
  const icons=new Proxy({},{get:(_,name)=>String(name)})
  const ui=Object.fromEntries(['TeachingButton','TeachingEmpty','TeachingField','TeachingModal'].map(name=>[name,name]));ui.teachingInput='input'
  const browserStorage=new Map(),window={addEventListener(){},removeEventListener(){},setTimeout,clearTimeout,sessionStorage:{getItem:key=>browserStorage.get(key)||null,setItem:(key,value)=>browserStorage.set(key,value),removeItem:key=>browserStorage.delete(key)}}
  const globals={URL,Date,Intl,Error,TypeError,RangeError,TextEncoder,TextDecoder,AbortController,DOMException,Blob,File,Uint8Array,ArrayBuffer,Buffer,queueMicrotask,setTimeout,clearTimeout,crypto:{randomUUID},window,
    document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},requestAnimationFrame:callback=>{callback();return 1},cancelAnimationFrame(){},
    fetch:fail('fetch'),XMLHttpRequest:fail('XHR'),__visibilityEnv:{VITE_SUPABASE_URL:'https://visibility.invalid',VITE_SUPABASE_ANON_KEY:'SYNTHETIC_NOT_A_CREDENTIAL',MODE:'test',DEV:false,PROD:false}}
  function evaluate(source,imports,exports={}){
    const output=ts.transpileModule(source.replaceAll('import.meta.env','__visibilityEnv'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    new Function('exports','require',...Object.keys(globals),output)(exports,imports,...Object.values(globals));return exports
  }
  function real(name){
    if(name==='supabase')return {supabase:new Proxy({},{get:(_,property)=>fail('supabase.'+String(property))()})}
    if(name==='teachingJournalWorkbook')return {exportTeachingJournalWorkbook:fail('workbook export')}
    if(cache.has(name))return cache.get(name)
    assert.match(name,/^[A-Za-z][A-Za-z0-9]*$/)
    const exports={};cache.set(name,exports)
    return evaluate(read('src/lib/'+name+'.ts'),specifier=>{if(specifier==='react')return hooks;assert.match(specifier,/^\.\/[A-Za-z][A-Za-z0-9]*$/);return real(specifier.slice(2))},exports)
  }
  function load(name){
    if(components.has(name))return components.get(name)
    let source=read('src/components/teaching/'+name+'.tsx')
    if(name==='TeachingMaterialLibrary')source+='\nexport {LibraryContents};'
    const ast=ts.createSourceFile(name+'.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),imports={}
    for(const statement of ast.statements.filter(ts.isImportDeclaration)){
      const specifier=statement.moduleSpecifier.text
      if(statement.importClause?.isTypeOnly)continue
      if(specifier==='react')imports[specifier]=hooks
      else if(specifier==='react/jsx-runtime')imports[specifier]=runtime
      else if(specifier==='lucide-react')imports[specifier]=icons
      else if(specifier==='./TeachingUI')imports[specifier]=ui
      else if(specifier.startsWith('../../lib/'))imports[specifier]=real(specifier.slice('../../lib/'.length))
      else if(specifier==='./TeachingPublicationTimingFields')imports[specifier]=load('TeachingPublicationTimingFields')
      else if(specifier.endsWith('.css'))imports[specifier]={}
      else if(specifier.startsWith('./')){
        imports[specifier]={}
        for(const named of statement.importClause?.namedBindings?.elements||[])if(!named.isTypeOnly)imports[specifier][named.propertyName?.text||named.name.text]=named.propertyName?.text||named.name.text
      }else assert.fail('Unknown current component import '+specifier)
    }
    imports['react/jsx-runtime']=runtime
    const result=evaluate(source,specifier=>{assert.ok(Object.hasOwn(imports,specifier),'Known current UI import '+specifier);return imports[specifier]})
    components.set(name,result);return result
  }
  function unmount(){for(const cell of cells)cell?.cleanup?.()}
  function render(){for(let pass=0;pass<30;pass++){dirty=false;index=0;tree=component(props);effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Visibility rendering did not settle')}
  return {load,real,render,unmount,get tree(){return tree},mount(name,exportName,nextProps){unmount();cells.length=0;effects.length=0;component=load(name)[exportName];props=nextProps;return render()},
    find(predicate){const value=nodes(tree).find(predicate);assert.ok(value,'Current visible element');return value},
    async flush(){for(let pass=0;pass<18;pass++){await Promise.resolve();render()}},assertSafe(){assert.deepEqual(unexpected,[])}}
}
function setup(t){const r=renderer();t.after(()=>{r.unmount();r.assertSafe()});return r}
function expected(viewerId){return [REGULAR,...([OLEG,MISHA].includes(viewerId)?HIDDEN:[])]}
const optionIds=tree=>nodes(tree).filter(node=>node.type==='option'&&[REGULAR,...HIDDEN].includes(node.props.value)).map(node=>node.props.value)
const names=tree=>groups.filter(group=>text(tree).includes(group.group_name)).map(group=>group.group_id)

for(const viewerId of [OLEG,MISHA,OTHER,undefined]){
  const label=viewerId===OLEG?'Oleg':viewerId===MISHA?'Misha':viewerId?'another administrator':'missing viewer'
  test(`${label}: colleague group choices and bulk selection use viewer identity, not colleague identity`,t=>{
    const r=setup(t),changes=[],scope={group_scope:'selected',group_ids:[HIDDEN[0]]}
    r.mount('TeachingColleagueScope','TeachingColleagueScope',{groups,scope,viewerId,permissions:['materials'],onScope:value=>changes.push(plain(value)),onPermissions(){}})
    assert.deepEqual(nodes(r.tree).filter(node=>node.type==='input'&&node.props.type==='checkbox').slice(0,expected(viewerId).length).map(node=>node.props.checked),expected(viewerId).map(id=>scope.group_ids.includes(id)))
    assert.deepEqual(names(r.tree),expected(viewerId))
    r.find(node=>node.type==='button').props.onClick()
    assert.deepEqual(changes[0].group_ids,[OLEG,MISHA].includes(viewerId)?[REGULAR,...HIDDEN]:[HIDDEN[0],REGULAR])
  })
  test(`${label}: multi-group controls and confirmation preview expose only the viewer's listed groups`,t=>{
    const r=setup(t),targets=groups.map(group=>target(group.group_id))
    r.mount('TeachingMultiAssignmentTargets','TeachingMultiAssignmentTargets',{viewerId,groups,targets,repository:{},course,disabled:false,onChange(){},onValidityChange(){}})
    assert.deepEqual(nodes(r.tree).filter(node=>node.props?.name?.startsWith('multi-assignment-group-')).map(node=>node.props.name.slice('multi-assignment-group-'.length)),expected(viewerId))
    r.mount('TeachingMultiAssignmentTargets','TeachingMultiAssignmentPreview',{viewerId,groups,targets,lessonLabels:{}})
    assert.deepEqual(names(r.tree),expected(viewerId))
  })
  test(`${label}: journal and submission-review selectors keep their existing access-filtered group data`,async t=>{
    const r=setup(t)
    r.mount('TeachingGradebook','TeachingGradebook',{snapshot:snapshot(),repository:{},userId:viewerId||OTHER,onRefresh:async()=>{}})
    assert.deepEqual(optionIds(r.tree),expected(viewerId))
    r.mount('TeachingSubmissionReview','TeachingSubmissionReview',{snapshot:snapshot(),repository:{},userId:viewerId||OTHER,onRefresh:async()=>{}})
    assert.deepEqual(optionIds(r.tree),expected(viewerId))
  })
  test(`${label}: material group editor hides labels without removing already-stored hidden targets`,async t=>{
    const r=setup(t),writes=[]
    const material={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',course_id:COURSE,title:'Existing material',body:'',links:[],attachments:[],targets:[{group_id:REGULAR},{group_id:HIDDEN[0]}],version:3,status:'published',can_edit:false,can_manage_groups:true,withdrawn_at:null}
    r.mount('TeachingMaterialLibraryEditor','TeachingMaterialLibraryEditor',{material,data:{materials:[material],courses:[{course,groups,colleagues:[]}]},repository:{mode:'synthetic',mutate:async(action,payload)=>{writes.push({action,payload:plain(payload)})}},userId:viewerId||OTHER,initialSection:'groups',onSaved:async()=>{},onClose(){}})
    assert.deepEqual(nodes(r.tree).filter(node=>node.props?.name?.startsWith('library-material-group-')).map(node=>node.props.name.slice('library-material-group-'.length)),expected(viewerId))
    await r.find(node=>node.type==='form').props.onSubmit({preventDefault(){}})
    assert.equal(writes.length,1);assert.equal(writes[0].action,'save_library_material')
    assert.deepEqual(writes[0].payload.target_group_ids,[REGULAR,HIDDEN[0]])
  })
  test(`${label}: scheduled-publication and grade-request group lists receive the actual actor`,async t=>{
    const r=setup(t),scheduled={id:'schedule',course_id:COURSE,course_title:'Example',title:'Scheduled item',body:'',kind:'assignment',status:'scheduled',publish_at:'2030-01-01T12:00:00Z',targets:groups.map(group=>({group_id:group.group_id}))}
    r.mount('TeachingScheduledPublications','TeachingScheduledPublications',{repository:{scheduledItems:async()=>({items:[scheduled]})},userId:viewerId||OTHER,onRefresh:async()=>{},groups:groups.map(group=>({id:group.group_id,group_name:group.group_name}))})
    await r.flush();assert.deepEqual(optionIds(r.tree),expected(viewerId))
    r.mount('TeachingGradeRequests','TeachingGradeRequests',{repository:{gradeRequests:async()=>({requests:[],available_activities:groups.map(group=>({group_id:group.group_id,group_name:group.group_name}))})},userId:viewerId||OTHER,mode:'teacher'})
    await r.flush();assert.deepEqual(optionIds(r.tree),expected(viewerId))
  })
}

test('permission editor forwards the viewing owner ID rather than the colleague being edited',t=>{
  const r=setup(t),teacher={id:'link',user_id:OTHER,full_name:'Another colleague',permissions:['materials'],group_scope:'selected',group_ids:[REGULAR]}
  r.mount('TeacherPermissionControl','TeacherPermissionControl',{teacher,groups,viewerId:OLEG,repository:{},onRefresh:async()=>{}})
  r.find(node=>node.type==='TeachingButton').props.onClick();r.render()
  assert.equal(r.find(node=>node.type==='TeachingColleagueScope').props.viewerId,OLEG)
})

test('every current teaching visibility call supplies an explicit actor and parent child scopes receive it',()=>{
  const files=['TeachingColleagueScope','TeachingGradebook','TeachingGradeRequests','TeachingMaterialLibrary','TeachingMaterialLibraryEditor','TeachingMultiAssignmentTargets','TeachingPublications','TeachingScheduledPublications','TeachingSubmissionReview','TeachingWorkspace']
  let calls=0
  for(const name of files){
    const source=read('src/components/teaching/'+name+'.tsx'),ast=ts.createSourceFile(name+'.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    const visit=node=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='isStudyGroupListed'){calls++;assert.equal(node.arguments.length,2,name);assert.ok(['viewerId','userId'].includes(node.arguments[1].getText(ast)),name)}ts.forEachChild(node,visit)}
    visit(ast);assert.doesNotMatch(source,/\.filter\(isStudyGroupListed\)/)
  }
  assert.equal(calls,28)
  for(const [name,child,actor]of [['TeachingWorkspace','TeacherPermissionControl','userId'],['TeachingWorkspace','TeachingCourseForms','userId'],['TeacherPermissionControl','TeachingColleagueScope','viewerId'],['TeachingCourseForms','TeachingColleagueScope','viewerId'],['TeachingPublications','TeachingMultiAssignmentTargets','userId'],['TeachingPublications','TeachingMultiAssignmentPreview','userId']]){
    const source=read('src/components/teaching/'+name+'.tsx'),ast=ts.createSourceFile(name+'.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let count=0
    const visit=node=>{if((ts.isJsxSelfClosingElement(node)||ts.isJsxOpeningElement(node))&&node.tagName.getText(ast)===child){count++;const attribute=node.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.getText(ast)==='viewerId');assert.equal(attribute?.initializer?.expression?.getText(ast),actor,name+' -> '+child)}ts.forEachChild(node,visit)}
    visit(ast);assert.ok(count,name+' -> '+child)
  }
})
