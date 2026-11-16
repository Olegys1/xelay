import type {BillingOrder} from './billing'
import type {StudentPlanId} from './studentPlans'
/** Presentation only; the database/payment callback remains the access authority. */
export function confirmedStudentPayment(order:BillingOrder|undefined,ownerId:string|undefined,configurationOwnerId:string|undefined,now=Date.now()):StudentPlanId|null{
 if(!ownerId||ownerId!==configurationOwnerId||!order||order.product!=='participant'||order.mode!=='live'||order.status!=='approved'||!order.approved_at||!Number.isFinite(now))return null
 const approved=Date.parse(order.approved_at),plan=order.student_plan_id,prices={start:149,plus:399,max:999}
 return typeof plan==='string'&&Object.prototype.hasOwnProperty.call(prices,plan)&&Number(order.amount)===prices[plan]&&Number.isFinite(approved)&&approved<=now+60000?plan:null
}
