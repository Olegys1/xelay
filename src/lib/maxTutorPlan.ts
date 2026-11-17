import type {MaxTutorBundle,TutorProgress} from './maxTutor'

/** Step practice shares the run's already owner-scoped answer outbox and history. */
export function tutorPlanStep(bundle:MaxTutorBundle,progress:TutorProgress,stepId:string){
 const block=bundle.plan.find(step=>step.id===stepId)
 const byId=new Map(bundle.questions.map(question=>[question.id,question]))
 const questions=[...new Set(block?.questionIds||[])].flatMap(id=>{const question=byId.get(id);return question?[question]:[]})
 const checked=questions.filter(question=>progress.submitted.includes(question.id))
 const tasksDone=block?.tasks.filter((_,index)=>progress.doneTasks.includes(`${stepId}:${index}`)).length||0
 return {block,questions,checked:checked.length,correct:checked.filter(question=>progress.answers[question.id]===question.correctIndex).length,tasksDone,practiceComplete:questions.length>0&&checked.length===questions.length,complete:!!block&&tasksDone===block.tasks.length&&(questions.length===0||checked.length===questions.length)}
}

export function tutorPlanResumeStep(bundle:MaxTutorBundle,progress:TutorProgress):string{
 return bundle.plan.find(block=>!tutorPlanStep(bundle,progress,block.id).complete)?.id||bundle.plan[0]?.id||''
}
