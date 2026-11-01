/** Shared timetable contracts without a browser client, environment or SDK. */
export type WeekPattern = 'every' | 'upper' | 'lower'
export type LessonType = 'lecture' | 'seminar' | 'practical' | 'lab' | 'makeup' | 'replacement' | 'module' | 'final_assessment' | 'test' | 'other'
export type TimetableLesson = {
  is_elective_block?: boolean
  id: string
  group_id: string
  weekday: number
  starts_at: string
  ends_at: string
  subject: string
  teacher_name?: string
  lesson_type: LessonType
  location: string
  online_url: string | null
  online_url_secondary?: string | null
  online_url_label?: string | null
  online_url_secondary_label?: string | null
  online_links_extra?: { url: string; label: string }[]
  conference_id?: string | null
  conference_access_code?: string | null
  valid_from: string
  valid_until: string
  created_by: string
  updated_at?: string
  week_pattern?: WeekPattern
  week_anchor_date?: string | null
  lesson_number?: number | null
  excluded_dates?: string[]
  copied_from_schedule_id?: string | null
  inherit_source_links?: boolean
}
export type TimetableLessonDraft = Omit<TimetableLesson, 'id' | 'group_id' | 'created_by' | 'updated_at' | 'excluded_dates' | 'copied_from_schedule_id' | 'inherit_source_links'>
export type TimetableSlot = { number: number; starts_at: string; ends_at: string }
