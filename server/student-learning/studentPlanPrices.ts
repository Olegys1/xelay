export const STUDENT_PLAN_PRICES=Object.freeze({start:149,plus:399,max:999})
export type PaidStudentPlan=keyof typeof STUDENT_PLAN_PRICES
export const STUDENT_PLAN_NAMES=Object.freeze({start:'Старт',plus:'Плюс',max:'Макс'})
export function paidStudentPlan(value:unknown):value is PaidStudentPlan{return typeof value==='string'&&Object.prototype.hasOwnProperty.call(STUDENT_PLAN_PRICES,value)}
export function studentPlansEnabled(env:Record<string,string|undefined>=process.env){return env.STUDENT_PLANS_ENABLED==='true'}
export function studentOrderPrice(order:{student_plan_id?:unknown;amount?:unknown}):number|null{
 if(order.student_plan_id===null||order.student_plan_id===undefined)return Number(order.amount)===100?100:null
 return paidStudentPlan(order.student_plan_id)&&Number(order.amount)===STUDENT_PLAN_PRICES[order.student_plan_id]?STUDENT_PLAN_PRICES[order.student_plan_id]:null
}
