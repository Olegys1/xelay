import { CATEGORIES } from '../types'

const labels: Record<string, string[]> = {
  en: ['IT', 'Business', 'Marketing', 'Design', 'Learning', 'Career', 'Internships', 'International Opportunities', 'Entrepreneurship'],
  uk: ['IT', 'Бізнес', 'Маркетинг', 'Дизайн', 'Навчання', "Кар'єра", 'Стажування', 'Міжнародні можливості', 'Підприємництво'],
  pl: ['IT', 'Biznes', 'Marketing', 'Projektowanie', 'Nauka', 'Kariera', 'Staże', 'Możliwości międzynarodowe', 'Przedsiębiorczość'],
  de: ['IT', 'Wirtschaft', 'Marketing', 'Design', 'Lernen', 'Karriere', 'Praktika', 'Internationale Möglichkeiten', 'Unternehmertum'],
  fr: ['Informatique', 'Entreprise', 'Marketing', 'Design', 'Apprentissage', 'Carrière', 'Stages', 'Opportunités internationales', 'Entrepreneuriat'],
  es: ['Tecnología', 'Negocios', 'Marketing', 'Diseño', 'Aprendizaje', 'Carrera', 'Prácticas', 'Oportunidades internacionales', 'Emprendimiento'],
  it: ['Informatica', 'Business', 'Marketing', 'Design', 'Apprendimento', 'Carriera', 'Tirocini', 'Opportunità internazionali', 'Imprenditorialità'],
  pt: ['TI', 'Negócios', 'Marketing', 'Design', 'Aprendizagem', 'Carreira', 'Estágios', 'Oportunidades internacionais', 'Empreendedorismo'],
  tr: ['BT', 'İşletme', 'Pazarlama', 'Tasarım', 'Öğrenim', 'Kariyer', 'Stajlar', 'Uluslararası fırsatlar', 'Girişimcilik'],
  hi: ['आईटी', 'व्यवसाय', 'मार्केटिंग', 'डिज़ाइन', 'सीखना', 'करियर', 'इंटर्नशिप', 'अंतरराष्ट्रीय अवसर', 'उद्यमिता'],
  ar: ['تقنية المعلومات', 'الأعمال', 'التسويق', 'التصميم', 'التعلم', 'المسار المهني', 'التدريب', 'فرص دولية', 'ريادة الأعمال'],
  zh: ['信息技术', '商业', '市场营销', '设计', '学习', '职业发展', '实习', '国际机会', '创业'],
  ja: ['IT', 'ビジネス', 'マーケティング', 'デザイン', '学習', 'キャリア', 'インターンシップ', '海外の機会', '起業'],
  ko: ['IT', '비즈니스', '마케팅', '디자인', '학습', '커리어', '인턴십', '국제 기회', '기업가정신'],
}

const ukrainianDescriptions: Record<string, string> = {
  IT: 'Технології, програмування, цифрові інструменти та комп’ютерні науки.',
  Business: 'Бізнес-ідеї, управління, фінанси та студентські проєкти.',
  Marketing: 'Маркетинг, комунікації, дослідження аудиторії та кампанії.',
  Design: 'Візуальний і продуктовий дизайн, UX та творча практика.',
  Learning: 'Навчання, курси, підготовка до іспитів і корисні матеріали.',
  Career: 'Планування кар’єри, резюме, співбесіди та професійний розвиток.',
  Internships: 'Стажування, практичний досвід і можливості для початку кар’єри.',
  'International Opportunities': 'Обміни, стипендії та можливості за кордоном.',
  Entrepreneurship: 'Власні проєкти, підприємництво та навчання на практиці.',
}

export const categoryTranslations = Object.fromEntries(
  Object.entries(labels).map(([language, titles]) => [
    language,
    Object.fromEntries(
      CATEGORIES.map((category, index) => [
        category,
        {
          title: titles[index] ?? category,
          ...(language === 'uk' && ukrainianDescriptions[category]
            ? { description: ukrainianDescriptions[category] }
            : {}),
        },
      ]),
    ),
  ]),
) as Record<string, Record<string, { title: string; description?: string }>>

export function categoryLabel(category: string, language = 'uk') {
  return categoryTranslations[language]?.[category]?.title ?? category
}
