export type TeacherPlanId = 'teacher_start' | 'teacher_plus' | 'teacher_max'

export const TEACHER_PLANS = [
  {
    id: 'teacher_start', name: 'Старт', price: 199, number: '01',
    promise: 'Підготувати наступну пару.',
    description: 'Від матеріалу до чернетки тесту чи завдання — без порожнього аркуша.',
    fileLimitMb: 100,
    features: ['Тести й завдання з теми або вашого тексту', 'Кілька варіантів для однієї роботи', 'Запропоновані ключі та пояснення', 'Приватні чернетки з редагуванням', 'Особистий архів завершених тестів'],
    example: 'Зроби два варіанти тесту з теми «Попит і пропозиція» на 15 хвилин.',
  },
  {
    id: 'teacher_plus', name: 'Плюс', price: 499, number: '02',
    promise: 'Перевірити уважніше. Швидше.',
    description: 'Усе зі Старту та помічник для попереднього розбору робіт за вашими критеріями.',
    fileLimitMb: 150,
    features: ['Усе зі Старту', 'Попередній розбір роботи за рубрикою', 'Пропозиція балів із поясненням', 'Редагований фідбек, який підтверджуєте ви'],
    example: 'Розбери цю відповідь за моїми критеріями й підготуй короткий фідбек.',
  },
  {
    id: 'teacher_max', name: 'Макс', price: 999, number: '03',
    promise: 'Побачити, що потрібно групам.',
    description: 'Усе з Плюса та спільний розбір результатів ваших груп із практикою на складні теми.',
    fileLimitMb: 200,
    features: ['Усе з Плюса', 'Черга роботи з кількома дозволеними групами', 'Розбір якості тесту й типових помилок', 'Додаткова практика за результатами'],
    example: 'Знайди теми, у яких групи помиляються, і підготуй додаткову практику.',
  },
] as const satisfies readonly {
  id: TeacherPlanId; name: string; price: number; number: string; promise: string;
  description: string; fileLimitMb: number; features: readonly string[]; example: string
}[]

export const TEACHER_FREE_FEATURES = [
  'Предмети й підключення навчальних груп',
  'Розклад, завдання, тести та журнал',
  'Загальний обсяг бібліотеки поки не обмежуємо · до 50 МБ на файл',
  'Ручна перевірка, публікація результатів і повторні спроби',
] as const

export const isTeacherPlanId = (value: unknown): value is TeacherPlanId =>
  value === 'teacher_start' || value === 'teacher_plus' || value === 'teacher_max'
