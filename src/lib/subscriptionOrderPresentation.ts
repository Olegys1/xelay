import type { BillingOrder } from './billing'

/** Presentation only. Paid access is granted by the server payment callback. */
export function subscriptionOrderPresentation(order: BillingOrder): { title: string; welcome: 'student' | 'legacy' | null } {
  if (order.product === 'group') return { title: 'Доступ для групи', welcome: null }
  if (order.teacher_plan_id) {
    const names = { teacher_start: 'Старт', teacher_plus: 'Плюс', teacher_max: 'Макс' }
    return { title: `Для викладача · ${names[order.teacher_plan_id] || 'Тариф'} · один місяць`, welcome: null }
  }
  if (order.student_plan_id) return { title: `${({ start: 'Старт', plus: 'Плюс', max: 'Макс' })[order.student_plan_id] || 'Студентський тариф'} · один місяць`, welcome: 'student' }
  return { title: 'Учасник · один місяць', welcome: 'legacy' }
}
