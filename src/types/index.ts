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
  country: string
  city?: string
  experience: string
  categories: string[]
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
  'IT',
  'Business',
  'Marketing',
  'Design',
  'Learning',
  'Career',
  'Internships',
  'International Opportunities',
  'Entrepreneurship',
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
