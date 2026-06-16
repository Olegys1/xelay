export interface CategoryMeta {
  icon: string
  description: string
}

export const CATEGORY_META: Record<string, CategoryMeta> = {
  Business: {
    icon: '📊',
    description: 'General business strategy, operations, and management insights',
  },
  B2B: {
    icon: '🤝',
    description: 'Business-to-business sales, partnerships, and enterprise solutions',
  },
  Manufacturing: {
    icon: '⚙️',
    description: 'Production, supply chain, quality control, and industrial processes',
  },
  Marketing: {
    icon: '📣',
    description: 'Brand strategy, digital marketing, growth, and customer acquisition',
  },
  Startups: {
    icon: '🚀',
    description: 'Entrepreneurship, funding, product-market fit, and early-stage growth',
  },
  Finance: {
    icon: '💹',
    description: 'Investment, accounting, financial planning, and corporate finance',
  },
  'Startup & MVP': {
    icon: '🛠️',
    description: 'Launch fast, validate early — build your first version without over-engineering',
  },
  'AI Tools & Automation': {
    icon: '🤖',
    description: 'Leverage AI and automation to move faster and do more with less',
  },
  'Growth Marketing': {
    icon: '📈',
    description: 'Proven growth loops, acquisition channels, and retention strategies',
  },
  'Content Creation': {
    icon: '✍️',
    description: 'Build audiences, tell stories, and create content that converts',
  },
  'Sales & Lead Generation': {
    icon: '🎯',
    description: 'Outreach tactics, pipelines, and closing deals at every stage',
  },
  'Networking & Connections': {
    icon: '🌐',
    description: 'Build meaningful relationships that open doors and create opportunities',
  },
  'Founder Stories': {
    icon: '🧭',
    description: 'Real journeys from founders — the highs, lows, and pivots',
  },
  'What Actually Worked': {
    icon: '✅',
    description: 'Tactics and strategies that delivered real, measurable results',
  },
  'Hard Lessons': {
    icon: '🔥',
    description: 'Honest mistakes, expensive experiments, and what to avoid',
  },
  'Building in Public': {
    icon: '🏗️',
    description: 'Share your progress, get feedback, and grow transparently',
  },
    'Career Launch': {
    icon: '🚀',
    description: 'Land your first internship, job, or offer. Discuss interviews, CVs, portfolios, and breaking into the industry without experience',
  },

  'Skills vs Degree': {
    icon: '🎓',
    description: 'Explore which skills employers actually value, compare real-world requirements with university education, and discuss career readiness',
  },

  'Internships & Side Projects': {
    icon: '💼',
    description: 'Share internship opportunities, discuss personal projects, build portfolios, and learn how to showcase your work to employers',
  },

  'Team Up & Collaborations': {
    icon: '🤝',
    description: 'Find co-founders, developers, designers, marketers, and teammates for startups, projects, hackathons, and collaborations',
  },

  'Mastermind Groups': {
    icon: '🧠',
    description: 'Create or join focused groups for learning, accountability, exam preparation, startup building, and professional growth',
  },
}
