export const STUDENT_PLAN_PRICES=Object.freeze({start:149,plus:399,max:999})
export type PaidStudentPlan=keyof typeof STUDENT_PLAN_PRICES
export const STUDENT_PLAN_NAMES=Object.freeze({start:'Старт',plus:'Плюс',max:'Макс'})
export function paidStudentPlan(value:unknown):value is PaidStudentPlan{return typeof value==='string'&&Object.prototype.hasOwnProperty.call(STUDENT_PLAN_PRICES,value)}
export function studentPlansEnabled(env:Record<string,string|undefined>=process.env){return env.STUDENT_PLANS_ENABLED==='true'}
export function studentOrderPrice(order:{student_plan_id?:unknown;amount?:unknown;birthday_gift_id?:unknown;list_amount?:unknown;discount_percent?:unknown;discount_expires_at?:unknown}):number|null{
 const coupon=order.birthday_gift_id!==null&&order.birthday_gift_id!==undefined
 if(!coupon){
  if(order.list_amount!=null||order.discount_percent!=null||order.discount_expires_at!=null)return null
  if(order.student_plan_id===null||order.student_plan_id===undefined)return Number(order.amount)===100?100:null
  return paidStudentPlan(order.student_plan_id)&&Number(order.amount)===STUDENT_PLAN_PRICES[order.student_plan_id]?STUDENT_PLAN_PRICES[order.student_plan_id]:null
 }
 if(typeof order.birthday_gift_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(order.birthday_gift_id)||!paidStudentPlan(order.student_plan_id))return null
 const list=STUDENT_PLAN_PRICES[order.student_plan_id],percent={start:50,plus:30,max:20}[order.student_plan_id]
 const expected=Math.round(list*(100-percent))/100
 return Number(order.list_amount)===list&&Number(order.discount_percent)===percent&&Number(order.amount)===expected
  &&typeof order.discount_expires_at==='string'&&Number.isFinite(Date.parse(order.discount_expires_at))?expected:null
}
