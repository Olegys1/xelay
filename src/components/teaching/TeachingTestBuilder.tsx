import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BookOpen, ListChecks, Plus, Trash2, Upload } from 'lucide-react'
import { kyivDeadline, localDeadline, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestQuestion, type TeachingTestQuestionKind, type TeachingTestRepository } from '../../lib/teachingTests'
import { isStudyGroupListed, TEACHING_QA_GROUP_ID, TEACHING_QA_OWNER_ID } from '../../lib/studyGroupVisibility'
import { TeachingAudienceFields } from './TeachingAudienceFields'
import { TeachingWorkTypeField } from './TeachingGradingRulesEditor'
import { TeachingSectionHelp, TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import { newTeachingQuestion as newQuestion, questionValidationMessage, TeachingQuestionEditor as QuestionEditor } from './TeachingQuestionEditor'
import { TeachingTestIntegritySettings } from './TeachingTestIntegritySettings'
import { TeachingQuestionBank } from './TeachingQuestionBank'
import { TeachingQuestionImportPanel } from './TeachingQuestionImportPanel'
import './teaching-tests.css'
import './teaching-assessment-phase1.css'

export { TEST_QUESTION_LABELS } from './TeachingQuestionEditor'

export function TeachingTestBuilder({ initial, snapshot, teachingRepository, repository, userId, groupId, onClose, onSaved }: {
  initial?: TeachingTest | null; snapshot: TeachingSnapshot; teachingRepository: TeachingRepository; repository: TeachingTestRepository; userId: string; groupId?: string
  onClose: () => void; onSaved: (detail: TeachingTestDetail) => void
}) {
  const groups = snapshot.groups.filter(group => group.status === 'accepted' && isStudyGroupListed(group.group_id, userId) && (group.permissions || snapshot.course.permissions).includes('assignments') && (group.permissions || snapshot.course.permissions).includes('grades'))
  const [test, setTest] = useState<TeachingTest>(() => initial ? { ...initial, journal_date: initial.journal_date || localDeadline(initial.opens_at).slice(0, 10), work_type: initial.work_type || 'Тест' } : { id: crypto.randomUUID(), course_id: snapshot.course.id, title: '', description: '', status: 'draft', journal_date: localDeadline(new Date().toISOString()).slice(0, 10), work_type: 'Тест',
    opens_at: new Date().toISOString(), closes_at: new Date(Date.now() + 86400000).toISOString(), duration_seconds: 1200, max_points: 20, category: '', allow_skip: true, allow_return: true,
    question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 0, bonus_points: 2, targets: [{ group_id: groupId || groups[0]?.group_id || '', audience_mode: 'all' as const, subgroup_ids: [] }].filter(target => target.group_id),
    questions: [newQuestion()], question_count: 1, version: 0, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null, shuffle_questions: false, shuffle_answers: false, draw_count: null, overrides: [] })
  const [opensAt, setOpensAt] = useState(localDeadline(test.opens_at)), [closesAt, setClosesAt] = useState(localDeadline(test.closes_at))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmPublish, setConfirmPublish] = useState(false)
  const [bankOpen, setBankOpen] = useState(false), [overrideStudent, setOverrideStudent] = useState('')
  const [importOpen, setImportOpen] = useState(false), [importReading, setImportReading] = useState(false)
  const [variantId, setVariantId] = useState('')
  const [uploadingQuestions, setUploadingQuestions] = useState<string[]>([])
  const uploadingImage = uploadingQuestions.length > 0
  const lock = useRef(false)
  const alive = useRef(true), scope = useRef({ repository, userId, courseId: snapshot.course.id })
  if (scope.current.repository !== repository || scope.current.userId !== userId || scope.current.courseId !== snapshot.course.id) scope.current = { repository, userId, courseId: snapshot.course.id }
  const renderScope = scope.current, initialScope = useRef(renderScope)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const update = (fields: Partial<TeachingTest>) => { setConfirmPublish(false); setTest(current => ({ ...current, ...fields })) }
  const qa = test.qa_own_attempt === true
  const needsQaDraft = qa && initial?.qa_own_attempt !== true
  const canConfigureQa = userId === TEACHING_QA_OWNER_ID && test.targets.length === 1
    && test.targets[0].group_id === TEACHING_QA_GROUP_ID && test.targets[0].audience_mode === 'all'
    && (!initial || initial.qa_can_enable === true && initial.status === 'draft' && !initial.has_attempts)
  const variants = test.variants || []
  const activeVariant = variants.find(variant => variant.id === variantId)
  const questions = activeVariant?.questions || test.questions
  const questionSets = [test.questions, ...variants.map(variant => variant.questions)]
  const smallestSet = questionSets.reduce((smallest, set) => Math.min(smallest, set.length), test.questions.length)
  const setQuestions = (change: (current: TeachingTestQuestion[]) => TeachingTestQuestion[]) => {
    setConfirmPublish(false)
    setTest(current => activeVariant
      ? { ...current, variants: current.variants?.map(variant => variant.id === activeVariant.id ? { ...variant, questions: change(variant.questions) } : variant) }
      : { ...current, questions: change(current.questions) })
  }
  const addVariant = (duplicate: boolean) => {
    const id = crypto.randomUUID()
    const usedTitles = new Set(variants.map(variant => variant.title))
    let number = variants.length + 2
    while (usedTitles.has(`Варіант ${number}`)) number++
    const nextQuestions = duplicate && questions.length ? questions.map(question => ({ ...question, id: crypto.randomUUID() })) : [newQuestion()]
    update({ variants: [...variants, { id, title: `Варіант ${number}`, questions: nextQuestions }] })
    setVariantId(id)
  }
  const changeQuestion = (id: string, fields: Partial<TeachingTestQuestion>) => setQuestions(current => current.map(question => question.id === id ? { ...question, ...fields } : question))
  const changeImageBusy = (id: string, pending: boolean) => setUploadingQuestions(current => pending
    ? current.includes(id) ? current : [...current, id]
    : current.filter(questionId => questionId !== id))
  const moveQuestion = (index: number, direction: number) => {
    setQuestions(current => {
      const reordered = [...current]
      ;[reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]]
      return reordered
    })
  }
  async function save(status: TeachingTest['status']) {
    if (lock.current || uploadingImage || !alive.current || scope.current !== renderScope || initialScope.current !== renderScope) return
    lock.current = true; setBusy(true); setError('')
    try {
      const opens = kyivDeadline(opensAt), closes = kyivDeadline(closesAt)
      if (!opens || !closes || new Date(closes).getTime() <= new Date(opens).getTime()) throw new Error('Вкажіть початок і завершення доступу до тесту.')
      if (!test.title.trim() || !test.targets.length || !test.questions.length) throw new Error('Додайте назву, отримувачів і хоча б одне запитання.')
      const variantTitles = ['Варіант 1', ...variants.map(variant => variant.title.trim())]
      for (const [index, set] of questionSets.entries()) {
        const title = variantTitles[index]
        if (!title) throw new Error(`Вкажіть назву варіанта ${index + 1}.`)
        if (!set.length) throw new Error(`Додайте хоча б одне запитання до набору «${title}».`)
        const questionFailure = set.map(questionValidationMessage).find(Boolean)
        if (questionFailure) throw new Error(variants.length ? `«${title}». ${questionFailure}` : questionFailure)
      }
      if (test.draw_count != null && (!Number.isInteger(test.draw_count) || test.draw_count < 1 || test.draw_count > smallestSet)) throw new Error('Кількість запитань для видачі має бути від 1 до кількості запитань у найменшому наборі.')
      if (test.draw_count == null && questionSets.some(set => set.length !== test.questions.length)) throw new Error('У наборах різна кількість запитань. Вкажіть, скільки запитань випадково видати студенту, або вирівняйте кількість у всіх наборах.')
      const allowedGroups = new Set(test.targets.map(target => target.group_id))
      const result = await repository.mutate('save_test', { ...test, variants: variants.map(variant => ({ ...variant, title: variant.title.trim() })), overrides: (test.overrides || []).filter(override => allowedGroups.has(override.group_id)), expected_user_id: userId, opens_at: opens, closes_at: closes, status, question_count: test.draw_count || test.questions.length })
      if (alive.current && scope.current === renderScope) onSaved(result)
    } catch (failure) { if (alive.current && scope.current === renderScope) setError(failure instanceof Error && !failure.message.startsWith('TEST_') ? failure.message : teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current && scope.current === renderScope) setBusy(false) }
  }
  function submit(event: FormEvent) { event.preventDefault(); void save('draft') }
  if (initialScope.current !== renderScope) return <TeachingModal title="Редагування призупинено" onClose={onClose}><p className="teaching-note">Акаунт або предмет змінився. Закрийте це вікно й повторно відкрийте потрібний тест.</p></TeachingModal>
  return <TeachingModal wide guide={{ topic: 'test-editor', label: 'Конструктор тесту' }} title={initial ? 'Редагування тесту' : 'Новий тест'} description={snapshot.course.title} onClose={onClose} busy={busy || uploadingImage}>
    <form className="teaching-form" onSubmit={submit}>
      {error && <p className="teaching-error" role="alert">{error}</p>}
      <section className="teaching-note" data-teaching-guide="test-editor-import"><div className="teaching-test-heading"><div><strong>Уже маєте готові запитання? <TeachingSectionHelp topic="test-editor" step="import" label="Імпорт у конструкторі" iconOnly /></strong><p>Додайте документ, таблицю або текст до поточного варіанта. Для складного тексту чи фото можна окремо увімкнути розпізнавання з ШІ.</p></div><TeachingButton disabled={busy || uploadingImage || test.has_attempts} onClick={() => setImportOpen(true)}><Upload size={16} />Імпортувати запитання з файлу</TeachingButton></div></section>
      <fieldset disabled={busy || uploadingImage} className="teaching-form">
        <section className="teaching-test-section" data-teaching-guide="test-editor-details"><h3>Про роботу <TeachingSectionHelp topic="test-editor" step="details" label="Назва, бали та журнал" iconOnly /></h3>
          <TeachingField label="Назва тесту"><input required maxLength={180} className={teachingInput} value={test.title} placeholder="Наприклад, контрольна з теми «Попит і пропозиція»" onChange={event => update({ title: event.target.value })} /></TeachingField>
          <TeachingField label="Пояснення для студентів"><textarea rows={3} maxLength={10000} className={teachingInput} value={test.description} onChange={event => update({ description: event.target.value })} /></TeachingField>
          <div className="teaching-test-grid"><TeachingField label="Максимальний результат" hint="Вага запитань перераховується в цей максимум. Підсумок разом із бонусом також ним обмежений."><input required type="number" min="0.01" max="10000" step="0.01" className={teachingInput} value={test.max_points} onChange={event => update({ max_points: Number(event.target.value) })} /></TeachingField>
            {!qa && <TeachingField label="Категорія в журналі"><select className={teachingInput} value={test.category} onChange={event => update({ category: event.target.value })}><option value="">Без категорії</option>{snapshot.course.grading_rules.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></TeachingField>}</div>
          {!qa && <div className="teaching-test-grid"><TeachingField label="Дата роботи в журналі" hint="Окрема дата для колонки цього тесту в журналі балів."><input required type="date" className={teachingInput} value={test.journal_date || localDeadline(test.opens_at).slice(0, 10)} onChange={event => update({ journal_date: event.target.value })} /></TeachingField><TeachingWorkTypeField value={test.work_type || 'Тест'} onChange={work_type => update({ work_type })} /></div>}
        </section>
        <section data-teaching-guide="test-editor-targets" className="teaching-test-section"><h3>Групи й підгрупи <TeachingSectionHelp topic="test-editor" step="targets" label="Отримувачі тесту" iconOnly /></h3><p>{qa ? 'Автор зможе скласти цей тест у групі «ооо 1».' : 'Тест побачать лише вибрані отримувачі. Кожен студент матиме одну особисту спробу.'}</p>
          <div className="teaching-test-targets">{groups.map(group => {
            const target = test.targets.find(target => target.group_id === group.group_id)
            return <div className="teaching-test-target" key={group.group_id}><label><input type="checkbox" checked={Boolean(target)} disabled={qa} onChange={event => update({ targets: event.target.checked ? [...test.targets, { group_id: group.group_id, audience_mode: 'all', subgroup_ids: [] }] : test.targets.filter(target => target.group_id !== group.group_id) })} /><span>{group.group_name}</span></label>
              {target && !qa && <TeachingAudienceFields repository={teachingRepository} courseId={snapshot.course.id} groupId={group.group_id} allowTeams={false} value={target} onChange={audience => update({ targets: test.targets.map(target => target.group_id === group.group_id ? { group_id: audience.group_id, audience_mode: audience.audience_mode === 'subgroups' ? 'subgroups' : 'all', subgroup_ids: audience.subgroup_ids || [] } : target) })} />}</div>
          })}</div>
          {(canConfigureQa || qa) && <div className="teaching-note">
            <label className="teaching-check"><input type="checkbox" checked={qa} disabled={!canConfigureQa || initial?.qa_own_attempt === true}
              onChange={event => update(event.target.checked ? { qa_own_attempt: true, overrides: [], bonus_percent: 0, bonus_points: 0 } : { qa_own_attempt: false })} />
              Тестовий режим · власна спроба в «ооо 1»
            </label>
            <p>Тест доступний лише автору. Спроба зберігається, а тестовий бал публікується окремо від журналу.</p>
          </div>}
        </section>
        <section data-teaching-guide="test-editor-rules" className="teaching-test-section"><h3>Час і правила проходження <TeachingSectionHelp topic="test-editor" step="rules" label="Таймери та правила тесту" iconOnly /></h3>
          <div className="teaching-test-grid"><TeachingField label="Відкрити тест" hint="Дата й час за Києвом."><input required type="datetime-local" className={teachingInput} value={opensAt} onChange={event => { setConfirmPublish(false); setOpensAt(event.target.value) }} /></TeachingField><TeachingField label="Закрити тест" hint="У цей час активні спроби теж завершуються."><input required type="datetime-local" className={teachingInput} value={closesAt} min={opensAt} onChange={event => { setConfirmPublish(false); setClosesAt(event.target.value) }} /></TeachingField>
            <TeachingField label="На весь тест, хвилин"><input required type="number" min="1" max="1440" step="1" className={teachingInput} value={test.duration_seconds / 60} onChange={event => update({ duration_seconds: Number(event.target.value) * 60 })} /></TeachingField>
            <TeachingField label="Коли студент залишає запитання"><select className={teachingInput} value={test.question_timer_policy} onChange={event => update({ question_timer_policy: event.target.value as TeachingTest['question_timer_policy'] })}><option value="continue">Таймер продовжується, повернення за правилами</option><option value="lock_on_leave">Зафіксувати відповідь одразу після переходу</option></select></TeachingField></div>
          <label className="teaching-check"><input type="checkbox" checked={test.allow_skip} onChange={event => update({ allow_skip: event.target.checked })} />Дозволити пропускати запитання</label>
          <label className="teaching-check"><input type="checkbox" checked={test.allow_return} onChange={event => update({ allow_return: event.target.checked })} />Дозволити повертатися до попередніх запитань</label>
          <label className="teaching-check"><input type="checkbox" checked={test.restrict_copy} onChange={event => update({ restrict_copy: event.target.checked })} />Обмежити виділення й копіювання тексту завдань</label>
          <TeachingTestIntegritySettings test={test} onChange={update} />
          <p>Копіювання через інтерфейс буде обмежено. Фото екрана та скриншоти повністю заблокувати неможливо. Час кожного запитання налаштовується нижче.</p>
        </section>
        {!qa && <section className="teaching-test-section" data-teaching-guide="test-editor-bonus"><h3>Бонус за результат і швидкість <TeachingSectionHelp topic="test-editor" step="bonus" label="Бонус за тест" iconOnly /></h3><p>Спочатку порівнюється правильність, за однакового результату враховується швидкість. Бонус визначається після завершення доступу до тесту. Кількість призових місць округлюється вгору.</p>
          <div className="teaching-test-grid"><TeachingField label="Хто отримує бонус"><select className={teachingInput} value={test.bonus_percent} onChange={event => update({ bonus_percent: Number(event.target.value) as TeachingTest['bonus_percent'] })}><option value="0">Без бонусу</option><option value="10">Найкращі 10%</option><option value="20">Найкращі 20%</option></select></TeachingField><TeachingField label="Додаткових балів" hint={`Разом можна отримати щонайбільше ${test.max_points} балів.`}><input type="number" min="0" max={test.max_points} step="0.01" className={teachingInput} value={test.bonus_points} disabled={!test.bonus_percent} onChange={event => update({ bonus_points: Number(event.target.value) })} /></TeachingField></div>
        </section>}
        <section data-teaching-guide="test-editor-variants" className="teaching-test-section">
          <h3>Варіанти тесту <TeachingSectionHelp topic="test-editor" step="variant" label="Варіанти й випадкові запитання" iconOnly /></h3>
          <p>Студент випадково отримує один із підготовлених варіантів на початку спроби. Після оновлення сторінки його набір запитань залишиться тим самим. Для всіх варіантів діє спільний максимальний бал.</p>
          <label className="teaching-check"><input type="checkbox" checked={Boolean(test.shuffle_questions)} onChange={event => update({ shuffle_questions: event.target.checked })} />Перемішувати запитання</label>
          <label className="teaching-check"><input type="checkbox" checked={Boolean(test.shuffle_answers)} onChange={event => update({ shuffle_answers: event.target.checked })} />Перемішувати варіанти відповідей</label>
          <TeachingField label="Випадково видати запитань кожному студенту" hint={`У найменшому наборі ${smallestSet}. Якщо поле порожнє, усі набори мають містити однакову кількість запитань.`}><input className={teachingInput} type="number" min="1" max={Math.max(1, smallestSet)} step="1" value={test.draw_count ?? ''} onChange={event => update({ draw_count: event.target.value ? Number(event.target.value) : null })} /></TeachingField>
          {Boolean(test.draw_count) && <p>Кожен студент отримає {test.draw_count} випадкових запитань зі свого набору.</p>}
        </section>
        {!qa && <section className="teaching-test-section" data-teaching-guide="test-individual-access"><h3>Допуск та індивідуальні умови <TeachingSectionHelp topic="test-admission" step="individual" label="Особистий допуск" iconOnly /></h3><p>Усі отримувачі допущені за замовчуванням. За потреби забороніть початок тесту окремому студенту, задайте інше вікно доступу або більше часу. Це не додає його до групи й не відкриває чужі результати. Умови застосовуються під час першого початку тесту.</p><div className="teaching-override-add"><TeachingField label="Студент із вибраних груп"><select className={teachingInput} value={overrideStudent} onChange={event => setOverrideStudent(event.target.value)}><option value="">Оберіть студента</option>{snapshot.entries.filter(entry => entry.active && entry.user_id && test.targets.some(target => target.group_id === entry.group_id) && !(test.overrides || []).some(override => override.user_id === entry.user_id)).filter((entry, index, entries) => entries.findIndex(item => item.user_id === entry.user_id) === index).map(entry => <option key={entry.id} value={`${entry.user_id}:${entry.group_id}`}>{entry.full_name} · {groups.find(group => group.group_id === entry.group_id)?.group_name}</option>)}</select></TeachingField><TeachingButton disabled={!overrideStudent} onClick={() => { const [user_id, group_id] = overrideStudent.split(':'); if (!user_id || !group_id) return; update({ overrides: [...test.overrides || [], { user_id, group_id, opens_at: null, closes_at: null, duration_seconds: null, excluded: false, exclusion_reason: '' }] }); setOverrideStudent('') }}><Plus size={15} />Налаштувати студента</TeachingButton></div>
          {(test.overrides || []).filter(override => test.targets.some(target => target.group_id === override.group_id)).map((override, index) => { const changeOverride = (fields: Partial<typeof override>) => update({ overrides: test.overrides!.map(item => item.user_id === override.user_id && item.group_id === override.group_id ? { ...item, ...fields } : item) }); const entry = snapshot.entries.find(entry => entry.user_id === override.user_id && entry.group_id === override.group_id); return <div className="teaching-override" key={`${override.user_id}:${override.group_id}`}><div className="teaching-test-heading"><strong>{entry?.full_name || 'Студент групи'}</strong><button type="button" className="teaching-icon-button" aria-label={`${override.excluded ? 'Прибрати налаштування та відновити допуск' : 'Прибрати індивідуальні умови'} ${entry?.full_name || index + 1}`} title={override.excluded ? 'Прибрати налаштування та відновити допуск' : 'Повернути загальний час тесту'} onClick={() => update({ overrides: test.overrides!.filter(item => item !== override) })}><Trash2 size={15} /></button></div><label className="teaching-check"><input type="checkbox" checked={Boolean(override.excluded)} onChange={event => changeOverride({ excluded: event.target.checked, exclusion_reason: event.target.checked ? override.exclusion_reason || '' : '' })} />Не допускати до цього тесту</label>{override.excluded && <TeachingField label="Пояснення для студента" hint="Необов’язково. Інші студенти не побачать пояснення."><textarea className={teachingInput} rows={2} maxLength={500} value={override.exclusion_reason || ''} onChange={event => changeOverride({ exclusion_reason: event.target.value })} /></TeachingField>}<div className="teaching-test-grid"><TeachingField label="Відкрити за Києвом" hint="Порожньо: загальна дата тесту."><input type="datetime-local" className={teachingInput} value={override.opens_at ? localDeadline(override.opens_at) : ''} onChange={event => changeOverride({ opens_at: event.target.value ? kyivDeadline(event.target.value) : null })} /></TeachingField><TeachingField label="Закрити за Києвом" hint="Порожньо: загальна дата тесту."><input type="datetime-local" className={teachingInput} value={override.closes_at ? localDeadline(override.closes_at) : ''} onChange={event => changeOverride({ closes_at: event.target.value ? kyivDeadline(event.target.value) : null })} /></TeachingField><TeachingField label="На виконання, хвилин" hint="Порожньо: загальна тривалість тесту."><input type="number" min="1" max="1440" step="1" className={teachingInput} value={override.duration_seconds == null ? '' : override.duration_seconds / 60} onChange={event => changeOverride({ duration_seconds: event.target.value ? Number(event.target.value) * 60 : null })} /></TeachingField></div></div> })}
        </section>}
        <section className="teaching-test-section">
          <div className="teaching-test-heading"><div><h3>Набори запитань</h3><p>Створюйте варіанти з нуля або копіюйте поточний, щоб змінити окремі запитання.</p></div><div className="teaching-test-actions"><TeachingButton onClick={() => addVariant(false)}><Plus size={16} />Додати варіант</TeachingButton><TeachingButton onClick={() => addVariant(true)}>Копіювати варіант</TeachingButton></div></div>
          <div className="teaching-test-grid"><TeachingField label="Редагувати варіант"><select className={teachingInput} value={activeVariant?.id || ''} onChange={event => setVariantId(event.target.value)}><option value="">Варіант 1 · {test.questions.length} запитань</option>{variants.map((variant, index) => <option key={variant.id} value={variant.id}>{variant.title.trim() || `Варіант ${index + 2}`} · {variant.questions.length} запитань</option>)}</select></TeachingField>
            {activeVariant && <TeachingField label="Назва варіанта"><input className={teachingInput} maxLength={120} value={activeVariant.title} onChange={event => update({ variants: variants.map(variant => variant.id === activeVariant.id ? { ...variant, title: event.target.value } : variant) })} /></TeachingField>}</div>
          {activeVariant && <TeachingButton onClick={() => { update({ variants: variants.filter(variant => variant.id !== activeVariant.id) }); setVariantId('') }}><Trash2 size={15} />Прибрати цей варіант</TeachingButton>}
        </section>
        <div className="teaching-test-heading" data-teaching-guide="test-editor-questions"><div><h2>Запитання <TeachingSectionHelp topic="test-editor" step="questions" label="Типи запитань і фото" iconOnly /></h2><p>Імпорт і банк запитань додають матеріал до вибраного варіанта.</p></div><div className="teaching-test-actions"><span className="teaching-badge">У наборі {questions.length}</span><TeachingButton onClick={() => setImportOpen(true)}><Upload size={15} />Імпортувати</TeachingButton><TeachingButton onClick={() => setBankOpen(true)}><BookOpen size={15} />Додати з банку</TeachingButton></div></div>
        {questions.map((question, index) => <QuestionEditor key={question.id} question={question} index={index} count={questions.length} imageUpload={{ courseId: test.course_id, userId }} onImageBusyChange={pending => changeImageBusy(question.id, pending)} onChange={fields => changeQuestion(question.id, fields)} onMove={direction => moveQuestion(index, direction)} onDelete={() => setQuestions(current => current.filter(item => item.id !== question.id))} />)}
        <TeachingButton disabled={questions.length >= 100} onClick={() => { const question = newQuestion(); setQuestions(current => [...current, question]) }}><Plus size={16} />Додати запитання</TeachingButton>
      </fieldset>
      <details className="teaching-test-section">
        <summary className="cursor-pointer font-semibold">Що перевірити перед збереженням або публікацією</summary>
        <ol className="mt-3 grid list-decimal gap-2 pl-5 text-sm">
          <li>У кожному варіанті звірте умови, правильні відповіді, вагу та фото. Запитання з імпорту можна редагувати так само, як створені вручну.</li>
          <li>{qa ? 'Звірте групу «ооо 1», час доступу, таймер і правила переходу.' : 'Перевірте вибрані групи, час доступу, таймер, правила переходу, допуск і дату колонки в журналі.'}</li>
          <li>Для нового тесту натисніть «Зберегти чернетку», якщо хочете повернутися пізніше. Потім відкрийте збережений тест і спробуйте його кнопкою «Пройти пробно».</li>
          <li>{qa ? 'Опублікуйте тест для власної спроби. Тестовий бал буде доступний автору після перевірки й окремої публікації.' : 'Щоб відкрити тест студентам, натисніть «Опублікувати» і підтвердьте дію. Після першої спроби запитання та правила фіксуються. Бали публікуються окремо після перевірки робіт.'}</li>
        </ol>
      </details>
      {confirmPublish && <div className="teaching-test-confirm"><h4>{qa ? 'Опублікувати тест для власної спроби?' : 'Опублікувати тест для вибраних отримувачів?'}</h4><p>{qa ? 'Ви зможете скласти цей тест у «ооо 1». Результат зберігатиметься окремо від журналу.' : 'Перед початком студент побачить усі правила. Після першої спроби умови та запитання фіксуються. Результати спочатку перевіряє викладач.'}</p><div className="teaching-test-actions"><TeachingButton primary busy={busy} disabled={uploadingImage} onClick={() => void save('published')}>Так, опублікувати тест</TeachingButton><TeachingButton disabled={busy} onClick={() => setConfirmPublish(false)}>Повернутися до редагування</TeachingButton></div></div>}
      <div data-teaching-guide="test-editor-save" className="teaching-test-footer"><TeachingSectionHelp topic="test-editor" step="save" label="Збереження та пробний запуск" iconOnly /><p><ListChecks size={14} className="mr-1 inline" />{needsQaDraft ? 'Спочатку збережіть тестову чернетку. Щоб опублікувати тест, знову відкрийте її.' : 'Оцінки публікуються окремо після перевірки.'}</p><div className="teaching-test-actions"><TeachingButton disabled={busy || uploadingImage} onClick={onClose}>Скасувати</TeachingButton><TeachingButton type="submit" busy={busy} disabled={uploadingImage}>Зберегти чернетку</TeachingButton><TeachingButton primary disabled={busy || uploadingImage || needsQaDraft} onClick={() => { setError(''); setConfirmPublish(true) }}>Опублікувати</TeachingButton></div></div>
    </form>
    {importOpen && <TeachingModal wide guide={{ topic: 'test-import', label: 'Імпорт запитань' }} title="Імпорт запитань у цей тест" description={`Запитання додадуться до набору «${activeVariant?.title || 'Варіант 1'}». Наявні запитання збережуться.`} onClose={() => setImportOpen(false)} busy={importReading}><TeachingQuestionImportPanel key={`${snapshot.course.id}:${userId}:${variantId}`} ai={{ courseId: snapshot.course.id, userId }} destination="test" onBusyChange={setImportReading} onCancel={() => setImportOpen(false)} onConfirm={imported => {
      if (!alive.current || scope.current.userId !== userId || scope.current.courseId !== snapshot.course.id || scope.current.repository !== repository) throw new Error('Акаунт або предмет змінився. Відкрийте імпорт ще раз.')
      if (test.has_attempts || busy) throw new Error('Умови тесту вже не можна змінити. Оновіть дані.')
      const existing = questions.filter(question => question.text.trim() || question.options.some(option => option.text.trim()) || question.buckets.some(bucket => bucket.text.trim()) || question.images?.length)
      if (existing.length + imported.length > 100) throw new Error(`У варіанті вже ${existing.length} запитань. Разом можна додати щонайбільше 100.`)
      setQuestions(() => [...existing, ...imported]); setImportOpen(false)
    }} /></TeachingModal>}
    {bankOpen && <TeachingQuestionBank courseId={snapshot.course.id} userId={userId} onClose={() => setBankOpen(false)} onSelect={selected => { const existing = questions.filter(question => question.text.trim() || question.options.some(option => option.text.trim()) || question.buckets.some(bucket => bucket.text.trim()) || question.images?.length); if (existing.length + selected.length > 100) { setError('У варіанті може бути щонайбільше 100 запитань.'); setBankOpen(false); return } setQuestions(() => [...existing, ...selected]); setBankOpen(false) }} />}
  </TeachingModal>
}
