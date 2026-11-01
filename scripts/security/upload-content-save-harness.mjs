// Current source handlers and repository adapters, with explicit fake browser
// Auth/Storage/RPC boundaries. Never read .env or initialize a provider SDK.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')
export const plain = value => JSON.parse(JSON.stringify(value))
export const ACTOR = '11111111-1111-4111-8111-111111111111'
export const COURSE = '22222222-2222-4222-8222-222222222222'
export const GROUP = '33333333-3333-4333-8333-333333333333'
export const ASSIGNMENT = '44444444-4444-4444-8444-444444444444'
export const SUBMISSION = '55555555-5555-4555-8555-555555555555'
const OTHER = '66666666-6666-4666-8666-666666666666'
const jsx = (type, props, key) => ({ type, props, key })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const icons = new Proxy({}, { get: (_, name) => String(name) })
const ui = Object.fromEntries(['TeachingButton','TeachingEmpty','TeachingField','TeachingModal'].map(name => [name,name]))
ui.teachingInput = 'input'
export const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
export const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const item = overrides => ({ id: ASSIGNMENT, course_id: COURSE, title: 'Завдання для перевірки', body: '', links: [], attachments: [], targets: [{ group_id: GROUP, due_at: null }], status: 'published', published_at: '2026-10-30T10:00:00Z', created_by: ACTOR, author_name: 'Тестовий викладач', version: 1, submission_format: 'written', ...overrides })
const group = { group_id: GROUP, group_name: 'Тестова група', status: 'accepted', permissions: ['materials','assignments','grades'] }
const course = { id: COURSE, title: 'Тестовий предмет', starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null, permissions: ['materials','assignments','grades'], grading_rules: { categories: [] } }
const snapshot = materials => ({ course, groups: [group], teachers: [], entries: [], activities: [], assignments: [], materials, grades: [], audit: [], roster_claims: [], members: [], seminars: { seminars: [], questions: [], teams: [], reservations: [], profiles: {} } })
const submission = overrides => ({ id: SUBMISSION, item_id: ASSIGNMENT, group_id: GROUP, user_id: ACTOR, body: '', links: [], attachments: [], status: 'draft', version: 1, attempt: 0, ...overrides })

function runtime() {
  const cells = [], effects = []
  let index = 0, dirty = false, component, props, tree
  const same = (a,b) => a && b && a.length === b.length && a.every((value,i) => Object.is(value,b[i]))
  const hooks = {
    useState(initial) { const i=index++; if (!cells[i]) { const cell={ value:typeof initial==='function'?initial():initial }; cell.set=next=>{const value=typeof next==='function'?next(cell.value):next;if(!Object.is(value,cell.value)){cell.value=value;dirty=true}};cells[i]=cell } return [cells[i].value,cells[i].set] },
    useRef(initial) { const i=index++; return cells[i]??={current:initial} },
    useId() { const i=index++; return 'flow-field-'+i },
    useCallback(callback,deps) { const i=index++; if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,callback};return cells[i].callback },
    useMemo(callback,deps) { const i=index++; if(!cells[i]||!same(cells[i].deps,deps))cells[i]={deps,value:callback()};return cells[i].value },
    useEffect(callback,deps) { const i=index++; if(!cells[i]||!same(cells[i].deps,deps)){const previous=cells[i];cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();cells[i].cleanup=callback()})} },
    lazy() { return 'UnopenedMaterialViewer' }, Suspense:'Suspense',
  }
  const render = () => {for(let pass=0;pass<30;pass++){index=0;dirty=false;tree=component(props);effects.splice(0).forEach(effect=>effect());if(!dirty)return tree}throw Error('Synthetic hooks did not settle')}
  return {hooks,render,start(next,nextProps){if(component&&component!==next){for(const cell of cells)cell?.cleanup?.();cells.length=0;effects.length=0}component=next;props=nextProps;return render()},get tree(){return tree},get props(){return props},
    find(predicate){const found=nodes(tree).find(predicate);assert.ok(found,'Current source element is rendered');return found},
    async flush(){for(let pass=0;pass<18;pass++){await Promise.resolve();render()}},
    unmount(){for(const cell of cells)cell?.cleanup?.()},
  }
}

export function createSavingFlow(kind, options={}) {
  assert.ok(['submission','publication','library'].includes(kind))
  const run=runtime(), events=[], objects=new Map(), receipts=new Set(), listeners=new Set(), unexpected=[]
  const storage=new Map(), browserListeners=new Map()
  let activeActor=ACTOR, verdict=options.verdict||'accepted', resolveVerification, currentSubmission=options.freshSubmission?null:submission({}), material=null, loaded=null, closes=0
  const window={sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},addEventListener:(key,value)=>browserListeners.set(key,value),removeEventListener:(key,value)=>{if(browserListeners.get(key)===value)browserListeners.delete(key)},setTimeout,clearTimeout,location:{pathname:'/teaching'}}
  const document={visibilityState:'visible',addEventListener(){},removeEventListener(){}}
  const forbidden = name => (..._args) => { unexpected.push(name); throw Error('Unexpected synthetic boundary '+name) }
  const response = mode => mode==='accepted'?new Response(JSON.stringify({verified:true,validation_version:1}),{status:200,headers:{'Content-Type':'application/json'}})
    :mode==='rejected'?new Response('{}',{status:422,headers:{'Content-Type':'application/json'}})
    :new Response(JSON.stringify({verified:true}),{status:200,headers:{'Content-Type':'application/json'}})
  const supabase={
    auth:{async getSession(){return {data:{session:activeActor?{user:{id:activeActor},access_token:'SYNTHETIC_FLOW_TOKEN'}:null},error:null}},onAuthStateChange(callback){listeners.add(callback);return {data:{subscription:{unsubscribe(){listeners.delete(callback)}}}}}},
    from:forbidden('supabase.from'),storage:forbidden('unexpected SDK storage'),
    async rpc(name,args={}){
      events.push({kind:'rpc',name,args:plain(args)})
      if(name==='xelay_classroom_mutate'){
        const p=args.p_payload, action=args.p_action
        if(action==='reserve_submission'){currentSubmission=submission({id:p.id});return {data:{id:p.id,version:1},error:null}}
        if(action==='save_submission'){
          assert.equal(activeActor,ACTOR);assert.equal(p.group_id,GROUP);assert.equal(p.item_id,ASSIGNMENT)
          for(const attachment of p.attachments)assert.ok(receipts.has('xelay-submission-files/'+attachment.storage_path),'Save cannot reference an unverified object')
          if(options.saveError)throw Error('Synthetic lost save response')
          currentSubmission=submission({...p,user_id:ACTOR,status:'draft',version:p.version+1})
          return {data:{id:p.id,version:currentSubmission.version},error:null}
        }
        if(action==='submit_submission'){assert.equal(p.version,currentSubmission.version);currentSubmission={...currentSubmission,status:'submitted',version:p.version+1,submitted_at:'2026-10-30T10:00:00Z',attempt:1};return {data:currentSubmission,error:null}}
        unexpected.push('classroom:'+action);throw Error('Unexpected classroom action '+action)
      }
      if(name==='xelay_teaching_mutate'){
        assert.ok(['save_material','save_library_material'].includes(args.p_action))
        const p=args.p_payload
        assert.equal(activeActor,ACTOR);assert.equal(p.expected_user_id,ACTOR);assert.equal(p.course_id,COURSE)
        for(const attachment of p.attachments)assert.ok(receipts.has('xelay-teaching-files/'+attachment.storage_path),'Publication cannot reference an unverified object')
        if(options.saveError)throw Error('Synthetic lost save response')
        material=item({...p,course_title:course.title,author_name:'Тестовий викладач',created_by:ACTOR,version:p.version+1,
          targets:p.targets||p.target_group_ids.map(group_id=>({group_id})),is_owner:true,can_edit:true,can_delete:true,can_manage_groups:true,can_manage_collaborators:true,collaborators:[],target_group_names:[{group_id:GROUP,group_name:group.group_name}],hidden_target_count:0,withdrawn_at:null})
        return {data:material,error:null}
      }
      if(name==='xelay_classroom_assignment')return {data:{item:item({}),group,permissions:[],my_submission:currentSubmission,submissions:[],history:[],students:[],can_submit:true,can_save_draft:true,is_closed:false,course_archived_at:null,is_assessed:false},error:null}
      if(name==='xelay_teaching_course')return {data:snapshot(material?[material]:[]),error:null}
      if(name==='xelay_teaching_material_library')return {data:{materials:material?[material]:[],courses:[{course,groups:[group],colleagues:[]}]},error:null}
      unexpected.push('rpc:'+name);throw Error('Unexpected synthetic RPC '+name)
    },
  }
  class FakeXHR {
    upload={};headers={};status=0;responseText='';aborted=false
    open(method,url){assert.equal(method,'POST');const parsed=new URL(url);assert.equal(parsed.origin,'https://upload-flow.invalid');this.url=parsed}
    setRequestHeader(name,value){this.headers[name]=value}
    send(form){
      const key=this.url.pathname.replace('/storage/v1/object/','')
      assert.equal(this.headers.Authorization,'Bearer SYNTHETIC_FLOW_TOKEN')
      assert.equal(this.headers['x-upsert'],'false')
      const value=form.get('');assert.ok(value instanceof Blob)
      objects.set(key,value);events.push({kind:'storage',key,size:value.size})
      queueMicrotask(()=>{if(this.aborted)return;this.upload.onprogress?.({lengthComputable:true,loaded:value.size,total:value.size});this.status=201;this.responseText=JSON.stringify({Key:key});this.onload?.()})
    }
    abort(){this.aborted=true;this.onabort?.()}
  }
  const globals={URL,Date,Intl,Error,TypeError,RangeError,TextEncoder,TextDecoder,AbortController,DOMException,Blob,File,FormData,Uint8Array,ArrayBuffer,Buffer,queueMicrotask,setTimeout,clearTimeout,
    crypto:{randomUUID},window,document,XMLHttpRequest:FakeXHR,__flowEnvironment:{VITE_SUPABASE_URL:'https://upload-flow.invalid',VITE_SUPABASE_ANON_KEY:'SYNTHETIC_PUBLIC_NOT_A_CREDENTIAL',MODE:'test',DEV:false,PROD:false},
    async fetch(url,init){
      assert.equal(url,'/api/security/media-cleanup?xelay_upload_route=verify');assert.equal(init.headers.Authorization,'Bearer SYNTHETIC_FLOW_TOKEN')
      const p=JSON.parse(init.body),key=p.bucket+'/'+p.path;assert.ok(objects.has(key));events.push({kind:'verification',key,signal:init.signal})
      if(options.deferVerification)await new Promise(resolve=>{resolveVerification=resolve;init.signal.addEventListener('abort',resolve,{once:true})})
      if(init.signal.aborted)throw new DOMException('Synthetic cancelled verification','AbortError')
      if(verdict==='accepted')receipts.add(key)
      return response(verdict)
    },
  }
  function evaluate(source,imports={},exports={}){
    const code=ts.transpileModule(source.replaceAll('import.meta.env','__flowEnvironment'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    new Function('exports','require',...Object.keys(globals),code)(exports,name=>{if(typeof imports==='function')return imports(name);assert.ok(Object.hasOwn(imports,name),'Explicit current import '+name);return imports[name]},...Object.values(globals))
    return exports
  }
  const cache=new Map()
  function real(name){
    if(name==='supabase')return {supabase}
    if(cache.has(name))return cache.get(name)
    assert.match(name,/^[A-Za-z][A-Za-z0-9]*$/)
    const source=read('src/lib/'+name+'.ts'),exports={}
    cache.set(name,exports)
    return evaluate(source,specifier=>{
      if(specifier==='react')return run.hooks
      assert.match(specifier,/^\.\/[A-Za-z][A-Za-z0-9]*$/,'Only explicit local helper imports')
      return real(specifier.slice(2))
    },exports)
  }
  const teaching=real('teaching'),repository=teaching.supabaseTeachingRepository
  const common={react:run.hooks,'react/jsx-runtime':jsxRuntime,'lucide-react':icons,'./TeachingUI':ui,'../../lib/teaching':teaching}
  const timing=evaluate(read('src/components/teaching/TeachingPublicationTimingFields.tsx'),common)
  const publications=evaluate(read('src/components/teaching/TeachingPublications.tsx'),{
    ...common,'../../lib/resourceLinkLabels':real('resourceLinkLabels'),'../../lib/teachingPublicationDraft':real('teachingPublicationDraft'),'../../lib/teachingGroupDirectory':real('teachingGroupDirectory'),
    '../../lib/studyGroupVisibility':real('studyGroupVisibility'),'../../lib/teachingAssignmentDeadline':real('teachingAssignmentDeadline'),'../../lib/legal':real('legal'),
    '../../lib/teachingMaterialPreview':real('teachingMaterialPreview'),'../../lib/teachingGrading':real('teachingGrading'),'../../lib/teachingMultiAssignments':real('teachingMultiAssignments'),
    './TeachingAssignmentDeadlineFields':{TeachingAssignmentDeadlineFields:'TeachingAssignmentDeadlineFields'},'./TeachingSubmissionReview':{TeachingSubmissionReview:'TeachingSubmissionReview'},
    './TeachingMaterialWithdrawal':{TeachingMaterialWithdrawal:'TeachingMaterialWithdrawal'},'./TeacherSourceBadge':{TeacherSourceBadge:'TeacherSourceBadge'},'./TeachingAssignmentLessonFields':{TeachingAssignmentLessonFields:'TeachingAssignmentLessonFields'},
    './TeachingPublicationTimingFields':timing,'./TeachingGradingRulesEditor':{TeachingWorkTypeField:'TeachingWorkTypeField'},'./TeachingMultiAssignmentTargets':{TeachingMultiAssignmentTargets:'TeachingMultiAssignmentTargets',TeachingMultiAssignmentPreview:'TeachingMultiAssignmentPreview'},
  })
  const submissions=evaluate(read('src/components/teaching/TeachingSubmissionPanel.tsx')+'\nexport {SubmissionComposer};',{
    ...common,'./TeachingPublicationTimingFields':timing,'./teaching-submissions.css':{},
  })
  const libraryEditor=evaluate(read('src/components/teaching/TeachingMaterialLibraryEditor.tsx'),{
    ...common,'../../lib/teachingMaterialLibrary':real('teachingMaterialLibrary'),'../../lib/teachingMaterialPreview':real('teachingMaterialPreview'),'../../lib/studyGroupVisibility':real('studyGroupVisibility'),
    '../../lib/resourceLinkLabels':real('resourceLinkLabels'),'../../lib/legal':real('legal'),'./TeachingPublicationTimingFields':timing,'./teaching-material-library-editor.css':{},
  })
  const libraryView=evaluate(read('src/components/teaching/TeachingMaterialLibrary.tsx')+'\nexport {LibraryContents};',{
    ...common,'../../lib/teachingMaterialLibrary':real('teachingMaterialLibrary'),'../../lib/useTeachingVisibilityRefresh':real('useTeachingVisibilityRefresh'),'../../lib/studyGroupVisibility':real('studyGroupVisibility'),
    './TeachingPublications':publications,'./TeachingMaterialWithdrawal':{TeachingMaterialWithdrawal:'TeachingMaterialWithdrawal'},'./TeachingMaterialLibraryEditor':libraryEditor,'./teaching-material-library.css':{},
  })
  async function refreshed(){if(options.refreshError)throw Error('Synthetic reload unavailable');loaded=kind==='submission'?await repository.classroom(ASSIGNMENT,GROUP):kind==='library'?await repository.materialLibrary():await repository.course(COURSE)}
  const props=kind==='submission'?{submission:currentSubmission,repository,assignment:item({}),groupId:GROUP,userId:ACTOR,onSaved:refreshed,onBusy(){},refreshing:false,canSubmit:true}
    :kind==='publication'?{kind:'material',initial:null,groupId:GROUP,snapshot:snapshot([]),repository,userId:ACTOR,onClose(){closes++},onRefresh:refreshed}
    :{material:null,data:{courses:[{course,groups:[group],colleagues:[]}],materials:[]},repository,userId:ACTOR,onClose(){closes++},onSaved:refreshed}
  run.start(kind==='submission'?submissions.SubmissionComposer:kind==='publication'?publications.PublicationEditor:libraryEditor.TeachingMaterialLibraryEditor,props)
  const input=(name,value)=>{run.find(node=>node.props?.name===name).props.onChange({target:{value,checked:value}});run.render()}
  const choose=file=>{const field=run.find(node=>node.type==='input'&&node.props.type==='file'&&(!node.props['aria-label']||node.props['aria-label']==='Додати файли матеріалу'));field.props.onChange({target:{files:[file],value:''}});run.render()}
  function configure(){
    input(kind==='submission'?'submission-body':kind==='publication'?'publication-body':'library-material-body','Текст, який не можна втратити')
    if(kind==='publication'){input('publication-title','Матеріал після перевірки');input('material-rights',true)}
    if(kind==='library'){input('library-material-title','Матеріал після перевірки');input('library-material-group-'+GROUP,true);input('library-material-status','published');input('library-material-rights',true)}
    choose(new File(['%PDF synthetic bytes; server validation is a controlled boundary'], 'lecture.pdf',{type:'application/pdf'}))
  }
  function startSave(){
    if(kind==='submission')run.find(node=>node.type==='TeachingButton'&&text(node).trim()==='Здати роботу').props.onClick()
    return run.find(node=>node.type==='form').props.onSubmit({preventDefault(){},nativeEvent:{submitter:{getAttribute:()=> 'published'}}})
  }
  async function waitForVerification(){for(let pass=0;pass<100;pass++){if(events.some(event=>event.kind==='verification'))return;await new Promise(resolve=>setImmediate(resolve));run.render()}throw Error('No current upload verification request')}
  async function renderSaved(){
    if(kind==='submission')run.start(submissions.TeachingSubmissionPanel,{assignment:item({}),groupId:GROUP,userId:ACTOR,repository,defaultExpanded:true})
    else if(kind==='publication')run.start(publications.TeachingPublications,{kind:'material',snapshot:loaded,groupId:GROUP,repository,userId:ACTOR,onRefresh:refreshed})
    else run.start(libraryView.LibraryContents,{repository,userId:ACTOR})
    await run.flush()
    return run.tree
  }
  return {run,events,objects,receipts,props,configure,input,choose,startSave,waitForVerification,renderSaved,
    get loaded(){return loaded},get material(){return material},get submission(){return currentSubmission},get closes(){return closes},
    get writes(){return events.filter(event=>event.kind==='rpc'&&['xelay_classroom_mutate','xelay_teaching_mutate'].includes(event.name))},
    finishVerification(mode='accepted'){verdict=mode;resolveVerification?.()},
    changeAccount(){activeActor=OTHER;for(const callback of listeners)callback('SIGNED_IN',{user:{id:OTHER},access_token:'OTHER_SYNTHETIC_TOKEN'})},
    assertNoUnexpected(){assert.deepEqual(unexpected,[])},
    unmount(){run.unmount()},
  }
}
