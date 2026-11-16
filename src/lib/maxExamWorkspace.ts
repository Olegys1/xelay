import type {TutorRun} from './maxTutor'
import {tutorStudyResult} from './maxTutorStudy'

export type MaxExamDraft = {id:string;subject:string;date:string;dailyMinutes:number;goal:string;note:string;createdAt:string}
export const MAX_EXAM_WORKSPACE_KEY='xelay:max-exam-workspace:v1'
const clean=(value:unknown,max:number,allowMarkup=false):value is string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)&&(allowMarkup||!/<\/?[a-z][^>]*>/i.test(value))
export function normalizeMaxExamDraft(value:unknown,partial=false):MaxExamDraft|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>
 const validDate=typeof v.date==='string'&&/^20\d\d-\d\d-\d\d$/.test(v.date)&&Number.isFinite(Date.parse(v.date+'T12:00:00Z'))&&new Date(v.date+'T12:00:00Z').toISOString().slice(0,10)===v.date
 if(typeof v.id!=='string'||!/^exam-[a-zA-Z0-9-]{1,70}$/.test(v.id)||!clean(v.subject,100,partial)||!partial&&!v.subject.trim()||!validDate&&!(partial&&v.date==='')||!Number.isInteger(v.dailyMinutes)||Number(v.dailyMinutes)<10||Number(v.dailyMinutes)>240||!clean(v.goal,300,partial)||!clean(v.note,8000,partial)||new TextEncoder().encode(v.note).length>16000||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))return null
 return {id:v.id,subject:v.subject.trim(),date:v.date as string,dailyMinutes:Number(v.dailyMinutes),goal:v.goal.trim(),note:v.note,createdAt:v.createdAt}
}
export function parseMaxExamDrafts(raw:string|null):MaxExamDraft[]{
 if(!raw||raw.length>400000)return []
 try{const value:unknown=JSON.parse(raw);if(!Array.isArray(value)||value.length>20)return [];const seen=new Set<string>();return value.flatMap(v=>{const draft=normalizeMaxExamDraft(v);if(!draft||seen.has(draft.id))return [];seen.add(draft.id);return [draft]})}catch{return []}
}
export function parseMaxExamScratch(raw:string|null):{draft:MaxExamDraft;step:number}|null{
 if(!raw||raw.length>35000)return null
 try{const value=JSON.parse(raw),draft=normalizeMaxExamDraft(value?.draft,true);return draft&&Number.isInteger(value.step)&&value.step>=0&&value.step<=3?{draft,step:value.step}:null}catch{return null}
}
export function maxExamPrompt(draft:MaxExamDraft):string{
 const safe=normalizeMaxExamDraft(draft);if(!safe)throw new Error('Перевір предмет, дату та матеріали підготовки.')
 return `Склади реалістичний план підготовки до іспиту з предмета «${safe.subject}». Дата іспиту: ${safe.date}. На навчання є ${safe.dailyMinutes} хвилин щодня.${safe.goal?` Моя ціль: ${safe.goal}.`:''} Використовуй лише обрані мною матеріали, розбий тему на послідовні короткі кроки та включи повторення й перевірку знань. Не обіцяй оцінку і не вигадуй мій поточний рівень.`
}
export function maxStudySummary(runs:readonly TutorRun[]){
 const live=runs.filter(run=>!run.demo),questions=live.flatMap(run=>run.bundle.questions.map(question=>({run,question}))),checked=questions.filter(({run,question})=>run.progress.submitted.includes(question.id)),mistakes=checked.filter(({run,question})=>run.progress.answers[question.id]!==question.correctIndex)
 let gapChecked=0,gapCorrect=0,readTotal=0,readDone=0,writtenTotal=0,writtenSubmitted=0
 for(const run of live){if(!run.bundle.study)continue;const result=tutorStudyResult(run.bundle,run.progress);gapChecked+=result.answered;gapCorrect+=result.correct;writtenTotal+=result.writtenTotal;writtenSubmitted+=result.writtenSubmitted;readTotal+=run.bundle.study.reading.length;readDone+=run.bundle.study.reading.filter(part=>run.progress.studyDone?.includes(part.id)).length;for(const gap of run.bundle.study.gaps)if(result.mistakes.includes(gap.id))mistakes.push({run,question:{id:gap.id,text:gap.before+' … '+gap.after,correctIndex:0,options:[],explanation:gap.explanation,sourceId:gap.sourceId}})}
 const tasks=live.flatMap(run=>run.bundle.plan.flatMap(block=>block.tasks.map((label,index)=>({run,block,label,id:`${block.id}:${index}`}))))
 const cards=live.flatMap(run=>run.bundle.cards.map(card=>({run,card,rating:run.progress.cardRatings[card.id]})))
 const numericMistakes=checked.filter(({run,question})=>run.progress.answers[question.id]!==question.correctIndex).length
 return {sessions:live.length,checked:checked.length+gapChecked,correct:checked.length-numericMistakes+gapCorrect,mistakes,tasksTotal:tasks.length,tasksDone:tasks.filter(task=>task.run.progress.doneTasks.includes(task.id)).length,cardsKnown:cards.filter(card=>card.rating==='known').length,cardsRepeat:cards.filter(card=>card.rating==='repeat').length,readTotal,readDone,writtenTotal,writtenSubmitted,plans:live.filter(run=>run.bundle.plan.length>0)}
}
