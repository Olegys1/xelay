export interface CategoryMeta {
  title: string
  icon: string
  image?: string
  description: string
}

export const CATEGORY_META: Record<string, CategoryMeta> = {
  IT: {
    title: 'Спеф',
    icon: '',
    image: '/images/spef-logo.png',
    description: 'Ініціативи, новини та обговорення спільноти «Спеф».',
  },
  Business: {
    title: 'Школа лідерства (dia.business)',
    icon: '🧭',
    description: 'Матеріали, досвід і обговорення школи лідерства.',
  },
  Marketing: {
    title: 'Обговорення подій університету',
    icon: '💬',
    description: 'Враження, запитання та обговорення університетських подій.',
  },
  Design: {
    title: 'Спорт & Спортивні івенти',
    icon: '🏅',
    description: 'Тренування, змагання, спортивні команди та події.',
  },
  Learning: {
    title: 'Курс від банку "Південний"',
    icon: '📚',
    description: 'Матеріали, запитання та обговорення курсу від банку «Південний».',
  },
  Career: {
    title: "Кар'єрні можливості",
    icon: '💼',
    description: 'Вакансії, резюме, співбесіди та професійний розвиток.',
  },
  Internships: {
    title: 'Можливості стажування',
    icon: '🎓',
    description: 'Стажування, практика та перший професійний досвід.',
  },
  'International Opportunities': {
    title: 'Міжнародні можливості',
    icon: '🌍',
    description: 'Обміни, стипендії, міжнародні програми та навчання за кордоном.',
  },
  Entrepreneurship: {
    title: 'Студентські проєкти',
    icon: '🚀',
    description: 'Студентські ідеї, пошук команди та спільна робота над проєктами.',
  },
}
