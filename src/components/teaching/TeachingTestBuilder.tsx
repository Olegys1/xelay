import { useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from 'lucide-react'
import { kyivDeadline, localDeadline, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestQuestion, type TeachingTestQuestionKind, type TeachingTestRepository } from '../../lib/teachingTests'
import { isStudyGroupListed } from '../../lib/studyGroupVisibility'
import { TeachingAudienceFields } from './TeachingAudienceFields'
import { TeachingWorkTypeField } from './TeachingGradingRulesEditor'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-tests.css'

export const TEST_QUESTION_LABELS: Record<TeachingTestQuestionKind, string> = { choice: 'Одна правильна відповідь', boolean: 'Твердження: так або ні', sorting: 'Сортування за категоріями', sequence: 'Правильна послідовність' }
function newQuestion(kind: TeachingTestQuestionKind = 'choice'): TeachingTestQuestion {
  const options = Array.from({ length: kind === 'boolean' ? 2 : 4 }, (_, index) => ({ id: kind === 'boolean' ? index === 0 ? 'true' : 'false' : crypto.randomUUID(), text: kind === 'boolean' ? index === 0 ? 'Так' : 'Ні' : '' }))
  const buckets = kind === 'sorting' ? [{ id: crypto.randomUUID(), text: '' }, { id: crypto.randomUUID(), text: '' }] : []
  return { id: crypto.randomUUID(), kind, text: '', points: 1, time_limit_seconds: 30, partial_credit: false, options, buckets,
    answer: kind === 'sequence' ? options.map(option => option.id) : kind === 'sorting' ? {} : kind === 'boolean' ? 'true' : options[0].id }
}

export function TeachingTestBuilder({ initial, snapshot, teachingRepository, repository, userId, groupId, onClose, onSaved }: {
  initial?: TeachingTest | null; snapshot: TeachingSnapshot; teachingRepository: TeachingRepository; repository: TeachingTestRepository; userId: string; groupId?: string
  onClose: () => void; onSaved: (detail: TeachingTestDetail) => void
}) {
  const groups = snapshot.groups.filter(group => group.status === 'accepted' && isStudyGroupListed(group.group_id, userId) && (group.permissions || snapshot.course.permissions).includes('assignments') && (group.permissions || snapshot.course.permissions).includes('grades'))
  const [test, setTest] = useState<TeachingTest>(() => initial ? { ...initial, journal_date: initial.journal_date || localDeadline(initial.opens_at).slice(0, 10), work_type: initial.work_type || 'Тест' } : { id: crypto.randomUUID(), course_id: snapshot.course.id, title: '', description: '', status: 'draft', journal_date: localDeadline(new Date().toISOString()).slice(0, 10), work_type: 'Тест',
    opens_at: new Date().toISOString(), closes_at: new Date(Date.now() + 86400000).toISOString(), duration_seconds: 1200, max_points: 20, category: '', allow_skip: true, allow_return: true,
    question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 0, bonus_points: 2, targets: [{ group_id: groupId || groups[0]?.group_id || '', audience_mode: 'all' as const, subgroup_ids: [] }].filter(target => target.group_id),
    questions: [newQuestion()], question_count: 1, version: 0, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null })
  const [opensAt, setOpensAt] = useState(localDeadline(test.opens_at)), [closesAt, setClosesAt] = useState(localDeadline(test.closes_at))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmPublish, setConfirmPublish] = useState(false)
  const lock = useRef(false)
  const update = (fields: Partial<TeachingTest>) => { setConfirmPublish(false); setTest(current => ({ ...current, ...fields })) }
  const changeQuestion = (id: string, fields: Partial<TeachingTestQuestion>) => update({ questions: test.questions.map(question => question.id === id ? { ...question, ...fields } : question) })
  const moveQuestion = (index: number, direction: number) => {
    const questions = [...test.questions]
    ;[questions[index], questions[index + direction]] = [questions[index + direction], questions[index]]
    update({ questions })
  }
  async function save(status: TeachingTest['status']) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const opens = kyivDeadline(opensAt), closes = kyivDeadline(closesAt)
      if (!opens || !closes || new Date(closes).getTime() <= new Date(opens).getTime()) throw new Error('Вкажіть початок і завершення доступу до тесту.')
      if (!test.title.trim() || !test.targets.length || !test.questions.length) throw new Error('Додайте назву, отримувачів і хоча б одне запитання.')
      if (test.questions.some(question => !question.text.trim() || question.options.some(option => !option.text.trim()) || question.buckets.some(bucket => !bucket.text.trim()))) throw new Error('Заповніть текст запитань, варіантів і категорій.')
      if (test.questions.some(question => question.kind === 'sorting' && question.options.some(option => !(question.answer as Record<string, string>)?.[option.id]))) throw new Error('Вкажіть правильну категорію для кожного елемента сортування.')
      const result = await repository.mutate('save_test', { ...test, expected_user_id: userId, opens_at: opens, closes_at: closes, status, question_count: test.questions.length })
      onSaved(result)
    } catch (failure) { setError(failure instanceof Error && !failure.message.startsWith('TEST_') ? failure.message : teachingTestError(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save('draft') }
  return <TeachingModal wide title={initial ? 'Редагування тесту' : 'Новий тест'} description={snapshot.course.title} onClose={onClose} busy={busy}>
    <form className="teaching-form" onSubmit={submit}>
      {error && <p className="teaching-error" role="alert">{error}</p>}
      <fieldset disabled={busy} className="teaching-form">
        <section className="teaching-test-section"><h3>Про роботу</h3>
          <TeachingField label="Назва тесту"><input required maxLength={180} className={teachingInput} value={test.title} placeholder="Наприклад, контрольна з теми «Попит і пропозиція»" onChange={event => update({ title: event.target.value })} /></TeachingField>
          <TeachingField label="Пояснення для студентів"><textarea rows={3} maxLength={10000} className={teachingInput} value={test.description} onChange={event => update({ description: event.target.value })} /></TeachingField>
          <div className="teaching-test-grid"><TeachingField label="Максимальний результат" hint="Вага запитань перераховується в цей максимум. Підсумок разом із бонусом також ним обмежений."><input required type="number" min="0.01" max="10000" step="0.01" className={teachingInput} value={test.max_points} onChange={event => update({ max_points: Number(event.target.value) })} /></TeachingField>
            <TeachingField label="Категорія в журналі"><select className={teachingInput} value={test.category} onChange={event => update({ category: event.target.value })}><option value="">Без категорії</option>{snapshot.course.grading_rules.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></TeachingField></div>
          <div className="teaching-test-grid"><TeachingField label="Дата роботи в журналі" hint="Окрема дата для колонки цього тесту в журналі балів."><input required type="date" className={teachingInput} value={test.journal_date || localDeadline(test.opens_at).slice(0, 10)} onChange={event => update({ journal_date: event.target.value })} /></TeachingField><TeachingWorkTypeField value={test.work_type || 'Тест'} onChange={work_type => update({ work_type })} /></div>
        </section>
        <section className="teaching-test-section"><h3>Групи й підгрупи</h3><p>Тест побачать лише вибрані отримувачі. Кожен студент матиме одну особисту спробу.</p>
          <div className="teaching-test-targets">{groups.map(group => {
            const target = test.targets.find(target => target.group_id === group.group_id)
            return <div className="teaching-test-target" key={group.group_id}><label><input type="checkbox" checked={Boolean(target)} onChange={event => update({ targets: event.target.checked ? [...test.targets, { group_id: group.group_id, audience_mode: 'all', subgroup_ids: [] }] : test.targets.filter(target => target.group_id !== group.group_id) })} /><span>{group.group_name}</span></label>
              {target && <TeachingAudienceFields repository={teachingRepository} courseId={snapshot.course.id} groupId={group.group_id} allowTeams={false} value={target} onChange={audience => update({ targets: test.targets.map(target => target.group_id === group.group_id ? { group_id: audience.group_id, audience_mode: audience.audience_mode === 'subgroups' ? 'subgroups' : 'all', subgroup_ids: audience.subgroup_ids || [] } : target) })} />}</div>
          })}</div>
        </section>
        <section className="teaching-test-section"><h3>Час і правила проходження</h3>
          <div className="teaching-test-grid"><TeachingField label="Відкрити тест" hint="Дата й час за Києвом."><input required type="datetime-local" className={teachingInput} value={opensAt} onChange={event => { setConfirmPublish(false); setOpensAt(event.target.value) }} /></TeachingField><TeachingField label="Закрити тест" hint="У цей час активні спроби теж завершуються."><input required type="datetime-local" className={teachingInput} value={closesAt} min={opensAt} onChange={event => { setConfirmPublish(false); setClosesAt(event.target.value) }} /></TeachingField>
            <TeachingField label="На весь тест, хвилин"><input required type="number" min="1" max="1440" step="1" className={teachingInput} value={test.duration_seconds / 60} onChange={event => update({ duration_seconds: Number(event.target.value) * 60 })} /></TeachingField>
            <TeachingField label="Коли студент залишає запитання"><select className={teachingInput} value={test.question_timer_policy} onChange={event => update({ question_timer_policy: event.target.value as TeachingTest['question_timer_policy'] })}><option value="continue">Таймер продовжується, повернення за правилами</option><option value="lock_on_leave">Зафіксувати відповідь одразу після переходу</option></select></TeachingField></div>
          <label className="teaching-check"><input type="checkbox" checked={test.allow_skip} onChange={event => update({ allow_skip: event.target.checked })} />Дозволити пропускати запитання</label>
          <label className="teaching-check"><input type="checkbox" checked={test.allow_return} onChange={event => update({ allow_return: event.target.checked })} />Дозволити повертатися до попередніх запитань</label>
          <label className="teaching-check"><input type="checkbox" checked={test.restrict_copy} onChange={event => update({ restrict_copy: event.target.checked })} />Обмежити виділення й копіювання тексту завдань</label>
          <p>Копіювання через інтерфейс буде обмежено. Фото екрана та скриншоти повністю заблокувати неможливо. Час кожного запитання налаштовується нижче.</p>
        </section>
        <section className="teaching-test-section"><h3>Бонус за результат і швидкість</h3><p>Спочатку порівнюється правильність, за однакового результату враховується швидкість. Бонус визначається після завершення доступу до тесту. Кількість призових місць округлюється вгору.</p>
          <div className="teaching-test-grid"><TeachingField label="Хто отримує бонус"><select className={teachingInput} value={test.bonus_percent} onChange={event => update({ bonus_percent: Number(event.target.value) as TeachingTest['bonus_percent'] })}><option value="0">Без бонусу</option><option value="10">Найкращі 10%</option><option value="20">Найкращі 20%</option></select></TeachingField><TeachingField label="Додаткових балів" hint={`Разом можна отримати щонайбільше ${test.max_points} балів.`}><input type="number" min="0" max={test.max_points} step="0.01" className={teachingInput} value={test.bonus_points} disabled={!test.bonus_percent} onChange={event => update({ bonus_points: Number(event.target.value) })} /></TeachingField></div>
        </section>
        <div className="teaching-test-heading"><div><h2>Запитання</h2><p>Для кожного запитання вкажіть правильну відповідь, бали та час.</p></div><span className="teaching-badge">Запитань {test.questions.length}</span></div>
        {test.questions.map((question, index) => <QuestionEditor key={question.id} question={question} index={index} count={test.questions.length} onChange={fields => changeQuestion(question.id, fields)} onMove={direction => moveQuestion(index, direction)} onDelete={() => update({ questions: test.questions.filter(item => item.id !== question.id) })} />)}
        <TeachingButton disabled={test.questions.length >= 100} onClick={() => update({ questions: [...test.questions, newQuestion()] })}><Plus size={16} />Додати запитання</TeachingButton>
      </fieldset>
      {confirmPublish && <div className="teaching-test-confirm"><h4>Опублікувати тест для вибраних отримувачів?</h4><p>Перед початком студент побачить усі правила. Після першої спроби умови та запитання фіксуються. Результати спочатку перевіряє викладач.</p><div className="teaching-test-actions"><TeachingButton primary busy={busy} onClick={() => void save('published')}>Так, опублікувати тест</TeachingButton><TeachingButton disabled={busy} onClick={() => setConfirmPublish(false)}>Повернутися до редагування</TeachingButton></div></div>}
      <div className="teaching-test-footer"><p><ListChecks size={14} className="mr-1 inline" />Оцінки публікуються окремо після перевірки.</p><div className="teaching-test-actions"><TeachingButton disabled={busy} onClick={onClose}>Скасувати</TeachingButton><TeachingButton type="submit" busy={busy}>Зберегти чернетку</TeachingButton><TeachingButton primary disabled={busy} onClick={() => { setError(''); setConfirmPublish(true) }}>Опублікувати</TeachingButton></div></div>
    </form>
  </TeachingModal>
}

function QuestionEditor({ question, index, count, onChange, onMove, onDelete }: { question: TeachingTestQuestion; index: number; count: number; onChange: (fields: Partial<TeachingTestQuestion>) => void; onMove: (direction: number) => void; onDelete: () => void }) {
  const updateOption = (id: string, text: string) => onChange({ options: question.options.map(option => option.id === id ? { ...option, text } : option) })
  const order = Array.isArray(question.answer) ? question.answer : question.options.map(option => option.id)
  function moveAnswer(index: number, direction: number) { const next = [...order]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange({ answer: next }) }
  return <section className="teaching-test-question-editor">
    <div className="teaching-test-question-top"><h3>Запитання {index + 1}</h3><div className="teaching-test-question-tools"><button type="button" className="teaching-icon-button" aria-label={`Перемістити запитання ${index + 1} вище`} disabled={!index} onClick={() => onMove(-1)}><ArrowUp size={16} /></button><button type="button" className="teaching-icon-button" aria-label={`Перемістити запитання ${index + 1} нижче`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown size={16} /></button><button type="button" className="teaching-icon-button" aria-label={`Видалити запитання ${index + 1}`} disabled={count === 1} onClick={onDelete}><Trash2 size={16} /></button></div></div>
    <TeachingField label="Тип запитання"><select className={teachingInput} value={question.kind} onChange={event => onChange({ ...newQuestion(event.target.value as TeachingTestQuestionKind), id: question.id, text: question.text, points: question.points, time_limit_seconds: question.time_limit_seconds })}>{Object.entries(TEST_QUESTION_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></TeachingField>
    <TeachingField label="Текст завдання"><textarea required rows={3} maxLength={10000} className={teachingInput} value={question.text} onChange={event => onChange({ text: event.target.value })} /></TeachingField>
    <div className="teaching-test-grid"><TeachingField label="Вага запитання, балів"><input required type="number" min="0.01" max="10000" step="0.01" className={teachingInput} value={question.points} onChange={event => onChange({ points: Number(event.target.value) })} /></TeachingField><TeachingField label="На це запитання, секунд" hint="Порожнє поле означає лише загальний таймер тесту."><input type="number" min="5" max="86400" step="1" className={teachingInput} value={question.time_limit_seconds ?? ''} onChange={event => onChange({ time_limit_seconds: event.target.value ? Number(event.target.value) : null })} /></TeachingField></div>
    {question.kind === 'boolean' ? <TeachingField label="Правильна відповідь"><select className={teachingInput} value={String(question.answer)} onChange={event => onChange({ answer: event.target.value })}><option value="true">Так</option><option value="false">Ні</option></select></TeachingField> : <>
      <p className="text-xs text-muted-foreground">{question.kind === 'choice' ? 'Позначте одну правильну відповідь.' : question.kind === 'sequence' ? 'Додайте елементи, потім задайте правильний порядок.' : 'Додайте елементи та вкажіть правильну категорію кожного.'}</p>
      {question.options.map((option, optionIndex) => <div className="teaching-test-option-edit" key={option.id}>{question.kind === 'choice' ? <input type="radio" aria-label={`Варіант ${optionIndex + 1} правильний`} name={`correct-${question.id}`} checked={question.answer === option.id} onChange={() => onChange({ answer: option.id })} /> : <span>{optionIndex + 1}</span>}<input required aria-label={`Елемент ${optionIndex + 1}`} maxLength={2000} className={teachingInput} value={option.text} onChange={event => updateOption(option.id, event.target.value)} />{question.kind !== 'choice' && <button type="button" disabled={question.options.length <= 2} className="teaching-icon-button" aria-label={`Видалити елемент ${optionIndex + 1}`} onClick={() => { const options = question.options.filter(item => item.id !== option.id); const answer = question.kind === 'sequence' ? order.filter(id => id !== option.id) : Object.fromEntries(Object.entries(question.answer || {}).filter(([id]) => id !== option.id)); onChange({ options, answer }) }}><Trash2 size={15} /></button>}</div>)}
      {question.kind !== 'choice' && <TeachingButton disabled={question.options.length >= 30} onClick={() => { const option = { id: crypto.randomUUID(), text: '' }; onChange({ options: [...question.options, option], ...(question.kind === 'sequence' ? { answer: [...order, option.id] } : {}) }) }}><Plus size={14} />Додати елемент</TeachingButton>}
    </>}
    {question.kind === 'sorting' && <div className="teaching-test-section"><h3>Категорії та правильне розміщення</h3>{question.buckets.map((bucket, bucketIndex) => <div key={bucket.id} className="teaching-test-option-edit"><input required aria-label={`Категорія ${bucketIndex + 1}`} className={teachingInput} maxLength={300} value={bucket.text} onChange={event => onChange({ buckets: question.buckets.map(item => item.id === bucket.id ? { ...item, text: event.target.value } : item) })} /><button type="button" className="teaching-icon-button" disabled={question.buckets.length <= 2} aria-label={`Видалити категорію ${bucketIndex + 1}`} onClick={() => onChange({ buckets: question.buckets.filter(item => item.id !== bucket.id), answer: Object.fromEntries(Object.entries(question.answer || {}).filter(([, id]) => id !== bucket.id)) })}><Trash2 size={15} /></button></div>)}<TeachingButton disabled={question.buckets.length >= 10} onClick={() => onChange({ buckets: [...question.buckets, { id: crypto.randomUUID(), text: '' }] })}><Plus size={14} />Додати категорію</TeachingButton>{question.options.map((option, index) => <TeachingField key={option.id} label={option.text || `Елемент ${index + 1}`}><select required className={teachingInput} value={(question.answer as Record<string, string>)?.[option.id] || ''} onChange={event => onChange({ answer: { ...(question.answer as Record<string, string>), [option.id]: event.target.value } })}><option value="">Оберіть правильну категорію</option>{question.buckets.map((bucket, index) => <option key={bucket.id} value={bucket.id}>{bucket.text || `Категорія ${index + 1}`}</option>)}</select></TeachingField>)}</div>}
    {question.kind === 'sequence' && <div className="teaching-test-section"><h3>Правильний порядок</h3><div className="teaching-test-sequence">{order.map((id, index) => <div className="teaching-test-sequence-row" key={id}><span>{index + 1}</span><p>{question.options.find(option => option.id === id)?.text || 'Заповніть елемент'}</p><div><button type="button" className="teaching-icon-button" aria-label={`Правильний елемент ${index + 1} вище`} disabled={!index} onClick={() => moveAnswer(index, -1)}><ArrowUp size={16} /></button><button type="button" className="teaching-icon-button" aria-label={`Правильний елемент ${index + 1} нижче`} disabled={index === order.length - 1} onClick={() => moveAnswer(index, 1)}><ArrowDown size={16} /></button></div></div>)}</div></div>}
    {(question.kind === 'sorting' || question.kind === 'sequence') && <label className="teaching-check"><input type="checkbox" checked={question.partial_credit} onChange={event => onChange({ partial_credit: event.target.checked })} />Нараховувати частину балів за правильно розміщені елементи</label>}
  </section>
}
