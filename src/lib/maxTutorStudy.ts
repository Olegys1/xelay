import type {MaxTutorBundle,TutorProgress,TutorSource}from'./maxTutor'

export type TutorStudyFormat='true_false'|'gap_fill'|'smart_text'|'written'|'exercise'|'podcast'
export type TutorGap={id:string;before:string;after:string;acceptedAnswers:string[];explanation:string;sourceId:string}
export type TutorReading={id:string;text:string;terms:{term:string;explanation:string}[];sourceId:string}
export type TutorWritten={id:string;prompt:string;criteria:string[];modelAnswer:string;sourceId:string}
export type TutorDialogue={id:string;speaker:'tutor'|'student';text:string;sourceId:string}
export type TutorStudyArtifact={format:TutorStudyFormat;gaps:TutorGap[];reading:TutorReading[];written:TutorWritten[];dialogue:TutorDialogue[]}
export const TUTOR_STUDY_FORMATS:readonly TutorStudyFormat[]=['true_false','gap_fill','smart_text','written','exercise','podcast']
export const tutorStudyMode=(format:TutorStudyFormat):'quiz'|'explain'=>format==='true_false'?'quiz':'explain'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(name=>Object.prototype.hasOwnProperty.call(v,name))
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)&&!/<\/?[a-z][^>]*>/i.test(v)
const fail=():never=>{throw Error('Навчальна вправа не пройшла перевірку. Попередні відповіді збережено.')}
export function normalizeTutorPracticeAnswer(value:string):string{return value.normalize('NFKC').replace(/[’ʼ`]/g,"'").trim().replace(/\s+/g,' ').toLocaleLowerCase('uk-UA')}
export function validateTutorStudyArtifact(value:unknown,format:TutorStudyFormat,sources:readonly TutorSource[]):TutorStudyArtifact{
 if(!object(value)||!keys(value,['format','gaps','reading','written','dialogue'])||value.format!==format||!Array.isArray(value.gaps)||value.gaps.length>12||!Array.isArray(value.reading)||value.reading.length>10||!Array.isArray(value.written)||value.written.length>4||!Array.isArray(value.dialogue)||value.dialogue.length>24||JSON.stringify(value).length>60000)return fail()
 const seen=new Set<string>(),source=(id:unknown)=>typeof id==='string'&&sources.some(s=>s.id===id)?id:fail()
 const item=(v:unknown,names:string[])=>{if(!object(v)||!keys(v,names)||!identifier(v.id)||seen.has(v.id))return fail();seen.add(v.id);return v}
 const gaps=value.gaps.map(raw=>{
  const g=item(raw,['id','before','after','acceptedAnswers','explanation','sourceId']),sourceId=source(g.sourceId)
  if(!text(g.before,1000,true)||!text(g.after,1000,true)||!g.before.trim()&&!g.after.trim()||!Array.isArray(g.acceptedAnswers)||g.acceptedAnswers.length<1||g.acceptedAnswers.length>5||!g.acceptedAnswers.every(a=>text(a,200))||!text(g.explanation,1200))return fail()
  const acceptedAnswers=g.acceptedAnswers as string[]
  if(new Set(acceptedAnswers.map(normalizeTutorPracticeAnswer)).size!==acceptedAnswers.length||!sources.find(s=>s.id===sourceId)!.text.includes(acceptedAnswers[0]))return fail()
  return{id:g.id as string,before:g.before,after:g.after,acceptedAnswers:[...acceptedAnswers],explanation:g.explanation,sourceId}
 })
 const reading=value.reading.map(raw=>{
  const r=item(raw,['id','text','terms','sourceId']),sourceId=source(r.sourceId)
  if(!text(r.text,1800)||!Array.isArray(r.terms)||r.terms.length>6)return fail()
  const terms=r.terms.map(term=>{if(!object(term)||!keys(term,['term','explanation'])||!text(term.term,100)||!text(term.explanation,600)||!(r.text as string).includes(term.term))return fail();return{term:term.term,explanation:term.explanation}})
  if(new Set(terms.map(t=>normalizeTutorPracticeAnswer(t.term))).size!==terms.length)return fail()
  return{id:r.id as string,text:r.text,terms,sourceId}
 })
 const written=value.written.map(raw=>{
  const w=item(raw,['id','prompt','criteria','modelAnswer','sourceId']),sourceId=source(w.sourceId)
  if(!text(w.prompt,1000)||!text(w.modelAnswer,1800)||!Array.isArray(w.criteria)||w.criteria.length<1||w.criteria.length>6||!w.criteria.every(c=>text(c,300)))return fail()
  return{id:w.id as string,prompt:w.prompt,criteria:[...w.criteria] as string[],modelAnswer:w.modelAnswer,sourceId}
 })
 const dialogue=value.dialogue.map(raw=>{
  const d=item(raw,['id','speaker','text','sourceId']),sourceId=source(d.sourceId)
  if(!['tutor','student'].includes(String(d.speaker))||!text(d.text,700))return fail()
  return{id:d.id as string,speaker:d.speaker as TutorDialogue['speaker'],text:d.text,sourceId}
 })
 if((format==='gap_fill'?gaps.length===0:gaps.length!==0)||(format==='smart_text'?reading.length===0:reading.length!==0)||(['written','exercise'].includes(format)?written.length===0:written.length!==0)||(format==='podcast'?dialogue.length<2:dialogue.length!==0))return fail()
 return{format,gaps,reading,written,dialogue}
}
export const emptyTutorStudyProgress=()=>({version:2 as const,studyAnswers:{} as Record<string,string>,studySubmitted:[] as string[],studyRatings:{} as Record<string,'repeat'|'known'>,studyDone:[] as string[]})
export function validateTutorStudyProgress(raw:Record<string,unknown>,bundle:MaxTutorBundle){
 if(bundle.version!==2||!bundle.study||raw.version!==2||!object(raw.studyAnswers)||!Array.isArray(raw.studySubmitted)||!object(raw.studyRatings)||!Array.isArray(raw.studyDone))return fail()
 const study=bundle.study,items=[...study.gaps,...study.written],answerable=new Map(items.map(item=>[item.id,item])),written=new Set(study.written.map(w=>w.id)),done=new Set([...study.reading,...study.dialogue].map(r=>r.id))
 const studyAnswers:Record<string,string>={},studyRatings:Record<string,'repeat'|'known'>={}
 for(const[id,value]of Object.entries(raw.studyAnswers)){if(!answerable.has(id)||!text(value,written.has(id)?4000:200,true))return fail();studyAnswers[id]=value}
 if(raw.studySubmitted.length>items.length||new Set(raw.studySubmitted).size!==raw.studySubmitted.length||raw.studySubmitted.some(id=>typeof id!=='string'||!answerable.has(id)||!studyAnswers[id]?.trim()))return fail()
 for(const[id,value]of Object.entries(raw.studyRatings)){if(!written.has(id)||!raw.studySubmitted.includes(id)||!['repeat','known'].includes(String(value)))return fail();studyRatings[id]=value as'repeat'|'known'}
 if(raw.studyDone.length>done.size||new Set(raw.studyDone).size!==raw.studyDone.length||raw.studyDone.some(id=>typeof id!=='string'||!done.has(id))||new TextEncoder().encode(JSON.stringify(raw)).length>40000)return fail()
 return{version:2 as const,studyAnswers,studySubmitted:[...raw.studySubmitted] as string[],studyRatings,studyDone:[...raw.studyDone] as string[]}
}
export function answerTutorStudy(progress:TutorProgress,bundle:MaxTutorBundle,itemId:string,value:string):TutorProgress{
 if(bundle.version!==2||!bundle.study||progress.studySubmitted?.includes(itemId))return progress
 const gap=bundle.study.gaps.find(item=>item.id===itemId),written=bundle.study.written.find(item=>item.id===itemId)
 if(!gap&&!written||!text(value,written?4000:200,true))return progress
 return{...progress,...(progress.version===2?{}:emptyTutorStudyProgress()),studyAnswers:{...progress.studyAnswers,[itemId]:value}}
}
export function submitTutorStudy(progress:TutorProgress,bundle:MaxTutorBundle,itemId:string):TutorProgress{
 if(bundle.version!==2||!bundle.study||![...bundle.study.gaps,...bundle.study.written].some(item=>item.id===itemId)||!progress.studyAnswers?.[itemId]?.trim()||progress.studySubmitted?.includes(itemId))return progress
 return{...progress,version:2,studySubmitted:[...(progress.studySubmitted||[]),itemId]}
}
export function rateTutorStudy(progress:TutorProgress,bundle:MaxTutorBundle,itemId:string,rating:'repeat'|'known'):TutorProgress{
 if(!bundle.study?.written.some(item=>item.id===itemId)||!progress.studySubmitted?.includes(itemId)||!['repeat','known'].includes(rating))return progress
 return{...progress,studyRatings:{...progress.studyRatings,[itemId]:rating}}
}
export function toggleTutorStudyDone(progress:TutorProgress,bundle:MaxTutorBundle,itemId:string):TutorProgress{
 if(bundle.version!==2||!bundle.study||![...bundle.study.reading,...bundle.study.dialogue].some(item=>item.id===itemId))return progress
 const done=progress.studyDone||[]
 return{...progress,...(progress.version===2?{}:emptyTutorStudyProgress()),studyDone:done.includes(itemId)?done.filter(id=>id!==itemId):[...done,itemId]}
}
export function tutorStudyResult(bundle:MaxTutorBundle,progress:TutorProgress){
 const gaps=bundle.study?.gaps||[],submitted=gaps.filter(g=>progress.studySubmitted?.includes(g.id)),correct=submitted.filter(g=>g.acceptedAnswers.some(a=>normalizeTutorPracticeAnswer(a)===normalizeTutorPracticeAnswer(progress.studyAnswers?.[g.id]||'')))
 return{answered:submitted.length,total:gaps.length,correct:correct.length,mistakes:submitted.filter(g=>!correct.includes(g)).map(g=>g.id),writtenSubmitted:(bundle.study?.written||[]).filter(w=>progress.studySubmitted?.includes(w.id)).length,writtenTotal:bundle.study?.written.length||0}
}
