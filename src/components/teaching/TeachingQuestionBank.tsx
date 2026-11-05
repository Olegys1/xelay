import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, BookOpen, Check, Pencil, Plus, Search, Upload } from 'lucide-react'
import type { TeachingTestQuestion } from '../../lib/teachingTests'
import { teachingTestError } from '../../lib/teachingTests'
import { createSupabaseTeachingQuestionBankRepository, type TeachingQuestionBankEntry, type TeachingQuestionBankRepository } from '../../lib/teachingQuestionBank'
import { TeachingQuestionImportPanel } from './TeachingQuestionImportPanel'
import { newTeachingQuestion, questionValidationMessage, TeachingQuestionEditor, TEST_QUESTION_LABELS } from './TeachingQuestionEditor'
import { TeachingButton, TeachingEmpty, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-assessment-phase1.css'

export function TeachingQuestionBank({ courseId, userId, onClose, onSelect, repository: suppliedRepository }: { courseId: string; userId: string; onClose: () => void; onSelect?: (questions: TeachingTestQuestion[]) => void; repository?: TeachingQuestionBankRepository }) {
  const repository = useMemo(() => suppliedRepository || createSupabaseTeachingQuestionBankRepository(), [suppliedRepository])
  const [entries, setEntries] = useState<TeachingQuestionBankEntry[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [query, setQuery] = useState(''), [categoryFilter, setCategoryFilter] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [editing, setEditing] = useState<TeachingQuestionBankEntry | null>(null), [draft, setDraft] = useState<TeachingTestQuestion | null>(null)
  const [category, setCategory] = useState(''), [tags, setTags] = useState(''), [archive, setArchive] = useState<TeachingQuestionBankEntry | null>(null)
  const [importing, setImporting] = useState(false), [fileBusy, setFileBusy] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const alive = useRef(true), lock = useRef(false)
  const scopeKey = `${courseId}:${userId}`, currentScope = useRef(scopeKey); currentScope.current = scopeKey
  useEffect(() => {
    alive.current = true
    const captured = scopeKey
    setEntries([]); setSelected([]); setDraft(null); setEditing(null); setImporting(false); setFileBusy(false); setImageBusy(false); setCategory(''); setTags(''); setLoading(true); setError('')
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
      setEntries(data.entries); setDraft(null); setEditing(null); setArchive(null); setImporting(false); setMessage(success)
    } catch (failure) { if (alive.current && currentScope.current === captured) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  function saveQuestion() {
    if (!draft || imageBusy) return
    const failure = questionValidationMessage(draft)
    if (failure) { setError(failure); return }
    void mutate('save_entry', { id: editing?.id || crypto.randomUUID(), version: editing?.version || 0, question: draft, category: category.trim(), tags: tags.split(',').map(tag => tag.trim()).filter(Boolean) }, 'Запитання збережено в банку. У вже створених тестах залишилися попередні копії.')
  }
  function attach() {
    const questions = active.filter(entry => selected.includes(entry.id)).map(entry => ({ ...structuredClone(entry.question), id: crypto.randomUUID(), source_bank_id: entry.id, source_bank_version: entry.version }))
    if (questions.length) onSelect?.(questions)
  }
  return <TeachingModal wide title="Банк запитань" description="Один раз підготуйте запитання й використовуйте їх у різних тестах цього предмета." onClose={onClose} busy={busy || fileBusy || imageBusy}>
    <div className="teaching-tests">
      {error && <p className="teaching-error" role="alert">{error}</p>}{message && <p className="teaching-note" role="status">{message}</p>}
      {!draft && !importing && <><div className="teaching-test-heading"><div><span className="teaching-badge"><BookOpen size={14} />Запитань: {active.length}</span><p>Зміни в банку не змінюють уже створені тести та спроби студентів.</p></div><div className="teaching-test-actions"><TeachingButton onClick={() => { setImporting(true); setError(''); setMessage('') }}><Upload size={15} />Імпорт тесту</TeachingButton><TeachingButton primary onClick={() => edit()}><Plus size={15} />Нове запитання</TeachingButton></div></div>
        <div className="teaching-test-grid"><TeachingField label="Знайти запитання"><span className="teaching-bank-search"><Search size={16} /><input className={teachingInput} value={query} placeholder="Текст, тема або мітка" onChange={event => setQuery(event.target.value)} /></span></TeachingField><TeachingField label="Тема"><select className={teachingInput} value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}><option value="">Усі теми</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></TeachingField></div>
        {loading ? <p role="status">Завантажуємо банк запитань…</p> : visible.length ? <div className="teaching-bank-list">{visible.map(entry => <article className="teaching-bank-entry" key={entry.id} data-selected={selected.includes(entry.id)}>{onSelect && <label className="teaching-bank-selection"><input type="checkbox" aria-label={`Додати до тесту: ${entry.question.text}`} checked={selected.includes(entry.id)} onChange={event => setSelected(value => event.target.checked ? [...value, entry.id] : value.filter(id => id !== entry.id))} /></label>}<div className="teaching-bank-content"><div className="teaching-test-meta"><span>{TEST_QUESTION_LABELS[entry.question.kind]}</span><span>Бали: {entry.question.points}</span>{entry.category && <span>{entry.category}</span>}</div><p className="teaching-bank-question">{entry.question.text}</p>{entry.tags.length > 0 && <p className="teaching-bank-tags">{entry.tags.map(tag => `#${tag}`).join(' · ')}</p>}<small>Версія {entry.version}</small></div><div className="teaching-bank-entry-actions"><button type="button" className="teaching-icon-button" aria-label={`Редагувати запитання: ${entry.question.text}`} onClick={() => edit(entry)}><Pencil size={16} /></button><button type="button" className="teaching-icon-button" aria-label={`Архівувати запитання: ${entry.question.text}`} onClick={() => setArchive(entry)}><Archive size={16} /></button></div></article>)}</div> : <TeachingEmpty icon={<BookOpen size={26} />} title={active.length ? 'За цим пошуком нічого не знайдено' : 'Банк запитань поки порожній'} description="Додайте власні запитання, перетягніть готовий файл або вставте текст тесту." />}
        {archive && <div className="teaching-test-confirm"><h4>Прибрати запитання з банку?</h4><p>{archive.question.text}</p><p>Попередні тести та відповіді студентів залишаться без змін.</p><div className="teaching-test-actions"><TeachingButton busy={busy} onClick={() => void mutate('archive_entry', { id: archive.id, version: archive.version }, 'Запитання переміщено в архів.')}>Так, архівувати</TeachingButton><TeachingButton onClick={() => setArchive(null)}>Скасувати</TeachingButton></div></div>}
        {onSelect && <div className="teaching-test-footer"><p>Вибрано {selected.filter(id => active.some(entry => entry.id === id)).length}. У тест додаються окремі копії запитань.</p><TeachingButton primary disabled={!selected.some(id => active.some(entry => entry.id === id))} onClick={attach}><Check size={15} />Додати вибрані до тесту</TeachingButton></div>}
      </>}
      {draft && <><div className="teaching-test-grid"><TeachingField label="Тема або розділ"><input maxLength={120} className={teachingInput} value={category} onChange={event => setCategory(event.target.value)} placeholder="Наприклад, Попит і пропозиція" /></TeachingField><TeachingField label="Мітки через кому"><input maxLength={500} className={teachingInput} value={tags} onChange={event => setTags(event.target.value)} placeholder="економіка, модуль 1" /></TeachingField></div><fieldset disabled={busy}><TeachingQuestionEditor compact question={draft}
        imageUpload={{ courseId, userId }} onImageBusyChange={setImageBusy}
        onChange={fields => setDraft(value => value ? { ...value, ...fields } : value)} /></fieldset><div className="teaching-test-footer"><TeachingButton disabled={busy || imageBusy} onClick={() => { setDraft(null); setEditing(null); setError('') }}>Назад до банку</TeachingButton><TeachingButton primary busy={busy} disabled={imageBusy} onClick={saveQuestion}>Зберегти запитання</TeachingButton></div></>}
      {importing && <TeachingQuestionImportPanel busy={busy} onBusyChange={setFileBusy} onCancel={() => { setImporting(false); setError('') }} onConfirm={(questions, importCategory) => mutate('import_entries', { entries: questions.map(question => ({ id: question.id, version: 0, category: importCategory, tags: [], question })) }, `Імпорт завершено. Запитань: ${questions.length}. Тепер їх можна додати до тесту.`)} />}
    </div>
  </TeachingModal>
}
