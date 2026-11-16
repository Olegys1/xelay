export type AcademicPart={id:string;title:string;maximum:number;earned:number|null}
export type AcademicCourse={id:string;name:string;credits:number;target:number;parts:AcademicPart[]}
export type AcademicScenario={id:string;name:string;expected:Record<string,number>}
export type AcademicState={version:1;courses:AcademicCourse[];scenarios:AcademicScenario[];activeScenario:string}
export const MAX_ACADEMIC_KEY='xelay:local-max-academic:synthetic:v1'
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)&&!['constructor','prototype'].includes(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max
const finite=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max
const round=(value:number)=>Math.round(value*100)/100
export function normalizeAcademicCourse(value:unknown):AcademicCourse|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as AcademicCourse;if(!id(v.id)||!text(v.name,100)||!finite(v.credits,0.5,60)||!finite(v.target,0,100)||!Array.isArray(v.parts)||v.parts.length<1||v.parts.length>15)return null
 const parts:AcademicPart[]=[],seen=new Set<string>();for(const part of v.parts){if(!part||!id(part.id)||seen.has(part.id)||!text(part.title,100)||!finite(part.maximum,0.5,1000)||!(part.earned===null||finite(part.earned,0,part.maximum)))return null;seen.add(part.id);parts.push({id:part.id,title:part.title,maximum:part.maximum,earned:part.earned})}
 return {id:v.id,name:v.name.trim(),credits:v.credits,target:v.target,parts}
}
export function initialAcademicState(empty=false):AcademicState{if(empty)return {version:1,courses:[],scenarios:[{id:'own-scenario',name:'Мій сценарій',expected:{}}],activeScenario:'own-scenario'};return {version:1,activeScenario:'balanced',courses:[
 {id:'micro',name:'Мікроекономіка',credits:6,target:85,parts:[{id:'seminars',title:'Семінари',maximum:30,earned:24},{id:'module',title:'Модульна',maximum:20,earned:16},{id:'project',title:'Проєкт',maximum:20,earned:null},{id:'exam',title:'Залік',maximum:30,earned:null}]},
 {id:'management',name:'Менеджмент',credits:4,target:80,parts:[{id:'participation',title:'Робота протягом семестру',maximum:40,earned:32},{id:'report',title:'Велика робота',maximum:20,earned:null},{id:'exam',title:'Залік',maximum:40,earned:null}]},
 {id:'statistics',name:'Статистика',credits:5,target:75,parts:[{id:'practice',title:'Практичні',maximum:30,earned:21},{id:'module',title:'Контрольна',maximum:30,earned:22},{id:'exam',title:'Іспит',maximum:40,earned:null}]},
 ],scenarios:[{id:'balanced',name:'Реалістичний',expected:{'micro:project':16,'micro:exam':24,'management:report':16,'management:exam':32,'statistics:exam':30}},{id:'ambitious',name:'Максимальна концентрація',expected:{'micro:project':20,'micro:exam':28,'management:report':19,'management:exam':38,'statistics:exam':36}}]}}
export function parseAcademicState(raw:string|null,empty=false):AcademicState{
 const fallback=initialAcademicState(empty);if(!raw||raw.length>400000)return fallback
 try{const v=JSON.parse(raw);if(!v||v.version!==1||!Array.isArray(v.courses)||!Array.isArray(v.scenarios))return fallback;const courses:AcademicCourse[]=[],seen=new Set<string>();for(const row of v.courses.slice(0,20)){const c=normalizeAcademicCourse(row);if(c&&!seen.has(c.id)){courses.push(c);seen.add(c.id)}}if(!courses.length)return fallback
 const keys=new Map(courses.flatMap(c=>c.parts.filter(p=>p.earned===null).map(p=>[`${c.id}:${p.id}`,p.maximum] as const))),scenarios:AcademicScenario[]=[];seen.clear()
 for(const s of v.scenarios.slice(0,6)){if(!s||!id(s.id)||!text(s.name,80)||seen.has(s.id)||!s.expected||typeof s.expected!=='object'||Array.isArray(s.expected))continue;const expected:Record<string,number>=Object.create(null);for(const [key,max] of keys){const n=s.expected[key];if(finite(n,0,max))expected[key]=n}scenarios.push({id:s.id,name:s.name,expected});seen.add(s.id)}
 if(!scenarios.length)scenarios.push({id:'own-scenario',name:'Мій сценарій',expected:Object.create(null)})
 return {version:1,courses,scenarios,activeScenario:scenarios.some(s=>s.id===v.activeScenario)?v.activeScenario:scenarios[0].id}
 }catch{return fallback}
}
export function academicCourseSummary(course:AcademicCourse,scenario:AcademicScenario){
 const safe=normalizeAcademicCourse(course);if(!safe)throw new Error('Перевірте правила предмета')
 const maximum=safe.parts.reduce((n,p)=>n+p.maximum,0),earned=safe.parts.reduce((n,p)=>n+(p.earned??0),0),pendingMaximum=safe.parts.filter(p=>p.earned===null).reduce((n,p)=>n+p.maximum,0)
 const projected=safe.parts.reduce((n,p)=>{const assumption=scenario.expected[`${safe.id}:${p.id}`];return n+(p.earned??(finite(assumption,0,p.maximum)?assumption:0))},0)
 const targetPoints=maximum*safe.target/100,needed=Math.max(0,round(targetPoints-earned))
 return {maximum,earned,pendingMaximum,projected:round(projected),percent:round(projected/maximum*100),earnedPercent:round(earned/maximum*100),needed,targetPoints:round(targetPoints),possible:needed<=pendingMaximum,reached:projected>=targetPoints,minimumPendingPercent:pendingMaximum?Math.min(100,Math.ceil(needed/pendingMaximum*100)):needed?null:0}
}
export function academicPortfolio(courses:AcademicCourse[],scenario:AcademicScenario){
 if(!courses.length)return {average:0,credits:0,belowGoal:0,rows:[]}
 const rows=courses.map(course=>({course,...academicCourseSummary(course,scenario)})),credits=rows.reduce((n,row)=>n+row.course.credits,0)
 return {average:round(rows.reduce((n,row)=>n+row.percent*row.course.credits,0)/credits),credits,belowGoal:rows.filter(row=>!row.reached).length,rows}
}
export function setAcademicAssumption(state:AcademicState,scenarioId:string,courseId:string,partId:string,value:number):AcademicState{
 const course=state.courses.find(c=>c.id===courseId),part=course?.parts.find(p=>p.id===partId)
 if(!course||!part||part.earned!==null||!finite(value,0,part.maximum)||!state.scenarios.some(s=>s.id===scenarioId))throw new Error('Змінювати можна лише припущення для майбутньої роботи')
 return {...state,scenarios:state.scenarios.map(s=>s.id===scenarioId?{...s,expected:{...s.expected,[`${courseId}:${partId}`]:value}}:s)}
}
export function replaceAcademicCourse(state:AcademicState,value:AcademicCourse):AcademicState{
 const course=normalizeAcademicCourse(value);if(!course)throw new Error('Перевірте правила предмета')
 const courses=state.courses.some(c=>c.id===course.id)?state.courses.map(c=>c.id===course.id?course:c):[...state.courses,course]
 if(courses.length>20)throw new Error('Можна зберегти до 20 предметів')
 const pending=new Map(courses.flatMap(c=>c.parts.filter(p=>p.earned===null).map(p=>[`${c.id}:${p.id}`,p.maximum] as const)))
 const scenarios=state.scenarios.map(s=>{const expected:Record<string,number>=Object.create(null);for(const [key,max] of pending){const n=s.expected[key];if(typeof n==='number'&&Number.isFinite(n))expected[key]=Math.max(0,Math.min(max,n))}return {...s,expected}})
 return {...state,courses,scenarios}
}
