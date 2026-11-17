import type {TutorRun,TutorQuestion,TutorCard} from './maxTutor'

export type PlusReviewRating='again'|'hard'|'good'|'easy'
export type PlusReview={id:string;runId:string;itemId:string;kind:'card'|'mistake';rating:PlusReviewRating;dueAt:string;intervalDays:number;repetitions:number}
export type PlusPracticeItem={id:string;runId:string;itemId:string;kind:'card'|'mistake';title:string;createdAt:string;question?:TutorQuestion;card?:TutorCard;review?:PlusReview;due:boolean}

/** Stable opaque IDs are record keys, never an authorization decision. */
export function plusReviewId(kind:'card'|'mistake',runId:string,itemId:string){
 let hash=14695981039346656037n
 for(const char of `${kind.length}:${kind}${runId.length}:${runId}${itemId.length}:${itemId}`){hash^=BigInt(char.codePointAt(0)!);hash=BigInt.asUintN(64,hash*1099511628211n)}
 return 'review-'+hash.toString(16).padStart(16,'0')
}
export function mergePlusRuns(...groups:readonly (readonly TutorRun[])[]):TutorRun[]{
 const runs=new Map<string,TutorRun>()
 for(const group of groups)for(const run of group)if(!run.demo)runs.set(run.id,run)
 return [...runs.values()].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||a.id.localeCompare(b.id))
}
export function plusPracticeItems(runs:readonly TutorRun[],reviews:readonly PlusReview[],now=Date.now()):PlusPracticeItem[]{
 const records=new Map(reviews.map(review=>[`${review.kind}:${review.runId}:${review.itemId}`,review])),items:PlusPracticeItem[]=[]
 for(const run of runs){if(run.demo)continue
  for(const card of run.bundle.cards){const review=records.get(`card:${run.id}:${card.id}`);items.push({id:plusReviewId('card',run.id,card.id),runId:run.id,itemId:card.id,kind:'card',title:run.bundle.title,createdAt:run.createdAt,card,review,due:!review||Date.parse(review.dueAt)<=now})}
  for(const question of run.bundle.questions){const review=records.get(`mistake:${run.id}:${question.id}`),wrong=run.progress.submitted.includes(question.id)&&run.progress.answers[question.id]!==question.correctIndex
   if(wrong||review)items.push({id:plusReviewId('mistake',run.id,question.id),runId:run.id,itemId:question.id,kind:'mistake',title:run.bundle.title,createdAt:run.createdAt,question,review,due:!review||Date.parse(review.dueAt)<=now})
  }
 }
 return items.sort((a,b)=>Number(b.due)-Number(a.due)||(a.review?Date.parse(a.review.dueAt):0)-(b.review?Date.parse(b.review.dueAt):0)||a.id.localeCompare(b.id))
}
/** Capture checked mistakes once. Reviewing never changes an original test result. */
export function seedPlusMistakes(reviews:readonly PlusReview[],runs:readonly TutorRun[],now=Date.now()):PlusReview[]{
 const found=new Set(reviews.map(review=>`${review.kind}:${review.runId}:${review.itemId}`)),next=[...reviews]
 for(const item of plusPracticeItems(runs,reviews,now))if(item.kind==='mistake'&&!found.has(`mistake:${item.runId}:${item.itemId}`)){
  next.push({id:item.id,runId:item.runId,itemId:item.itemId,kind:'mistake',rating:'again',dueAt:new Date(now).toISOString(),intervalDays:0,repetitions:0});found.add(`mistake:${item.runId}:${item.itemId}`)
 }
 return next
}
export function schedulePlusReview(item:Pick<PlusPracticeItem,'id'|'runId'|'itemId'|'kind'|'review'>,rating:PlusReviewRating,now=Date.now()):PlusReview{
 if(!['again','hard','good','easy'].includes(rating)||!Number.isFinite(now))throw Error('Перевір оцінку повторення.')
 const old=Math.max(0,Math.min(365,item.review?.intervalDays??0)),intervalDays=rating==='again'?0:rating==='hard'?Math.max(1,Math.ceil(old*1.2)):rating==='good'?Math.max(2,Math.ceil(old*2.2)):Math.max(4,Math.ceil(old*3))
 const interval=Math.min(365,intervalDays)
 return{id:item.id,runId:item.runId,itemId:item.itemId,kind:item.kind,rating,dueAt:new Date(now+(rating==='again'?10*60*1000:interval*86400000)).toISOString(),intervalDays:interval,repetitions:Math.min(10000,(item.review?.repetitions??0)+1)}
}
export function replacePlusReview(reviews:readonly PlusReview[],record:PlusReview):PlusReview[]{return[...reviews.filter(review=>!(review.kind===record.kind&&review.runId===record.runId&&review.itemId===record.itemId)),record]}
