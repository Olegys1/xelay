export interface Question {
  id: string

  user_id: string

  author_name?: string

  author_avatar?: string

  title?: string

  content: string

  category: string

  likes: number

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
  rating: number
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

  authorRating: number

  text: string

  likes: number

  createdAt: string

  images?: {
  url: string
  type: string
}[]
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
  'Business',
  'B2B',
  'Manufacturing',
  'Marketing',
  'Startups',
  'Finance',
  'Startup & MVP',
  'AI Tools & Automation',
  'Growth Marketing',
  'Content Creation',
  'Sales & Lead Generation',
  'Networking & Connections',
  'Founder Stories',
  'What Actually Worked',
  'Hard Lessons',
  'Building in Public',
    'Career Launch',
  'Skills vs Degree',
  'Internships & Side Projects',
  'Team Up & Collaborations',
  'Mastermind Groups',
] as const

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
  return CATEGORIES.find(
    (c) =>
      categoryToSlug(c) ===
      slug.toLowerCase()
  )
}

export function starsFromRating(
  rating: number
): number {
  if (rating >= 50) return 5
  if (rating >= 20) return 4
  if (rating >= 10) return 3
  if (rating >= 5) return 2
  if (rating >= 1) return 1
  return 0
}