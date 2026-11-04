import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, BookOpen, Check, Download, Pencil, Plus, Search, Upload } from 'lucide-react'
import type { TeachingTestQuestion } from '../../lib/teachingTests'
import { teachingTestError } from '../../lib/teachingTests'
import { createSupabaseTeachingQuestionBankRepository, type TeachingQuestionBankEntry } from '../../lib/teachingQuestionBank'
import { importTeachingQuestions } from '../../lib/teachingQuestionImport'
import { newTeachingQuestion, questionValidationMessage, TeachingQuestionEditor, TEST_QUESTION_LABELS } from './TeachingQuestionEditor'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-assessment-phase1.css'

type Parsed = ReturnType<typeof importTeachingQuestions>
export function TeachingQuestionBank({ courseId, userId, onClose, onSelect }: { courseId: string; userId: string; onClose: () => void; onSelect?: (questions: TeachingTestQuestion[]) => void }) {
  const repository = useMemo(() => createSupabaseTeachingQuestionBankRepository(), [])
  const [entries, setEntries] = useState<TeachingQuestionBankEntry[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [query, setQuery] = useState(''), [categoryFilter, setCategoryFilter] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [editing, setEditing] = useState<TeachingQuestionBankEntry | null>(null), [draft, setDraft] = useState<TeachingTestQuestion | null>(null)
  const [category, setCategory] = useState(''), [tags, setTags] = useState(''), [archive, setArchive] = useState<TeachingQuestionBankEntry | null>(null)
  const [importing, setImporting] = useState(false), [format, setFormat] = useState<'gift' | 'moodle_xml'>('gift'), [source, setSource] = useState(''), [parsed, setParsed] = useState<Parsed | null>(null)
  const [filename, setFilename] = useState(''), [fileBusy, setFileBusy] = useState(false)
  const alive = useRef(true), lock = useRef(false)
  const scopeKey = `${courseId}:${userId}`, currentScope = useRef(scopeKey); currentScope.current = scopeKey
  useEffect(() => {
    alive.current = true
    const captured = scopeKey
    setEntries([]); setSelected([]); setDraft(null); setEditing(null); setLoading(true); setError('')
    void repository.list(courseId).then(data => { if (alive.current && currentScope.current === captured) setEntries(data.entries) }).catch(failure => { if (alive.current && currentScope.current === captured) setError(teachingTestError(failure)) }).finally(() => { if (alive.current && currentScope.current === captured) setLoading(false) })
    return () => { alive.current = false }
  }, [repository, courseId, scopeKey])
  const active = entries.filter(entry => !entry.archived_at)
  const categories = [...new Set(active.map(entry => entry.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'))
  const visible = active.filter(entry => (!categoryFilter || entry.category === categoryFilter) && (!query.trim() || `${entry.question.text} ${entry.category} ${entry.tags.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
  function edit(entry?: TeachingQuestionBankEntry) { setEditing(entry || null); setDraft(entry ? structuredClone(entry.question) : newTeachingQuestion()); setCategory(entry?.category || categoryFilter); setTags(entry?.tags.join(', ') || ''); setError(''); setImporting(false) }
  async function mutate(action: 'save_entry' | 'archive_entry' | 'import_entries', payload: Record<string, unknown>, success: string) {
    if (lock.current) return
    const captured = scopeKey
    lock.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const data = await repository.mutate(action, { ...payload, course_id: courseId, expected_user_id: userId })
      if (!alive.current || currentScope.current !== captured) return
      setEntries(data.entries); setDraft(null); setEditing(null); setArchive(null); setImporting(false); setParsed(null); setMessage(success)
    } catch (failure) { if (alive.current) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function saveQuestion() {
    if (!draft) return
    const failure = questionValidationMessage(draft)
    if (failure) { setError(failure); return }
    void mutate('save_entry', { id: editing?.id || crypto.randomUUID(), version: editing?.version || 0, question: draft, category: category.trim(), tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) }, 'Запитання збережено в банку. У вже створених тестах залишилися попередні копії.')
  }
  function parse() {
    try { setParsed(importTeachingQuestions(source, format)); setError('') }
    catch { setParsed(null); setError('Не вдалося прочитати файл. Перевірте формат і кодування UTF-8.') }
  }
  async function readFile(file?: File) {
    if (!file) return
    setError(''); setParsed(null)
    if (file.size > 2 * 1024 * 1024) { setError('Для імпорту оберіть текстовий файл до 2 МБ.'); return }
    setFileBusy(true)
    try { const text = await file.text(); if (!alive.current) return; const nextFormat = file.name.toLowerCase().endsWith('.xml') ? 'moodle_xml' : 'gift'; setFormat(nextFormat); setFilename(file.name); setSource(text); setParsed(importTeachingQuestions(text, nextFormat)) }
    catch { if (alive.current) setError('Не вдалося прочитати файл. Спробуйте вибрати його ще раз.') }
    finally { if (alive.current) setFileBusy(false) }
  }
  function attach() {
    const questions = active.filter(entry => selected.includes(entry.id)).map(entry => ({ ...structuredClone(entry.question), id: crypto.randomUUID(), source_bank_id: entry.id, source_bank_version: entry.version }))
    if (questions.length) onSelect?.(questions)
  }
  return <TeachingModal wide title="Банк запитань" description="Один раз підготуйте запитання й використовуйте їх у різних тестах цього предмета." onClose={onClose} busy={busy || fileBusy}>
    <div className="teaching-tests">
      {error && <p className="teaching-error" role="alert">{error}</p>}{message && <p className="teaching-note" role="status">{message}</p>}
      {!draft && !importing && <><div className="teaching-test-heading"><div><span className="teaching-badge"><BookOpen size={14} />Запитань: {active.length}</span><p>Зміни в банку не змінюють уже створені тести та спроби студентів.</p></div><div className="teaching-test-actions"><TeachingButton onClick={() => { setImporting(true); setError(''); setMessage('') }}><Upload size={15} />Імпорт тесту</TeachingButton><TeachingButton primary onClick={() => edit()}><Plus size={15} />Нове запитання</TeachingButton></div></div>
        <div className="teaching-test-grid"><TeachingField label="Знайти запитання"><span className="teaching-bank-search"><Search size={16} /><input className={teachingInput} value={query} placeholder="Текст, тема або мітка" onChange={event => setQuery(event.target.value)} /></span></TeachingField><TeachingField label="Тема"><select className={teachingInput} value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}><option value="">Усі теми</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></TeachingField></div>
        {loading ? <p role="status">Завантажуємо банк запитань…</p> : visible.length ? <div className="teaching-bank-list">{visible.map(entry => <article className="teaching-bank-entry" key={entry.id} data-selected={selected.includes(entry.id)}>{onSelect && <label className="teaching-bank-selection"><input type="checkbox" aria-label={`Додати до тесту: ${entry.question.text}`} checked={selected.includes(entry.id)} onChange={event => setSelected(value => event.target.checked ? [...value, entry.id] : value.filter(id => id !== entry.id))} /></label>}<div className="teaching-bank-content"><div className="teaching-test-meta"><span>{TEST_QUESTION_LABELS[entry.question.kind]}</span><span>Бали: {entry.question.points}</span>{entry.category && <span>{entry.category}</span>}</div><p className="teaching-bank-question">{entry.question.text}</p>{entry.tags.length > 0 && <p className="teaching-bank-tags">{entry.tags.map(tag => `#${tag}`).join(' · ')}</p>}<small>Версія {entry.version}</small></div><div className="teaching-bank-entry-actions"><button type="button" className="teaching-icon-button" aria-label={`Редагувати запитання: ${entry.question.text}`} onClick={() => edit(entry)}><Pencil size={16} /></button><button type="button" className="teaching-icon-button" aria-label={`Архівувати запитання: ${entry.question.text}`} onClick={() => setArchive(entry)}><Archive size={16} /></button></div></article>)}</div> : <TeachingEmpty icon={<BookOpen size={26} />} title={active.length ? 'За цим пошуком нічого не знайдено' : 'Банк запитань поки порожній'} description="Додайте власні запитання або імпортуйте готовий тест у форматі GIFT чи Moodle XML." />}
        {archive && <div className="teaching-test-confirm"><h4>Прибрати запитання з банку?</h4><p>{archive.question.text}</p><p>Попередні тести та відповіді студентів залишаться без змін.</p><div className="teaching-test-actions"><TeachingButton busy={busy} onClick={() => void mutate('archive_entry', { id: archive.id, version: archive.version }, 'Запитання переміщено в архів.')}>Так, архівувати</TeachingButton><TeachingButton onClick={() => setArchive(null)}>Скасувати</TeachingButton></div></div>}
        {onSelect && <div className="teaching-test-footer"><p>Вибрано {selected.filter(id => active.some(entry => entry.id === id)).length}. У тест додаються окремі копії запитань.</p><TeachingButton primary disabled={!selected.some(id => active.some(entry => entry.id === id))} onClick={attach}><Check size={15} />Додати вибрані до тесту</TeachingButton></div>}
      </>}
      {draft && <><div className="teaching-test-grid"><TeachingField label="Тема або розділ"><input maxLength={120} className={teachingInput} value={category} onChange={event => setCategory(event.target.value)} placeholder="Наприклад, Попит і пропозиція" /></TeachingField><TeachingField label="Мітки через кому"><input maxLength={500} className={teachingInput} value={tags} onChange={event => setTags(event.target.value)} placeholder="економіка, модуль 1" /></TeachingField></div><fieldset disabled={busy}><TeachingQuestionEditor compact question={draft} onChange={fields => setDraft(value => value ? { ...value, ...fields } : value)} /></fieldset><div className="teaching-test-footer"><TeachingButton disabled={busy} onClick={() => { setDraft(null); setEditing(null); setError('') }}>Назад до банку</TeachingButton><TeachingButton primary busy={busy} onClick={saveQuestion}>Зберегти запитання</TeachingButton></div></>}
      {importing && <><section className="teaching-test-section"><h3>Імпорт готового тесту</h3><p>Спочатку перевірте запитання. До натискання «Імпортувати» банк не змінюється. Підтримуються текстові GIFT та Moodle XML; зображення й вкладення з файлів не завантажуються.</p><div className="teaching-test-grid"><TeachingField label="Формат"><select className={teachingInput} value={format} onChange={event => { setFormat(event.target.value as typeof format); setParsed(null) }}><option value="gift">GIFT (.gift, .txt)</option><option value="moodle_xml">Moodle XML (.xml)</option></select></TeachingField><TeachingField label="Файл до 2 МБ"><input className={teachingInput} type="file" accept=".gift,.txt,.xml,text/plain,application/xml,text/xml" disabled={fileBusy || busy} onChange={event => void readFile(event.target.files?.[0])} /></TeachingField></div>{filename && <p>{filename}</p>}<TeachingField label="Або вставте вміст файлу"><textarea rows={7} maxLength={2 * 1024 * 1024} className={teachingInput} value={source} onChange={event => { setSource(event.target.value); setParsed(null) }} spellCheck={false} /></TeachingField><TeachingButton disabled={!source.trim() || fileBusy} onClick={parse}><Search size={15} />Перевірити й показати запитання</TeachingButton></section>
        {parsed && <section className="teaching-test-section"><h3>Попередній перегляд · запитань: {parsed.questions.length}</h3><p>Звірте умови, варіанти відповідей та правила оцінювання перед додаванням до банку.</p>{parsed.issues.length > 0 && <div className="teaching-error" role="alert"><p>Перед імпортом виправте ці пункти у файлі:</p><ul>{parsed.issues.map((issue, index) => <li key={index}>{issue.line ? `Рядок ${issue.line}: ` : ''}{issue.question ? `${issue.question}: ` : ''}{issue.message}</li>)}</ul></div>}<div className="teaching-bank-list">{parsed.questions.map((question, index) => <article className="teaching-bank-entry" key={`${question.id}:${index}`}><div className="teaching-bank-content"><span className="teaching-badge">{index + 1} · {TEST_QUESTION_LABELS[question.kind]}</span><p className="teaching-bank-question">{question.text}</p><small>Бали: {question.points}</small><ImportedQuestionAnswers question={question} /></div></article>)}</div><TeachingField label="Тема для імпортованих запитань"><input maxLength={120} className={teachingInput} value={category} onChange={event => setCategory(event.target.value)} /></TeachingField><TeachingButton primary busy={busy} disabled={!parsed.questions.length || parsed.questions.length > 100 || parsed.issues.length > 0} onClick={() => void mutate('import_entries', { entries: parsed.questions.map(question => ({ id: crypto.randomUUID(), version: 0, category: category.trim(), tags: [], question })) }, `Імпорт завершено. Запитань: ${parsed.questions.length}. Тепер їх можна додати до тесту.`)}><Download size={15} />Імпортувати в банк</TeachingButton>{parsed.questions.length > 100 && <p className="teaching-error">Один імпорт може містити щонайбільше 100 запитань. Розділіть файл на частини.</p>}</section>}
        <TeachingButton disabled={busy} onClick={() => { setImporting(false); setParsed(null); setError('') }}>Назад до банку</TeachingButton>
      </>}
    </div>
  </TeachingModal>
}

function ImportedQuestionAnswers({ question }: { question: TeachingTestQuestion }) {
  if (question.kind === 'essay') return <p className="teaching-bank-import-answer">Ручна перевірка викладачем. Автоматичної правильної відповіді немає.</p>
  if (['choice', 'multiple', 'boolean'].includes(question.kind)) {
    const correct = Array.isArray(question.answer) ? question.answer : [question.answer]
    return <div className="teaching-bank-import-answer"><strong>Варіанти відповідей</strong><ul>{question.options.map(option => <li key={option.id} data-correct={correct.includes(option.id)}><span>{option.text}</span>{correct.includes(option.id) && <span className="teaching-bank-correct"><Check size={13} aria-hidden="true" />Правильна відповідь</span>}</li>)}</ul>{question.kind === 'multiple' && <p>{question.partial_credit ? 'Часткові бали ввімкнено; зайві варіанти зменшують результат.' : 'Повний бал лише за весь правильний набір без зайвих варіантів.'}</p>}</div>
  }
  if (question.kind === 'short_text') return <div className="teaching-bank-import-answer"><strong>Допустимі відповіді</strong><ul>{(Array.isArray(question.answer) ? question.answer : []).map((answer, index) => <li key={index}>{answer}</li>)}</ul><p>{question.case_sensitive ? 'Великі й малі літери враховуються.' : 'Великі й малі літери не враховуються.'}</p></div>
  if (question.kind === 'numerical') return <dl className="teaching-bank-import-answer"><div><dt>Правильне число</dt><dd>{typeof question.answer === 'string' ? question.answer : 'Не вказано'}</dd></div><div><dt>Абсолютна похибка</dt><dd>±{question.tolerance ?? 0}</dd></div></dl>
  if (question.kind === 'sorting') {
    const answers = question.answer && typeof question.answer === 'object' && !Array.isArray(question.answer) ? question.answer : {}
    return <div className="teaching-bank-import-answer"><strong>Правильне розміщення</strong><ul>{question.options.map(option => <li key={option.id}>{option.text} → {question.buckets.find(bucket => bucket.id === answers[option.id])?.text || 'Не вказано'}</li>)}</ul><p>{question.partial_credit ? 'За правильні елементи нараховується частина балів.' : 'Бал нараховується за повністю правильну відповідь.'}</p></div>
  }
  if (question.kind === 'sequence') return <div className="teaching-bank-import-answer"><strong>Правильна послідовність</strong><ol>{(Array.isArray(question.answer) ? question.answer : []).map(id => <li key={id}>{question.options.find(option => option.id === id)?.text || id}</li>)}</ol></div>
  if (question.kind === 'cloze') return <div className="teaching-bank-import-answer"><strong>Пропуски та допустимі відповіді</strong><dl>{question.gaps?.map(gap => <div key={gap.id}><dt>{`{{${gap.id}}}`}</dt><dd>{gap.answers.join(' / ')}</dd></div>)}</dl><p>{question.partial_credit ? 'За правильно заповнені пропуски нараховується частина балів.' : 'Бал нараховується за всі правильно заповнені пропуски.'}</p></div>
  if (question.kind === 'calculated') return <div className="teaching-bank-import-answer"><strong>Формула відповіді</strong><p>{question.calculation?.formula}</p><ul>{question.calculation?.variables.map(variable => <li key={variable.name}>{variable.name}: від {variable.min} до {variable.max}, крок {variable.step}</li>)}</ul><p>Абсолютна похибка: ±{question.tolerance ?? 0}</p></div>
  return null
}
