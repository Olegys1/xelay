export type StudyQuestion = { id: string; topic: string; prompt: string; options: string[]; correct: number; explanation: string; source: string }
export type StudyCard = { id: string; front: string; back: string; topic: string }
export type CardReview = { due: string; interval: number; repetitions: number; lastRating: 'again' | 'hard' | 'good' | 'easy' }
export type StudyState = { version: 1; answers: Record<string, number>; questionIds: string[]; submitted: boolean; cards: Record<string, CardReview>; customCards: StudyCard[]; notes: string; examDate: string; dailyMinutes: number; completedDays: string[];subject?:string }
export const STUDY_STORAGE_KEY = 'xelay:local-student-workspace:synthetic:v1'
export const STUDY_QUESTIONS: StudyQuestion[] = [
  { id: 'q1', topic: 'Попит', prompt: 'Ціна товару зросла, а інші умови не змінилися. Що відбувається з величиною попиту?', options: ['Зменшується', 'Збільшується', 'Не змінюється', 'Крива попиту зміщується праворуч'], correct: 0, explanation: 'За законом попиту вища ціна зменшує величину попиту. Це рух уздовж наявної кривої, а не її зміщення.', source: 'Навчальний приклад · Попит і пропозиція, § 1' },
  { id: 'q2', topic: 'Пропозиція', prompt: 'Новий спосіб виробництва зменшив витрати. Як за інших рівних умов зміниться пропозиція?', options: ['Зменшиться', 'Збільшиться', 'Залишиться незмінною', 'Зникне рівноважна ціна'], correct: 1, explanation: 'Зниження витрат дозволяє виробникам пропонувати більший обсяг за кожної ціни. Крива пропозиції зміщується праворуч.', source: 'Навчальний приклад · Попит і пропозиція, § 2' },
  { id: 'q3', topic: 'Рівновага', prompt: 'Попит зростає, а пропозиція не змінюється. Яка зміна рівноваги є очікуваною?', options: ['Ціна падає, обсяг зростає', 'Ціна й обсяг зростають', 'Ціна й обсяг падають', 'Ціна зростає, обсяг падає'], correct: 1, explanation: 'За незмінної висхідної пропозиції зростання попиту підвищує і рівноважну ціну, і рівноважний обсяг.', source: 'Навчальний приклад · Ринкова рівновага, § 3' },
  { id: 'q4', topic: 'Еластичність', prompt: 'Ціна зросла на 10%, а величина попиту зменшилася на 20%. Яка приблизна цінова еластичність попиту за модулем?', options: ['0,5', '1', '2', '10'], correct: 2, explanation: 'За простим відсотковим методом |Ed| = 20% / 10% = 2. Попит еластичний. Для великих змін зазвичай застосовують метод середньої точки.', source: 'Навчальний приклад · Еластичність, § 4' },
  { id: 'q5', topic: 'Альтернативна вартість', prompt: 'Студент витрачає вечір на підготовку до іспиту замість оплачуваної зміни. Що є альтернативною вартістю цього вибору?', options: ['Ціна підручника', 'Усі витрати університету', 'Втрачений заробіток від найкращої відхиленої альтернативи', 'Нуль, бо навчання корисне'], correct: 2, explanation: 'Альтернативна вартість — цінність найкращої можливості, від якої відмовилися. У цьому прикладі це заробіток від зміни.', source: 'Навчальний приклад · Економічний вибір, § 5' },
  { id: 'q6', topic: 'Дефіцит', prompt: 'Держава встановила максимальну ціну нижче рівноважної. Що може виникнути на ринку?', options: ['Надлишок товару', 'Дефіцит товару', 'Нульовий попит', 'Обов’язково вища пропозиція'], correct: 1, explanation: 'За ціни нижче рівноважної покупці хочуть придбати більше, ніж виробники готові продати. Різниця утворює дефіцит.', source: 'Навчальний приклад · Регулювання цін, § 6' },
]
export const STUDY_CARDS: StudyCard[] = [
  { id: 'c1', front: 'Закон попиту', back: 'За інших рівних умов зі зростанням ціни величина попиту зменшується.', topic: 'Попит' },
  { id: 'c2', front: 'Зміщення кривої чи рух уздовж неї?', back: 'Зміна власної ціни — рух уздовж кривої. Дохід, смаки, ціни пов’язаних товарів — можливе зміщення попиту.', topic: 'Попит' },
  { id: 'c3', front: 'Ринкова рівновага', back: 'Стан, за якого величина попиту дорівнює величині пропозиції за певної ціни.', topic: 'Рівновага' },
  { id: 'c4', front: 'Цінова еластичність попиту', back: 'Відношення відсоткової зміни величини попиту до відсоткової зміни ціни. Для класифікації часто беруть модуль.', topic: 'Еластичність' },
  { id: 'c5', front: 'Альтернативна вартість', back: 'Цінність найкращої з відхилених альтернатив, а не сума всіх можливостей.', topic: 'Економічний вибір' },
  { id: 'c6', front: 'Обмеження максимальної ціни', back: 'Коли воно нижче рівноваги та реально діє, величина попиту може перевищувати пропозицію: виникає дефіцит.', topic: 'Регулювання цін' },
]

export function studyDay(date = new Date()): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date) }
export function validStudyDay(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value }
export function addStudyDays(date: string, days: number): string { if (!validStudyDay(date) || !Number.isFinite(days)) throw new Error('Некоректна дата'); return studyDay(new Date(Date.parse(date + 'T00:00:00Z') + Math.trunc(days) * 86400000)) }
export function initialStudyState(today = studyDay(),empty=false): StudyState { return { version: 1, answers: {}, questionIds: empty?[]:STUDY_QUESTIONS.map(q => q.id), submitted: false, cards: {}, customCards: [], notes: '', examDate: addStudyDays(today, 10), dailyMinutes: 25, completedDays: [] } }
export function studyScore(questions: StudyQuestion[], answers: Record<string, number>) {
  const correct = questions.filter(q => answers[q.id] === q.correct).length
  return { correct, total: questions.length, percent: questions.length ? Math.round(correct / questions.length * 100) : 0, mistakes: questions.filter(q => answers[q.id] !== q.correct), answered: questions.filter(q => Number.isInteger(answers[q.id]) && answers[q.id] >= 0 && answers[q.id] < q.options.length).length }
}
export function scheduleCard(previous: CardReview | undefined, rating: CardReview['lastRating'], today = studyDay()): CardReview {
  if (!validStudyDay(today) || !['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('Некоректне повторення')
  const old = Math.min(365, Math.max(0, Number.isFinite(previous?.interval) ? previous!.interval : 0))
  const interval = rating === 'again' ? 0 : rating === 'hard' ? Math.max(1, Math.ceil(old * 1.2)) : rating === 'good' ? Math.max(1, Math.ceil(old * 2.2)) : Math.max(4, Math.ceil(old * 3))
  return { due: addStudyDays(today, Math.min(365, interval)), interval: Math.min(365, interval), repetitions: Math.min(10000, Math.max(0, Number.isFinite(previous?.repetitions) ? previous!.repetitions : 0) + 1), lastRating: rating }
}
export function parseManualCards(text: string): StudyCard[] {
  return text.slice(0, 30000).split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(.{1,200}?)\s+[—–]\s+(.{1,2000})$/)
    return match && match[1].trim() && match[2].trim() ? [{ id: `own-${index}-${line.length}`, front: match[1].trim(), back: match[2].trim(), topic: 'Мої картки' }] : []
  }).slice(0, 50)
}
export type StudyPlanDay = { date: string; title: string; detail: string; minutes: number; topic: string }
export function buildStudyPlan(today: string, examDate: string, minutes: number, weakTopics: string[] = [],sourceTopics?:string[]): StudyPlanDay[] {
  if (!validStudyDay(today) || !validStudyDay(examDate) || examDate <= today || !Number.isFinite(minutes)) return []
  const count = Math.min(60, Math.max(1, Math.ceil((Date.parse(examDate) - Date.parse(today)) / 86400000)))
  const duration = Math.max(10, Math.min(120, Math.round(minutes)))
  const topics = [...new Set([...weakTopics, ...(sourceTopics||STUDY_QUESTIONS.map(q => q.topic))])];if(!topics.length)topics.push('Власний матеріал')
  return Array.from({ length: count }, (_, index) => ({ date: addStudyDays(today, index), title: index === count - 1 ? 'Пробний залік і спокійне повторення' : index % 3 === 2 ? 'Закріпити без підказок' : `Розібрати: ${topics[index % topics.length]}`, detail: index === count - 1 ? 'Пройти тренування, повернутися до помилок і завершити підготовку.' : index % 3 === 2 ? 'Повторити картки, перевірити себе та пояснити тему своїми словами.' : 'Перечитати нотатки, розв’язати приклад і зробити коротке самопояснення.', minutes: duration, topic: topics[index % topics.length] }))
}

function safeRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
export function parseStudyState(raw: string | null, today = studyDay(),empty=false): StudyState {
  const clean = initialStudyState(today,empty)
  if (!raw || raw.length > 200000) return clean
  try {
    const value: unknown = JSON.parse(raw)
    if (!safeRecord(value) || value.version !== 1) return clean
    if (!empty&&safeRecord(value.answers)) for (const q of STUDY_QUESTIONS) { const answer = value.answers[q.id]; if (Number.isInteger(answer) && Number(answer) >= 0 && Number(answer) < q.options.length) clean.answers[q.id] = Number(answer) }
    if (!empty&&Array.isArray(value.questionIds)) { const ids = [...new Set(value.questionIds.filter((id): id is string => typeof id === 'string' && STUDY_QUESTIONS.some(q => q.id === id)))]; if (ids.length) clean.questionIds = ids }
    clean.submitted = !empty&&value.submitted === true
    if(typeof value.subject==='string')clean.subject=value.subject.trim().slice(0,100)
    if (typeof value.notes === 'string') clean.notes = value.notes.slice(0, 30000)
    if (validStudyDay(value.examDate)) clean.examDate = value.examDate
    if (typeof value.dailyMinutes === 'number' && Number.isFinite(value.dailyMinutes)) clean.dailyMinutes = Math.min(120, Math.max(10, Math.round(value.dailyMinutes)))
    if (Array.isArray(value.completedDays)) clean.completedDays = [...new Set(value.completedDays.filter(validStudyDay))].slice(0, 365)
    if (Array.isArray(value.customCards)) { const seen = new Set<string>(); clean.customCards = value.customCards.flatMap((card, index) => {
      if (!safeRecord(card) || typeof card.front !== 'string' || typeof card.back !== 'string' || !card.front.trim() || !card.back.trim()) return []
      const id = typeof card.id === 'string' && /^own-[a-zA-Z0-9-]{1,80}$/.test(card.id) ? card.id : `own-saved-${index}`
      if (seen.has(id)) return []; seen.add(id)
      return [{ id, front: card.front.slice(0, 200), back: card.back.slice(0, 2000), topic: 'Мої картки' }]
    }).slice(0, 50) }
    const allowedCards = new Set([...(empty?[]:STUDY_CARDS), ...clean.customCards].map(c => c.id))
    if (safeRecord(value.cards)) for (const [id, card] of Object.entries(value.cards)) if (allowedCards.has(id) && safeRecord(card) && validStudyDay(card.due) && typeof card.interval === 'number' && Number.isInteger(card.interval) && card.interval >= 0 && card.interval <= 365 && typeof card.repetitions === 'number' && Number.isInteger(card.repetitions) && card.repetitions >= 0 && card.repetitions <= 10000 && ['again', 'hard', 'good', 'easy'].includes(String(card.lastRating))) clean.cards[id] = { due: card.due, interval: card.interval, repetitions: card.repetitions, lastRating: card.lastRating as CardReview['lastRating'] }
    return clean
  } catch { return clean }
}
