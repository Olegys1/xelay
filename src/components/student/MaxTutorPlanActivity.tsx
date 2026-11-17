import {useEffect,useRef,useState} from 'react'
import {ArrowRight,Check,ChevronLeft,ChevronRight,Clock3,Target} from 'lucide-react'
import {answerTutorQuestion,submitTutorQuestion,type TutorProgress,type TutorRun} from '../../lib/maxTutor'
import {tutorPlanResumeStep,tutorPlanStep} from '../../lib/maxTutorPlan'
import './maxTutorPlanActivity.css'

type Props={run:TutorRun;enabled:boolean;onProgress:(update:(progress:TutorProgress)=>TutorProgress)=>void;activeStepId?:string;selectionRevision?:string}

export function MaxTutorPlanActivity({run,enabled,onProgress,activeStepId,selectionRevision}:Props){
 const [selected,setSelected]=useState(()=>activeStepId||tutorPlanResumeStep(run.bundle,run.progress)),[questionId,setQuestionId]=useState(''),[practiceOpen,setPracticeOpen]=useState(false)
 const heading=useRef<HTMLHeadingElement>(null)
 const selectedId=run.bundle.plan.some(block=>block.id===selected)?selected:run.bundle.plan[0]?.id||''
 const step=tutorPlanStep(run.bundle,run.progress,selectedId),index=run.bundle.plan.findIndex(block=>block.id===selectedId)
 const question=step.questions.find(item=>item.id===questionId)||step.questions.find(item=>!run.progress.submitted.includes(item.id))||step.questions[0]
 const questionIndex=step.questions.findIndex(item=>item.id===question?.id)
 const answered=question?run.progress.submitted.includes(question.id):false
 const showPractice=practiceOpen||step.questions.some(item=>run.progress.answers[item.id]!==undefined||run.progress.submitted.includes(item.id))
 useEffect(()=>{if(activeStepId&&run.bundle.plan.some(block=>block.id===activeStepId)){setSelected(activeStepId);setQuestionId('');setPracticeOpen(false)}},[activeStepId,selectionRevision,run.bundle.plan])
 function choose(id:string){setSelected(id);setQuestionId('');setPracticeOpen(false);requestAnimationFrame(()=>heading.current?.focus({preventScroll:true}))}
 if(!step.block)return null
 return <div className="mtp" aria-label="Покрокова підготовка">
  <nav className="mtp-steps" aria-label="Кроки плану">{run.bundle.plan.map((block,at)=>{const state=tutorPlanStep(run.bundle,run.progress,block.id);return <button type="button" key={block.id} aria-pressed={block.id===selectedId} onClick={()=>choose(block.id)}><span className={state.complete?'is-complete':''}>{state.complete?<Check size={15}/>:at+1}</span><strong>{block.label}</strong><small>{state.questions.length?`${state.checked}/${state.questions.length} перевірено`:`${state.tasksDone}/${block.tasks.length} завдань`}</small></button>})}</nav>
  <section className="mtp-step" key={selectedId} aria-label={step.block.label}>
   <header><span>Крок {index+1} із {run.bundle.plan.length}</span><small><Clock3 size={13}/>{step.block.minutes} хв</small></header>
   <h4 ref={heading} tabIndex={-1}>{step.block.label}</h4>
   <div className="mtp-tasks" aria-label="Завдання кроку">{step.block.tasks.map((task,at)=>{const id=`${step.block!.id}:${at}`,done=run.progress.doneTasks.includes(id);return <label key={id} className={done?'is-done':''}><input type="checkbox" checked={done} disabled={!enabled} onChange={()=>onProgress(value=>({...value,doneTasks:value.doneTasks.includes(id)?value.doneTasks.filter(item=>item!==id):[...value.doneTasks,id]}))}/><span>{task}</span></label>})}</div>
   {step.questions.length>0?<div className="mtp-practice"><div className="mtp-practice-title"><h5><Target size={16}/>Перевір себе</h5><span>{step.checked}/{step.questions.length} відповідей перевірено</span></div>
    {!showPractice?<div className="mtp-practice-start"><p>Короткий тест саме за цією темою. Після кожної відповіді побачиш пояснення, а результат залишиться у твоєму плані.</p><button type="button" className="mta-primary" onClick={()=>{setQuestionId(question?.id||'');setPracticeOpen(true)}}>Почати тест кроку<ArrowRight size={16}/></button></div>:question&&<>
     <div className="mtp-question" key={question.id}><small>Запитання {questionIndex+1} із {step.questions.length}</small><h5>{question.text}</h5><div className="mta-options" role="group" aria-label="Варіанти відповіді у тесті кроку">{question.options.map((option,at)=><button type="button" key={at} aria-pressed={run.progress.answers[question.id]===at} disabled={!enabled||answered} className={`${run.progress.answers[question.id]===at?'selected':''} ${answered&&question.correctIndex===at?'correct':''} ${answered&&run.progress.answers[question.id]===at&&question.correctIndex!==at?'wrong':''}`} onClick={()=>{setQuestionId(question.id);onProgress(value=>answerTutorQuestion(value,run.bundle,question.id,at))}}><span>{String.fromCharCode(65+at)}</span>{option}{answered&&question.correctIndex===at&&<Check size={15}/>}</button>)}</div>
      {answered?<div className="mta-feedback" role="status"><strong>{run.progress.answers[question.id]===question.correctIndex?'Так, правильно.':'Розберімо цей момент.'}</strong><p>{question.explanation}</p>{question.sourceId&&<small>{run.request.sources.find(source=>source.id===question.sourceId)?.title}</small>}</div>:<button type="button" className="mta-primary" disabled={!enabled||run.progress.answers[question.id]===undefined} onClick={()=>{setQuestionId(question.id);onProgress(value=>submitTutorQuestion(value,run.bundle,question.id))}}>Перевірити відповідь<Check size={15}/></button>}
     </div>
     <div className="mtp-question-navigation"><button type="button" aria-label="Попереднє запитання кроку" disabled={questionIndex<=0} onClick={()=>setQuestionId(step.questions[questionIndex-1].id)}><ChevronLeft size={16}/>Назад</button><button type="button" disabled={!answered||questionIndex>=step.questions.length-1} onClick={()=>setQuestionId(step.questions[questionIndex+1].id)}>Далі<ChevronRight size={16}/></button></div>
    </>}
    {step.practiceComplete&&<div className="mtp-result" role="status"><span><Check size={17}/>{step.correct} із {step.questions.length} правильно</span><p>{step.correct===step.questions.length?'Тему перевірено. Переходь до наступного кроку у своєму темпі.':'Повернись до пояснень запитань, де помилився, перш ніж рухатися далі.'}</p><small>Особиста практика за ключем ШІ, без оцінки в журналі.</small></div>}
   </div>:<p className="mtp-legacy">Цей план збережено без тестів до кроків. У новому плані для кожної теми з’явиться окрема перевірка знань.</p>}
   <footer><span>{step.tasksDone}/{step.block.tasks.length} завдань виконано</span>{index<run.bundle.plan.length-1&&<button type="button" onClick={()=>choose(run.bundle.plan[index+1].id)}>Наступний крок<ArrowRight size={16}/></button>}</footer>
  </section>
 </div>
}
