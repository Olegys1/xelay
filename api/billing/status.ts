import { authenticateRequest, BillingError, privateResponse, publicBillingConfiguration, sendError } from '../../server/billing.js'
import {studentPlansEnabled} from '../../server/student-learning/studentPlanPrices.js'
import {paidTeacherPlan,teacherPlansEnabled} from '../../server/teacher-learning/teacherPlanPrices.js'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const config = publicBillingConfiguration()
    const auth = await authenticateRequest(req, true)
    if (!auth) return res.status(200).json(config)
    const [status, orders,student,teacher] = await Promise.all([
      auth.userClient.rpc('xelay_billing_status'),
      auth.service.from('billing_orders').select('id,product,group_id,order_reference,amount,currency,mode,status,created_at,approved_at'+(studentPlansEnabled()?',student_plan_id':'')+(teacherPlansEnabled()?',teacher_plan_id':'')).eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(20),
      studentPlansEnabled()?auth.userClient.rpc('xelay_student_workspace_status'):Promise.resolve({data:null,error:null}),
      teacherPlansEnabled()?auth.userClient.rpc('xelay_teacher_workspace_status'):Promise.resolve({data:null,error:null}),
    ])
    if (status.error || orders.error || student.error || teacher.error) throw new BillingError(503, 'Історію оплати ще не підключено. Перевірте міграцію підписок.')
    const currentPlan=student.data&&['start','plus','max'].includes(student.data.planId)&&typeof student.data.startsAt==='string'&&typeof student.data.expiresAt==='string'?{id:student.data.planId,startsAt:student.data.startsAt,expiresAt:student.data.expiresAt}:null
    const currentTeacherPlan=teacher.data&&paidTeacherPlan(teacher.data.planId)&&typeof teacher.data.startsAt==='string'&&typeof teacher.data.expiresAt==='string'?{id:teacher.data.planId,startsAt:teacher.data.startsAt,expiresAt:teacher.data.expiresAt}:null
    const audience=teacher.data?.audience??student.data?.audience
    return res.status(200).json({ ...config, ...status.data,...(['student','teacher'].includes(audience)?{subscriptionAudience:audience}:{}),...(audience==='teacher'?{studentPlansAvailable:false}:{}),...(studentPlansEnabled()?{studentPlan:currentPlan}:{}),...(teacherPlansEnabled()?{teacherPlan:currentTeacherPlan}:{}), orders: orders.data || [] })
  } catch (error) { return sendError(res, error) }
}
