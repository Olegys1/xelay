export interface CategoryMeta {
  icon: string
  description: string
}

export const CATEGORY_META: Record<string, CategoryMeta> = {
  IT: {
    icon: '💻',
    description: 'Technology, programming, digital tools and computer science.',
  },
  Business: {
    icon: '📊',
    description: 'Business ideas, management, finance and student ventures.',
  },
  Marketing: {
    icon: '📣',
    description: 'Marketing, communications, audience research and campaigns.',
  },
  Design: {
    icon: '🎨',
    description: 'Visual design, product design, UX and creative practice.',
  },
  Learning: {
    icon: '📚',
    description: 'Courses, study methods, exams and sharing learning resources.',
  },
  Career: {
    icon: '🧭',
    description: 'Career planning, applications, interviews and professional growth.',
  },
  Internships: {
    icon: '💼',
    description: 'Internships, practical experience and early career opportunities.',
  },
  'International Opportunities': {
    icon: '🌍',
    description: 'Exchange programs, scholarships and opportunities abroad.',
  },
  Entrepreneurship: {
    icon: '🚀',
    description: 'Starting projects, building ventures and learning by doing.',
  },
}
