// Actual UI callbacks with synthetic catalogue/profile state. No network or accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const profileSource = await read('src/components/ProfileSettingsModal.tsx')
const profile = ts.createSourceFile('ProfileSettingsModal.tsx', profileSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = profile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProfileSettingsModal')
const declaration = name => component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(profile) === name).initializer.getText(profile)
const dependencies = ['saveInFlight','uploadInFlight','saved','xelayUser','authUser','showFailure','setError','academicDirty','currentAcademicYear','academicSnapshot','selectedAcademicUnits','academicUnitId','username','name','academicOptionsLoading','academicOptionsError','universities','universityId','hasStudentProfile','preserveExistingSpecialty','academicSpecialtyMatches','specialtySelection','studyYear','progressionAvailable','activeStudent','studyProgramYears','setFieldErrors','FIELD_IDS','focusField','setSaving','supabase','country','city','studyYearAutoAdvance','bio','categories','profileTextArray','skills','helpWith','wantToLearn','avatarUrl','alive','setSaved','notify','refreshUser','closeTimer','latestOnClose','academicStatus']
const methods = {}
vm.runInNewContext(compile(`export function preserve(context:any) { const {hasStudentProfile,initialAcademicProfile,xelayUser,universityId,academicUnitId,academicStatus,academicScopeDirty,academicDirty,specialtySelection}=context;return ${declaration('preserveExistingSpecialty')}; }
export function save(context:any) { const {${dependencies.join(',')}}=context;return ${declaration('handleSave')}; }`), { exports:methods,setTimeout:()=>0,console:{error(){}} })

function fixture(overrides={}) {
  const updates=[],state={},failures=[]
  const original={userId:'synthetic-user',universityId:'university',academicUnitId:'faculty',specialty:'Збережена програма',status:'bachelor',hasStudentProfile:true}
  const context={
    saveInFlight:{current:false},uploadInFlight:{current:false},saved:false,
    xelayUser:{id:'synthetic-user',specialty:'Збережена програма',specialtyId:'legacy-program'},authUser:{id:'synthetic-user'},
    initialAcademicProfile:{current:original},academicScopeDirty:{current:false},academicDirty:{current:{status:false,course:false,duration:false,automatic:false}},
    currentAcademicYear:()=>2026,academicSnapshot:{current:{academicYear:2026}},
    universityId:'university',academicUnitId:'faculty',academicStatus:'bachelor',hasStudentProfile:true,
    selectedAcademicUnits:[{id:'faculty',name:'Економічний факультет'}],universities:[{id:'university'}],
    academicOptionsLoading:false,academicOptionsError:'',specialtySelection:{selected:null,loading:false,error:'',options:[]},
    academicSpecialtyMatches:(selection,universityId,academicUnitId)=>Boolean(selection.selected?.is_active&&selection.selected.university_id===universityId&&selection.selected.academic_unit_id===academicUnitId),
    name:' Synthetic Student ',username:'student',country:'Україна',city:'Київ',bio:' Changed biography ',categories:[],
    studyYear:'1',studyProgramYears:'4',studyYearAutoAdvance:false,progressionAvailable:true,activeStudent:true,
    skills:'',helpWith:'',wantToLearn:'',avatarUrl:'',profileTextArray:()=>[],
    FIELD_IDS:{name:'profile-name',username:'profile-username',university:'profile-university',academicUnit:'profile-academic-unit',specialty:'profile-specialty',studyYear:'profile-study-year',studyProgramYears:'profile-study-program-years'},
    showFailure:message=>failures.push(message),focusField:field=>{state.focus=field},notify(){},refreshUser:async()=>{},alive:{current:true},closeTimer:{current:null},latestOnClose:{current(){}},
    supabase:{
      from(table){
        assert.equal(table,'profiles')
        return{
          update(payload){
            updates.push(payload)
            return{
              eq(column,id){
                assert.equal(column,'id');assert.equal(id,'synthetic-user')
                return{select:()=>({single:async()=>({error:null})})}
              },
            }
          },
        }
      },
    },
    ...overrides,
  }
  for(const name of ['setError','setFieldErrors','setSaving','setSaved'])context[name]=value=>{state[name]=value}
  context.preserveExistingSpecialty=methods.preserve(context)
  return{context,updates,state,failures,save:()=>methods.save(context)({preventDefault(){}})}
}
const programme = (patch={}) => ({id:'replacement',name:'Актуальна програма',is_active:true,university_id:'university',academic_unit_id:'faculty',...patch})

test('a filtered stored programme allows unrelated profile edits and omits all academic identity fields',async()=>{
  const fx=fixture()
  assert.equal(fx.context.preserveExistingSpecialty,true)
  await fx.save()
  assert.equal(fx.failures.length,0);assert.equal(fx.updates.length,1)
  assert.equal(fx.updates[0].full_name,'Synthetic Student');assert.equal(fx.updates[0].bio,'Changed biography')
  for(const key of ['faculty','university_id','academic_unit_id','specialty_id','specialty'])assert.equal(Object.hasOwn(fx.updates[0],key),false,key)
  assert.equal(fx.context.specialtySelection.selected,null)
})

test('course-only corrections preserve the existing programme and still save the chosen course',async()=>{
  const fx=fixture({studyYear:'2',academicDirty:{current:{status:false,course:true,duration:false,automatic:false}}})
  assert.equal(fx.context.preserveExistingSpecialty,true)
  await fx.save()
  assert.equal(fx.updates[0].study_year,2);assert.equal(Object.hasOwn(fx.updates[0],'specialty_id'),false)
})

test('a scope, status, account, or explicit programme interaction requires an active replacement',async()=>{
  for(const overrides of [
    {universityId:'other'}, {academicUnitId:'other'}, {academicStatus:'master'},
    {academicScopeDirty:{current:true}}, {academicDirty:{current:{status:true}}},
    {initialAcademicProfile:{current:{userId:'other',universityId:'university',academicUnitId:'faculty',specialty:'Old',status:'bachelor',hasStudentProfile:true}}},
    {initialAcademicProfile:{current:{userId:'synthetic-user',universityId:'university',academicUnitId:'faculty',specialty:'',status:'bachelor',hasStudentProfile:true}}},
  ]){
    const fx=fixture(overrides)
    assert.equal(fx.context.preserveExistingSpecialty,false)
    await fx.save();assert.equal(fx.updates.length,0);assert.ok(fx.failures.length>0)
  }
})

test('a failed/loading catalogue does not silently bypass programme validation',async()=>{
  for(const patch of [{loading:true},{error:'offline'}]){
    const fx=fixture({specialtySelection:{selected:null,options:[],loading:false,error:'',...patch}})
    assert.equal(fx.context.preserveExistingSpecialty,false)
    await fx.save();assert.equal(fx.updates.length,0)
    assert.equal(fx.state.focus,'specialty')
  }
})

test('an active replacement saves its real catalogue ID and label; inactive selections cannot be saved',async()=>{
  const fx=fixture({academicScopeDirty:{current:true},specialtySelection:{selected:programme(),options:[programme()],loading:false,error:''}})
  assert.equal(fx.context.preserveExistingSpecialty,false)
  await fx.save()
  assert.equal(fx.updates[0].specialty_id,'replacement');assert.equal(fx.updates[0].specialty,'Актуальна програма')
  assert.equal(fx.updates[0].university_id,'university');assert.equal(fx.updates[0].academic_unit_id,'faculty')
  const inactive=fixture({specialtySelection:{selected:programme({is_active:false}),options:[],loading:false,error:''}})
  await inactive.save();assert.equal(inactive.updates.length,0)
})

test('teacher-only profiles retain the existing no-student-programme path',async()=>{
  const fx=fixture({hasStudentProfile:false,academicStatus:'',initialAcademicProfile:{current:{userId:'synthetic-user',universityId:'university',academicUnitId:'faculty',specialty:'',status:'',hasStudentProfile:false}}})
  assert.equal(fx.context.preserveExistingSpecialty,false)
  await fx.save()
  assert.equal(fx.failures.length,0);assert.equal(fx.updates[0].specialty_id,null);assert.equal(fx.updates[0].specialty,'')
})

test('all catalogue consumers pass status and registration presents status/course before programme',async()=>{
  const authSource=await read('src/components/AuthModal.tsx')
  const scopeSource=await read('src/components/AcademicScopePicker.tsx')
  const newsSource=await read('src/pages/NewsPage.tsx')
  assert.match(authSource,/useAcademicSpecialties\(regUniversityId, regAcademicUnitId, \{\}, regAcademicStatus\)/)
  assert.match(profileSource,/useAcademicSpecialties\(universityId, academicUnitId, \{ id: xelayUser\?\.specialtyId, name: xelayUser\?\.specialty \}, academicStatus\)/)
  assert.match(scopeSource,/useAcademicSpecialties\(universityId, unitId, \{ id: initialSpecialtyId, name: initialSpecialtyName \}, academicStatus\)/)
  assert.match(newsSource,/academicStatus=\{xelayUser\?\.experience \|\| ''\}/)
  assert.ok(authSource.indexOf('id="reg-academic-status"')<authSource.indexOf('id="register-specialty"'))
  assert.ok(authSource.indexOf('id="reg-study-year"')<authSource.indexOf('id="register-specialty"'))
  assert.match(profileSource,/required=\{!preserveExistingSpecialty\} preserveLegacy=\{preserveExistingSpecialty\}/)
  assert.match(profileSource,/onClearError=\{\(\) => \{ academicScopeDirty\.current = true;/)
})
