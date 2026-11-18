import type { TeacherPlanId } from '../../src/lib/teacherLearning.js'

export const TEACHER_PLAN_PRICES = Object.freeze({ teacher_start: 199, teacher_plus: 499, teacher_max: 999 })
export const TEACHER_PLAN_NAMES = Object.freeze({ teacher_start: 'Викладацький Старт', teacher_plus: 'Викладацький Плюс', teacher_max: 'Викладацький Макс' })
export const TEACHER_AI_LIMIT_MICROS = Object.freeze({ teacher_start: 1_000_000, teacher_plus: 4_000_000, teacher_max: 8_000_000 })
export function teacherPlansEnabled(environment: Record<string, string | undefined> = process.env) { return environment.TEACHER_PLANS_ENABLED === 'true' }
export function paidTeacherPlan(value: unknown): value is TeacherPlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEACHER_PLAN_PRICES, value)
}
export function teacherOrderPrice(order: { teacher_plan_id?: unknown; student_plan_id?: unknown; amount?: unknown; birthday_gift_id?: unknown; list_amount?: unknown; discount_percent?: unknown; discount_expires_at?: unknown }): number | null {
  if (!paidTeacherPlan(order.teacher_plan_id) || order.student_plan_id != null || order.birthday_gift_id != null || order.list_amount != null || order.discount_percent != null || order.discount_expires_at != null) return null
  const price = TEACHER_PLAN_PRICES[order.teacher_plan_id]
  return Number(order.amount) === price ? price : null
}
