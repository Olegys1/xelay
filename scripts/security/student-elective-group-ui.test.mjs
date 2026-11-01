// Actual timetable component and page placement callback, with closed synthetic
// dependencies. No browser SDK, real account, network or database writes.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8')
const id=n=>'71000000-0000-4000-8000-'+String(n).padStart(12,'0')
const USER=id(1),GROUP=id(10),SHARED=id(20),PLAN=id(30),UPPER=id(40),LOWER=id(41)
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'}
const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
const text=value=>value==null||typeof value==='boolean'?'':Array.isArray(value)?value.map(text).join(' '):typeof value==='object'?text(value.props?.children):String(value)
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText
function evaluate(source,imports={},globals={}){
  const module={exports:{}}
  vm.runInNewContext(compile(source),{module,exports:module.exports,URL,TextEncoder,Intl,Date,Map,...globals,require(name){assert.ok(Object.hasOwn(imports,name),'Explicit import '+name);return imports[name]},fetch(){throw Error('Network forbidden')}})
  return module.exports
}
const links=evaluate(read('src/lib/studyGroupLinks.ts'))
const elective=evaluate(read('src/lib/studentElectiveTimetable.ts'),{'./studyGroupLinks.ts':links})
const timetableSource=read('src/lib/studyGroupTimetable.ts')
const timetable=evaluate(timetableSource.slice(timetableSource.indexOf('export const LESSON_TYPES'),timetableSource.indexOf('export function timetableImportError')))
const generic={id:SHARED,group_id:GROUP,created_by:USER,subject:'Вибіркові дисципліни',weekday:1,starts_at:'08:30',ends_at:'09:50',lesson_type:'other',teacher_name:'',location:'',online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null,valid_from:'2026-09-01',valid_until:'2027-01-31',week_pattern:'every',week_anchor_date:null,is_elective_block:true,excluded_dates:[]}
const meeting=(extra={})=>({id:UPPER,subject:'Лише верхній',weekday:1,starts_at:'11:20',ends_at:'12:40',lesson_type:'lecture',teacher_name:'',location:'',online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null,week_pattern:'upper',week_anchor_date:'2026-11-02',...extra})
const ownPlan=(lessons=[meeting()])=>({id:PLAN,user_id:USER,group_id:GROUP,valid_from:'2026-09-01',valid_until:'2027-01-31',configured:true,version:1,lessons})

function timetableFixture(plans){
  const cells=[];let index=0,props,tree
  const hooks={useState(initial){const i=index++;if(!cells[i])cells[i]={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}]},useMemo:fn=>fn(),useEffect(){},useRef:value=>({current:value})}
  const component=evaluate(read('src/components/GroupTimetable.tsx')+'\nexport {TimetableWorkspace};',{
    react:hooks,'react/jsx-runtime':jsx,'lucide-react':new Proxy({},{get:(_,name)=>'Icon'+String(name)}),'./StudyGroupTimetablePhoto':{},'./StudyGroupLessonLinks':{},'./schedule/ScheduleConferenceAccessFields':{},'./schedule/ScheduleAdditionalLinksFields':{},'./TimetablePhotoRecognition':{},'../lib/studentElectiveTimetable':elective,'../lib/studyGroupLinks':links,'../lib/studyGroupTimetable':timetable,
  })
  const render=()=>{index=0;tree=component.TimetableWorkspace(props);return tree}
  props={groupId:GROUP,currentUserId:USER,schedule:[generic],electivePlans:plans,canEdit:false,selectedDate:'2026-11-02',onDateChange(date){props={...props,selectedDate:date}},onEditLesson(){assert.fail('No edit')},onAddLesson(){assert.fail('No add')},onImported(){}}
  render()
  return{render,get tree(){return tree},get date(){return props.selectedDate},choose(label){const button=nodes(tree).find(node=>node.type==='button'&&text(node)===label);assert.ok(button);button.props.onClick();render()},get subjects(){return nodes(tree).filter(node=>node.props?.lesson).map(node=>node.props.lesson.subject)},selected(label){return nodes(tree).find(node=>node.type==='button'&&text(node)===label)?.props['aria-pressed']}}
}

test('actual upper/lower timetable buttons navigate using personal anchors when the shared block has none',()=>{
  const f=timetableFixture([ownPlan([meeting(),meeting({id:LOWER,subject:'Лише нижній',week_pattern:'lower'})])])
  assert.equal(f.selected('Верхній'),true);assert.ok(f.subjects.includes('Лише верхній'));assert.equal(f.subjects.includes('Лише нижній'),false)
  f.choose('Нижній')
  assert.equal(f.date,'2026-11-09');assert.equal(f.selected('Нижній'),true);assert.ok(f.subjects.includes('Лише нижній'));assert.equal(f.subjects.includes('Лише верхній'),false)
  f.choose('Верхній')
  assert.equal(f.date,'2026-11-16');assert.equal(f.selected('Верхній'),true);assert.ok(f.subjects.includes('Лише верхній'))
})

test('a personal alternating anchor remains usable during an off week with no personal lessons',()=>{
  const f=timetableFixture([ownPlan([meeting({week_pattern:'lower'})])])
  assert.equal(f.subjects.length,0);assert.equal(f.selected('Верхній'),true)
  f.choose('Нижній');assert.equal(f.date,'2026-11-09');assert.ok(f.subjects.includes('Лише верхній'))
})

function declaration(source,name){
  const ast=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found
  const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(ast);ts.forEachChild(node,visit)}
  visit(ast);assert.ok(found,'Actual function '+name);return found
}
function variableInitializer(source,name){
  const ast=ts.createSourceFile('source.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)found=node.initializer?.getText(ast);ts.forEachChild(node,visit)}
  visit(ast);assert.ok(found,'Actual initializer '+name);return found
}

test('actual group-page placement keeps assignments from replaced generic lessons visible as unplaced, never on personal IDs',()=>{
  const normalizedScheduleSubjectName=value=>value.trim().toLocaleLowerCase('uk').replace(/\s+/g,' ')
  const {teacherAssignmentLesson}=evaluate(declaration(read('src/components/teaching/TeachingLessonAssignments.tsx'),'teacherAssignmentLesson'),{}, {normalizedScheduleSubjectName,scheduleOccursOnDate:timetable.scheduleOccursOnDate})
  const filter=variableInitializer(read('src/pages/StudyGroupsPage.tsx'),'unplacedTeacherAssignments')
  const assignment={id:id(80),group_id:GROUP,subject_name:generic.subject,schedule_item_id:SHARED,lesson_date:'2026-11-02'}
  const personal=elective.projectStudentElectiveTimetable([generic],[ownPlan()],USER,GROUP,'2026-11-02')
  assert.equal(personal.length,1);assert.equal(elective.isPersonalElectiveLesson(personal[0]),true)
  const run=visibleSchedule=>{
    const context={teacherAssignments:{assignments:[assignment]},teacherAssignmentsByLesson:new Map(),teacherAssignmentLesson,selectedDate:'2026-11-02',visibleSchedule,schedule:[generic],isPersonalElectiveLesson:elective.isPersonalElectiveLesson}
    vm.createContext(context);const unplaced=vm.runInContext(filter,context)
    return{unplaced,placed:context.teacherAssignmentsByLesson}
  }
  const replaced=run(personal)
  assert.equal(replaced.unplaced.length,1);assert.equal(replaced.unplaced[0].id,assignment.id);assert.equal(replaced.placed.size,0)
  const retained=run([...personal,generic])
  assert.equal(retained.unplaced.length,0);assert.equal(retained.placed.get(SHARED)[0].id,assignment.id)
  const collision=run(personal.map(row=>({...row,id:SHARED})))
  assert.equal(collision.unplaced.length,1);assert.equal(collision.placed.size,0)
})
