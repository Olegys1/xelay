import { CATEGORY_META } from '../lib/categoryMeta'

// Locale arrays predate the current catalog. Bind them to their original IDs,
// so reordering the displayed catalog cannot attach a title to another topic.
const ORIGINAL_CATEGORY_ORDER = [
  'IT', 'Business', 'Marketing', 'Design', 'Learning', 'Career',
  'Internships', 'International Opportunities', 'Entrepreneurship',
] as const

const labels: Record<string, string[]> = {
  en: ['IT', 'Business', 'Marketing', 'Design', 'Learning', 'Career', 'Internships', 'International Opportunities', 'Entrepreneurship'],
  uk: ORIGINAL_CATEGORY_ORDER.map((category) => CATEGORY_META[category].title),
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

export const categoryTranslations = Object.fromEntries(
  Object.entries(labels).map(([language, titles]) => [
    language,
    Object.fromEntries(
      ORIGINAL_CATEGORY_ORDER.map((category, index) => [
        category,
        {
          title: language === 'uk' ? CATEGORY_META[category].title : titles[index] ?? category,
          ...(language === 'uk'
            ? { description: CATEGORY_META[category].description }
            : {}),
        },
      ]),
    ),
  ]),
) as Record<string, Record<string, { title: string; description?: string }>>

// New topics use the Ukrainian catalog without changing legacy locale arrays.
for (const [category, meta] of Object.entries(CATEGORY_META)) {
  categoryTranslations.uk[category] = { title: meta.title, description: meta.description }
}

export function categoryLabel(category: string, language = 'uk') {
  return categoryTranslations[language]?.[category]?.title ?? categoryTranslations.uk?.[category]?.title ?? category
}
