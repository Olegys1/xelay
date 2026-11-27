import {submitTutorQuestion,TUTOR_QUIZ_MAX_QUESTIONS,type MaxTutorBundle,type TutorProgress} from './maxTutor'

/** A plan step may expose only its own validated questions, never a wider fallback. */
export function tutorQuizWorkspaceQuestions(bundle:MaxTutorBundle,questionIds?:readonly string[]){
 const limit=bundle.mode==='quiz'?TUTOR_QUIZ_MAX_QUESTIONS:bundle.mode==='plan'?20:12
 if(bundle.questions.length>limit)return []
 if(questionIds===undefined)return bundle.questions.slice()
 if(!Array.isArray(questionIds)||questionIds.length<1||questionIds.length>limit||new Set(questionIds).size!==questionIds.length)return []
 const byId=new Map(bundle.questions.map(question=>[question.id,question]))
 if(questionIds.some(id=>typeof id!=='string'||!byId.has(id)))return []
 return questionIds.map(id=>byId.get(id)!)
}

export function tutorQuizWorkspaceSummary(bundle:MaxTutorBundle,progress:TutorProgress,questionIds?:readonly string[]){
 const questions=tutorQuizWorkspaceQuestions(bundle,questionIds)
 const selected=questions.filter(question=>Number.isInteger(progress.answers[question.id])&&progress.answers[question.id]>=0&&progress.answers[question.id]<question.options.length)
 const checked=selected.filter(question=>progress.submitted.includes(question.id))
 const correct=checked.filter(question=>progress.answers[question.id]===question.correctIndex).length
 return {total:questions.length,selected:selected.length,checked:checked.length,correct,wrong:checked.filter(question=>progress.answers[question.id]!==question.correctIndex).map(question=>question.id),remaining:questions.filter(question=>!progress.submitted.includes(question.id)).map(question=>question.id),complete:questions.length>0&&checked.length===questions.length}
}

/** One outbox update checks selected answers; already checked questions stay immutable. */
export function checkTutorQuizWorkspace(progress:TutorProgress,bundle:MaxTutorBundle,questionIds?:readonly string[]):TutorProgress{
 return tutorQuizWorkspaceQuestions(bundle,questionIds).reduce((next,question)=>submitTutorQuestion(next,bundle,question.id),progress)
}
