import type { StudyGroupRepresentativeStatus } from '../lib/studyGroupRepresentativeTransfer'

export interface Question {
  id: string

  user_id: string

  author_name?: string

  author_avatar?: string

  title?: string

  content: string

  category: string

  created_at: string

  answers_count?: number

  views?: number
}

export interface XelayUser {
  id: string
  userId: string
  name: string
  email: string
  username?: string
  country: string
  city?: string
  experience: string
  categories: string[]
  faculty?: string
  universityId?: string | null
  academicUnitId?: string | null
  isPlatformAdmin?: boolean
  accountType?: 'student' | 'teacher'
  isTeacher?: boolean
  teacherVerificationStatus?: 'none' | 'pending' | 'approved' | 'rejected' | 'revoked'
  teacherDepartment?: string
  teacherPosition?: string
  editorUnitIds?: string[]
  editorUniversityIds?: string[]
  isPlatformNewsEditor?: boolean
  isClassRepresentative?: boolean
  classRepresentativeRequestId?: string
  studyGroupRepresentativeStatus?: StudyGroupRepresentativeStatus
  studyGroupRepresentativeStatusSource?: 'current' | 'legacy' | 'unavailable'
  studyGroupIds?: string[]
  specialty?: string
  specialtyId?: string | null
  studyYear?: number | null
  studyYearAutoAdvance?: boolean
  studyYearAcademicYear?: number | null
  studyProgramYears?: number | null
  studyYearNeedsReview?: boolean
  skills?: string[]
  helpWith?: string[]
  wantToLearn?: string[]
  avatarUrl?: string
  has_seen_onboarding?: boolean
  createdAt: string
  bio?: string
}

export interface Answer {
  id: string

  userId: string

  questionId: string

  authorId: string

  authorName: string

  author_avatar?: string

  text: string

  createdAt: string

  images?: {
  url: string
  type: string
}[]
}
export interface Discussion {
  id: string

  answerId: string

  userId: string

  text: string

  createdAt: string

  user: {
    id: string
    name: string
    avatarUrl: string
  }
}
interface NotificationItem {
  id: string
  actor_name: string
  message: string
  created_at: string
  is_read: boolean

  question_id?: string
  answer_id?: string
  type?: string
}

export const CATEGORIES = [
  // Keep the stored IDs: existing posts, interests and URLs use these values.
  // Presentation names live in categoryMeta; this array sets display order.
  'General Questions',
  'International Opportunities',
  'Internships',
  'Career',
  'Business',
  'Learning',
  'Entrepreneurship',
  'IT',
  'Design',
  'Marketing',
] as const

const LEGACY_CATEGORIES = [
  'B2B', 'Manufacturing', 'Startups', 'Finance', 'Startup & MVP',
  'AI Tools & Automation', 'Growth Marketing', 'Content Creation',
  'Sales & Lead Generation', 'Networking & Connections', 'Founder Stories',
  'What Actually Worked', 'Hard Lessons', 'Building in Public',
  'Career Launch', 'Skills vs Degree', 'Internships & Side Projects',
  'Team Up & Collaborations', 'Mastermind Groups',
]

export type Category =
  (typeof CATEGORIES)[number]

export function categoryToSlug(
  cat: string
): string {
  return cat
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function slugToCategory(
  slug: string
): string | undefined {
  return [...CATEGORIES, ...LEGACY_CATEGORIES].find(
    (c) =>
      categoryToSlug(c) ===
      slug.toLowerCase()
  )
}
