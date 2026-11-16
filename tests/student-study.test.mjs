import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const module = { exports: {} }
const source = readFileSync(new URL('../src/lib/studentStudy.ts', import.meta.url), 'utf8')
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, Date, Intl, Set, Map, JSON, Number, Object, Array, String, Math })
const { initialStudyState, parseStudyState, studyScore, scheduleCard, parseManualCards, buildStudyPlan, studyDay, validStudyDay, addStudyDays, STUDY_QUESTIONS, STUDY_CARDS } = module.exports
const today = '2026-11-16'
const plain = value => JSON.parse(JSON.stringify(value))

test('quiz counts correct, missing and invalid selections without claiming an exam grade', () => {
  const correct = Object.fromEntries(STUDY_QUESTIONS.map(q => [q.id, q.correct]))
  assert.deepEqual(plain(studyScore(STUDY_QUESTIONS, correct)), { correct: 6, total: 6, percent: 100, mistakes: [], answered: 6 })
  const partial = studyScore(STUDY_QUESTIONS, { q1: 0, q2: -1, q3: 12, ignored: 0 })
  assert.equal(partial.correct, 1)
  assert.equal(partial.answered, 1)
  assert.equal(partial.mistakes.length, 5)
  assert.equal(studyScore([], {}).percent, 0)
})

test('full training, notes and plan resume after serialization', () => {
  const state = initialStudyState(today)
  state.answers = { q1: 0, q2: 1 }
  state.questionIds = ['q2', 'q1']
  state.submitted = true
  state.notes = 'Мої нотатки\nПопит — не те саме, що величина попиту.'
  state.examDate = '2026-12-05'
  state.dailyMinutes = 45
  state.completedDays = [today, '2026-11-17']
  state.cards.c1 = scheduleCard(undefined, 'easy', today)
  const restored = parseStudyState(JSON.stringify(state), today)
  assert.deepEqual(plain(restored), plain(state))
  assert.equal(studyScore(STUDY_QUESTIONS.filter(q => restored.questionIds.includes(q.id)), restored.answers).correct, 2)
})

test('custom card interval survives reload with stable identity', () => {
  const state = initialStudyState(today)
  state.customCards = parseManualCards('Попит — Бажання та можливість купівлі.\nРівновага — Попит дорівнює пропозиції.')
  const card = state.customCards[0]
  state.cards[card.id] = scheduleCard(undefined, 'easy', today)
  const restored = parseStudyState(JSON.stringify(state), today)
  assert.equal(restored.customCards[0].id, card.id)
  assert.equal(restored.cards[card.id].due, '2026-11-20')
  assert.deepEqual(plain(parseStudyState(JSON.stringify(restored), today)), plain(restored))
})

test('state recovery rejects corrupt, oversized or unsupported storage and bounds values', () => {
  for (const raw of [null, '{', '[]', '{"version":2}', 'x'.repeat(200001)]) assert.deepEqual(plain(parseStudyState(raw, today)), plain(initialStudyState(today)))
  const state = parseStudyState(JSON.stringify({ version: 1, answers: { q1: 100, q2: -1, q3: 1, fake: 0 }, questionIds: ['fake', 'q1', 'q1', 'q3'], notes: 'a'.repeat(40000), dailyMinutes: 999, examDate: '2026-02-30', completedDays: [today, today, '<script>'], cards: { fake: { due: today, interval: 2, repetitions: 1, lastRating: 'easy' }, c1: { due: today, interval: -5, repetitions: 1, lastRating: 'easy' } } }), today)
  assert.deepEqual(plain(state.answers), { q3: 1 })
  assert.deepEqual(plain(state.questionIds), ['q1', 'q3'])
  assert.equal(state.notes.length, 30000)
  assert.equal(state.dailyMinutes, 120)
  assert.equal(state.examDate, '2026-11-26')
  assert.deepEqual(plain(state.completedDays), [today])
  assert.deepEqual(plain(state.cards), {})
})

test('untrusted custom card identifiers cannot collide with built-in cards or inject object keys', () => {
  const state = parseStudyState(JSON.stringify({ version: 1, customCards: [{ id: '__proto__', front: '<img src=x onerror=alert(1)>', back: 'Only text' }, { id: 'c1', front: 'Term', back: 'Definition' }, { id: 'own-valid', front: 'First', back: 'One' }, { id: 'own-valid', front: 'Duplicate', back: 'Two' }] }), today)
  assert.equal(state.customCards.length, 3)
  assert.match(state.customCards[0].id, /^own-/)
  assert.equal(state.customCards[0].front, '<img src=x onerror=alert(1)>')
  assert.equal(state.customCards.filter(c => c.id === 'own-valid').length, 1)
  assert.equal(Object.prototype.polluted, undefined)
})

test('card review intervals are real calendar days and remain bounded', () => {
  assert.equal(scheduleCard(undefined, 'again', today).due, today)
  assert.equal(scheduleCard(undefined, 'hard', today).due, '2026-11-17')
  assert.equal(scheduleCard(undefined, 'good', today).due, '2026-11-17')
  const easy = scheduleCard(undefined, 'easy', today)
  assert.equal(easy.due, '2026-11-20')
  assert.equal(scheduleCard(easy, 'good', today).interval, 9)
  assert.equal(scheduleCard({ ...easy, interval: 365, repetitions: 10000 }, 'easy', today).interval, 365)
  assert.equal(scheduleCard({ ...easy, interval: NaN, repetitions: NaN }, 'good', today).repetitions, 1)
  assert.throws(() => scheduleCard(undefined, 'other', today))
})

test('study day follows Kyiv while calendar arithmetic stays stable through DST', () => {
  assert.equal(studyDay(new Date('2026-11-16T22:30:00Z')), '2026-11-17')
  assert.equal(studyDay(new Date('2026-06-16T21:30:00Z')), '2026-06-17')
  assert.equal(addStudyDays('2026-10-24', 2), '2026-10-26')
  assert.equal(validStudyDay('2026-02-30'), false)
  assert.equal(validStudyDay('2028-02-29'), true)
  assert.throws(() => addStudyDays('wrong', 1))
})

test('plan starts with missed topics, respects available daily time and limits horizon', () => {
  const plan = buildStudyPlan(today, '2026-11-26', 25, ['Еластичність'])
  assert.equal(plan.length, 10)
  assert.equal(plan[0].date, today)
  assert.equal(plan[0].topic, 'Еластичність')
  assert.equal(plan[0].minutes, 25)
  assert.match(plan[9].title, /Пробний залік/)
  assert.equal(buildStudyPlan(today, '2028-01-01', 999).length, 60)
  assert.equal(buildStudyPlan(today, '2028-01-01', 999)[0].minutes, 120)
  assert.equal(buildStudyPlan(today, '2026-11-17', 2)[0].minutes, 10)
  assert.equal(buildStudyPlan(today, today, 25).length, 0)
  assert.equal(buildStudyPlan(today, 'bad-date', 25).length, 0)
  assert.equal(buildStudyPlan(today, '2026-11-26', Infinity).length, 0)
})

test('manual card import accepts explicit term/definition pairs and caps input', () => {
  assert.equal(parseManualCards('Unstructured text without an explicit separator').length, 0)
  assert.equal(parseManualCards('Попит — Пояснення\nПропозиція – Інше пояснення').length, 2)
  assert.equal(parseManualCards(Array.from({ length: 70 }, (_, i) => `Термін ${i} — Визначення ${i}`).join('\n')).length, 50)
  assert.equal(STUDY_CARDS.length, 6)
})
test('production preparation starts without fixed questions or cards and preserves owned notes, review intervals and subject',()=>{
 const empty=initialStudyState(today,true);assert.deepEqual(plain(empty.questionIds),[]);assert.deepEqual(plain(empty.customCards),[])
 const cards=parseManualCards('Мій термін — Моє пояснення');empty.customCards=cards;empty.subject='Біологія';empty.notes='Власний конспект';empty.cards[cards[0].id]=scheduleCard(undefined,'easy',today);empty.questionIds=['q1'];empty.answers={q1:0};empty.cards.c1=scheduleCard(undefined,'easy',today)
 const restored=parseStudyState(JSON.stringify(empty),today,true);assert.equal(restored.subject,'Біологія');assert.equal(restored.notes,'Власний конспект');assert.deepEqual(plain(restored.customCards),plain(cards));assert.equal(restored.cards[cards[0].id].due,'2026-11-20');assert.deepEqual(plain(restored.questionIds),[]);assert.deepEqual(plain(restored.answers),{});assert.equal(restored.cards.c1,undefined)
 for(const raw of [null,'{broken'])assert.deepEqual(plain(parseStudyState(raw,today,true).questionIds),[])
})
test('production personal plan uses the chosen subject rather than seeded economics topics',()=>{
 const own=buildStudyPlan(today,'2026-11-26',30,[],['Біологія']);assert.ok(own.every(day=>day.topic==='Біологія'));assert.ok(own.every(day=>day.minutes===30));assert.equal(own.length,10)
 const unnamed=buildStudyPlan(today,'2026-11-26',25,[],[]);assert.ok(unnamed.every(day=>day.topic==='Власний матеріал'))
})
test('preparation remains exposed for expired owners while mutation and creation follow current access',()=>{
 const ui=readFileSync(new URL('../src/components/student/StudyWorkbench.tsx',import.meta.url),'utf8'),page=readFileSync(new URL('../src/pages/StudentLearningPage.tsx',import.meta.url),'utf8')
 assert.ok(page.includes("{id:'prepare',label:'Підготовка'"));assert.ok(page.includes('<StudyWorkbench plan={plan} storageOwner={userId} emptyStart enabled={paid}/>'))
 assert.ok(ui.includes("const storageKey=storageOwner?STUDY_STORAGE_KEY+':owner:'+storageOwner:STUDY_STORAGE_KEY"));assert.ok(ui.includes("const canCreateCards = enabled&&currentTier !== 'start'"));assert.ok(ui.includes('function mutate(update:(value:StudyState)=>StudyState){if(enabled)setState(update)}'));assert.ok(ui.includes('onClick={downloadOwn}'));assert.ok(ui.includes('readOnly={!enabled} value={state.notes}'));assert.ok(ui.includes("TABS.filter(item=>!emptyStart||!['overview','practice'].includes(item.id))"))
})
