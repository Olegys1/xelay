import type { TeachingCourse, TeachingGroupData, TeachingOwnGrade } from './teaching'

export interface StudentCategoryAnalytics {
  id: string
  name: string
  earned: number | null
  rawEarned: number | null
  maximum: number | null
}

export interface StudentSubjectAnalytics {
  course: TeachingCourse
  grades: TeachingOwnGrade[]
  numericGrades: (TeachingOwnGrade & { published_score: number })[]
  feedbackOnlyCount: number
  earned: number | null
  maximum: number | null
  semesterPercent: number | null
  assessedEarned: number
  assessedMaximum: number
  assessedPercent: number | null
  categories: StudentCategoryAnalytics[]
  lastPublishedAt: string | null
}

const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const positiveMaximum = (value: unknown): value is number => finiteNonnegative(value) && value > 0 && value <= 10000
const points = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
const publishedTime = (value: unknown) => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN

/** Current own results across the selected group's accepted subjects.
 * The source is the own-only group RPC; no staff journal or historical grade
 * audit is used. Missing scores remain unknown, including comment-only results.
 */
export function buildStudentGradeAnalytics(data: TeachingGroupData, groupId: string): StudentSubjectAnalytics[] {
  if (!groupId) return []
  const courses = new Map<string, TeachingCourse>()
  for (const course of data.courses) if (course?.id && !courses.has(course.id)) courses.set(course.id, course)
  const uniqueGrades = new Map<string, TeachingOwnGrade>()
  for (const grade of data.grades) {
    if (!grade || !grade.id || !grade.activity_id || !grade.entry_id || grade.group_id !== groupId || !courses.has(grade.course_id)
      || !Number.isFinite(publishedTime(grade.published_at)) || !positiveMaximum(grade.max_points)
      || grade.published_score !== null && (!finiteNonnegative(grade.published_score) || grade.published_score > grade.max_points)) continue
    const prior = uniqueGrades.get(grade.id)
    if (prior && publishedTime(prior.published_at) >= publishedTime(grade.published_at)) continue
    // Whitelist fields rather than carrying a staff/draft field into analytics.
    uniqueGrades.set(grade.id, {
      id: grade.id, course_id: grade.course_id, group_id: grade.group_id, activity_id: grade.activity_id, entry_id: grade.entry_id,
      published_score: grade.published_score, published_comment: typeof grade.published_comment === 'string' ? grade.published_comment : '',
      published_at: grade.published_at, activity_title: typeof grade.activity_title === 'string' ? grade.activity_title : 'Робота',
      activity_date: typeof grade.activity_date === 'string' ? grade.activity_date : '', max_points: grade.max_points,
      category: typeof grade.category === 'string' ? grade.category : '', course_title: courses.get(grade.course_id)!.title,
      grading_rules: courses.get(grade.course_id)!.grading_rules,
    })
  }
  return [...courses.values()].map(course => {
    const grades = [...uniqueGrades.values()].filter(grade => grade.course_id === course.id)
      .sort((a, b) => publishedTime(b.published_at) - publishedTime(a.published_at) || a.id.localeCompare(b.id))
    const numericGrades = grades.filter((grade): grade is TeachingOwnGrade & { published_score: number } => grade.published_score !== null)
    const rules = Array.isArray(course.grading_rules?.categories) ? course.grading_rules.categories : []
    const categories = new Map<string, StudentCategoryAnalytics>()
    for (const rule of rules) {
      if (!rule?.id || categories.has(rule.id)) continue
      categories.set(rule.id, { id: rule.id, name: rule.name || 'Категорія', earned: null, rawEarned: null, maximum: positiveMaximum(rule.max_points) ? rule.max_points : null })
    }
    for (const grade of grades) if (!categories.has(grade.category)) {
      categories.set(grade.category, { id: grade.category, name: grade.category ? 'Інше оцінювання' : 'Без категорії', earned: null, rawEarned: null, maximum: null })
    }
    for (const grade of numericGrades) {
      const category = categories.get(grade.category)!
      category.rawEarned = points((category.rawEarned ?? 0) + grade.published_score)
      category.earned = category.maximum === null ? category.rawEarned : Math.min(category.rawEarned, category.maximum)
    }
    const maximum = positiveMaximum(course.grading_rules?.total_max) ? course.grading_rules.total_max : null
    const categoryTotal = [...categories.values()].reduce((sum, category) => sum + (category.earned ?? 0), 0)
    const earned = numericGrades.length ? points(maximum === null ? categoryTotal : Math.min(categoryTotal, maximum)) : null
    const assessedEarned = points(numericGrades.reduce((sum, grade) => sum + grade.published_score, 0))
    const assessedMaximum = points(numericGrades.reduce((sum, grade) => sum + grade.max_points, 0))
    return {
      course, grades, numericGrades, feedbackOnlyCount: grades.filter(grade => grade.published_score === null && Boolean(grade.published_comment.trim())).length,
      earned, maximum, semesterPercent: earned !== null && maximum !== null ? points(earned / maximum * 100) : null,
      assessedEarned, assessedMaximum, assessedPercent: assessedMaximum > 0 ? points(assessedEarned / assessedMaximum * 100) : null,
      categories: [...categories.values()], lastPublishedAt: grades[0]?.published_at || null,
    }
  }).sort((a, b) => a.course.title.localeCompare(b.course.title, 'uk') || b.course.starts_on.localeCompare(a.course.starts_on) || a.course.id.localeCompare(b.course.id))
}
