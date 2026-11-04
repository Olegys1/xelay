import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Check, ClipboardPaste, FileText, FolderOpen, Plus, ShieldCheck, Trash2, Upload, Download } from 'lucide-react'
import type { TeachingTestQuestion } from '../../lib/teachingTests'
import type { TeachingQuestionImportResult } from '../../lib/teachingQuestionImport'
import { importTeachingQuestionsEasy, validateEasyImportedQuestion, QUESTION_IMPORT_MAX_TEXT, QUESTION_IMPORT_TEXT_TEMPLATE, QUESTION_IMPORT_TABLE_TEMPLATE, type TeachingEasyImportFormat } from '../../lib/teachingQuestionImportText'
import { extractTeachingQuestionFile, QUESTION_IMPORT_ACCEPT, QUESTION_IMPORT_MAX_FILE_BYTES, QUESTION_IMPORT_MAX_BATCH_BYTES, QUESTION_IMPORT_MAX_FILES } from '../../lib/teachingQuestionImportFiles'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'
import { TeachingQuestionEditor, TEST_QUESTION_LABELS } from './TeachingQuestionEditor'
import './teaching-question-import.css'

type Source = { id: string; name: string; text: string; format: TeachingEasyImportFormat; notes: string[]; result: TeachingQuestionImportResult | null; fileBytes?: number; extractionError?: string }
const formats: { value: TeachingEasyImportFormat; label: string }[] = [{ value: 'auto', label: 'Визначити автоматично' }, { value: 'plain', label: 'Звичайний текст / AIKEN' }, { value: 'table', label: 'Таблиця CSV / TSV' }, { value: 'gift', label: 'Moodle GIFT' }, { value: 'moodle_xml', label: 'Moodle XML' }]
function downloadTemplate(kind: 'text' | 'table') {
  const text = kind === 'text' ? QUESTION_IMPORT_TEXT_TEMPLATE : QUESTION_IMPORT_TABLE_TEMPLATE
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: kind === 'text' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = kind === 'text' ? 'Xelay-test-template.txt' : 'Xelay-test-template.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
const answerLabel = (question: TeachingTestQuestion) => {
  if (question.kind === 'essay') return 'Відкрита відповідь. Перевіряє викладач.'
  if (question.kind === 'short_text') return `Відповіді: ${(question.answer as string[]).join(' / ')}`
  if (question.kind === 'numerical') return `Правильне число: ${question.answer}; похибка: ±${question.tolerance ?? 0}`
  if (question.kind === 'sorting') return 'Розміщення кожного елемента показано в редакторі.'
  if (question.kind === 'cloze') return 'Допустимі відповіді для пропусків показано в редакторі.'
  if (question.kind === 'calculated') return 'Формулу та змінні показано в редакторі.'
  const answers = Array.isArray(question.answer) ? question.answer : [question.answer]
  return `${question.kind === 'sequence' ? 'Порядок' : 'Правильно'}: ${answers.map(id => question.options.find(option => option.id === id)?.text || 'Не вказано').join(' → ')}`
}
export function TeachingQuestionImportPanel({ busy = false, onConfirm, onCancel, onBusyChange, destination = 'bank' }: {
  busy?: boolean; destination?: 'bank' | 'test'; onConfirm: (questions: TeachingTestQuestion[], category: string) => void | Promise<void>; onCancel: () => void; onBusyChange?: (busy: boolean) => void
}) {
  const [sources, setSources] = useState<Source[]>([]), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(''), [category, setCategory] = useState(''), [confirmed, setConfirmed] = useState(false)
  const picker = useRef<HTMLInputElement>(null), lock = useRef(false), alive = useRef(true), serial = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++ } }, [])
  useEffect(() => { onBusyChange?.(reading || confirming); return () => onBusyChange?.(false) }, [reading, confirming, onBusyChange])
  const totalBytes = sources.reduce((sum, source) => sum + new TextEncoder().encode(source.text).length, 0)
  const questions = sources.flatMap(source => source.result?.questions || [])
  const issues = sources.flatMap(source => source.extractionError ? [{ source: source.name, message: source.extractionError }] : source.result?.issues.map(issue => ({ source: source.name, message: `${issue.line ? `Рядок ${issue.line}. ` : ''}${issue.question ? `${issue.question}: ` : ''}${issue.message}` })) || [])
  const pending = sources.some(source => source.result === null && !source.extractionError)
  const editedInvalid = questions.map(validateEasyImportedQuestion).filter((value): value is string => Boolean(value))
  const blocked = busy || reading || confirming
  const canConfirm = !blocked && confirmed && !pending && !issues.length && !editedInvalid.length && questions.length > 0 && questions.length <= 100
  function update(id: string, fields: Partial<Source>) {
    if (fields.text !== undefined) {
      const bytes = new TextEncoder().encode(fields.text).length
      if (bytes > QUESTION_IMPORT_MAX_TEXT || totalBytes - new TextEncoder().encode(sources.find(source => source.id === id)?.text || '').length + bytes > 4 * 1024 * 1024) { setError('До 2 МБ тексту на джерело і до 4 МБ на весь імпорт.'); return }
    }
    setConfirmed(false); setSources(value => value.map(source => source.id === id ? { ...source, ...fields } : source))
  }
  function addText(text = '', name = 'Вставлений текст') {
    if (sources.length >= QUESTION_IMPORT_MAX_FILES) { setError('За один раз можна додати до 10 файлів або текстових блоків.'); return }
    if (new TextEncoder().encode(text).length > QUESTION_IMPORT_MAX_TEXT || totalBytes + new TextEncoder().encode(text).length > 4 * 1024 * 1024) { setError('За один раз вставляйте до 2 МБ тексту.'); return }
    setError(''); setConfirmed(false)
    setSources(value => [...value, { id: crypto.randomUUID(), name, text, format: 'auto', notes: [], result: text.trim() ? importTeachingQuestionsEasy(text) : null }])
  }
  async function files(selected: FileList | File[] | null) {
    if (!selected?.length || blocked || lock.current) return
    const list = Array.from(selected)
    if (sources.length + list.length > QUESTION_IMPORT_MAX_FILES) { setError('За один раз можна додати до 10 файлів або текстових блоків.'); return }
    if (list.reduce((sum, file) => sum + file.size, 0) + sources.reduce((sum, source) => sum + (source.fileBytes || 0), 0) > QUESTION_IMPORT_MAX_BATCH_BYTES || list.some(file => file.size > QUESTION_IMPORT_MAX_FILE_BYTES)) { setError('До 10 МБ на один файл і до 20 МБ на вибрані файли разом.'); return }
    lock.current = true; setReading(true); setError(''); setConfirmed(false)
    const run = ++serial.current, added: Source[] = []
    try {
      let extractedBytes = totalBytes
      for (const file of list) {
        const id = crypto.randomUUID()
        try {
          const extracted = await extractTeachingQuestionFile(file)
          extractedBytes += new TextEncoder().encode(extracted.text).length
          if (extractedBytes > 4 * 1024 * 1024) throw new Error('Сумарний витягнутий текст перевищує 4 МБ. Імпортуйте менше файлів за один раз.')
          added.push({ id, ...extracted, fileBytes: file.size, result: importTeachingQuestionsEasy(extracted.text, extracted.format) })
        } catch (failure) { added.push({ id, name: file.name, fileBytes: file.size, text: '', format: 'auto', notes: [], result: null, extractionError: failure instanceof Error ? failure.message : 'Файл не вдалося прочитати. Збережіть текстову копію або вставте текст.' }) }
        if (!alive.current || serial.current !== run) return
      }
      if (alive.current && serial.current === run) setSources(value => [...value, ...added])
    } finally { lock.current = false; if (alive.current && serial.current === run) setReading(false); if (picker.current) picker.current.value = '' }
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    if (blocked) return
    if (event.clipboardData.files.length) { event.preventDefault(); void files(event.clipboardData.files); return }
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
    const text = event.clipboardData.getData('text/plain')
    if (text) { event.preventDefault(); addText(text) }
  }
  async function readClipboard() {
    if (blocked) return
    try { if (!navigator.clipboard?.readText) throw new Error(); const text = await navigator.clipboard.readText(); if (!text.trim()) { setError('Буфер порожній. Скопіюйте текст тесту, потім вставте його в поле.'); return } if (alive.current) addText(text) }
    catch { if (alive.current) { addText(); setError('Браузер не дозволив прочитати буфер. Натисніть у поле тексту й вставте через Ctrl+V або меню «Вставити».') } }
  }
  async function confirmImport() {
    if (!canConfirm || lock.current) return
    const run = ++serial.current
    lock.current = true; setConfirming(true); setError('')
    try {
      await onConfirm(questions.map(question => structuredClone(question)), destination === 'test' ? '' : category.trim())
    } catch (failure) {
      if (alive.current && serial.current === run) setError(failure instanceof Error ? failure.message : 'Не вдалося додати запитання. Перевірте дані та спробуйте ще раз.')
    } finally {
      if (serial.current === run) {
        lock.current = false
        if (alive.current) setConfirming(false)
      }
    }
  }
  return <div className="teaching-easy-import" onPaste={paste}>
    <header className="teaching-import-intro"><span className="teaching-badge"><Upload size={14} />Імпорт тесту</span><h3>Ваш готовий тест, без перенабирання</h3><p>Додайте файл або вставте текст. Xelay покаже запитання й правильні відповіді перед збереженням.</p><ol aria-label="Кроки імпорту"><li><span>1</span>Додайте матеріал</li><li><span>2</span>Перевірте запитання</li><li><span>3</span>Підтвердьте імпорт</li></ol></header>
    {error && <p className="teaching-error" role="alert">{error}</p>}
    <section className="teaching-import-drop" data-dragging={dragging} aria-label="Додати файли тесту" onDragOver={event => { event.preventDefault(); if (!blocked) setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); void files(event.dataTransfer.files) }}>
      <FolderOpen size={30} aria-hidden="true" /><h4>{reading ? 'Читаємо файли на вашому пристрої…' : 'Перетягніть сюди один або кілька файлів'}</h4><p>DOCX, текстовий PDF, XLSX, CSV, TSV, TXT, GIFT та Moodle XML</p><div className="teaching-test-actions"><TeachingButton primary disabled={blocked} onClick={() => picker.current?.click()}><Upload size={15} />Вибрати файли</TeachingButton><TeachingButton disabled={blocked} onClick={() => void readClipboard()}><ClipboardPaste size={15} />Вставити з буфера</TeachingButton><TeachingButton disabled={blocked} onClick={() => addText()}><Plus size={15} />Ввести текст</TeachingButton></div><input ref={picker} className="teaching-import-file-input" type="file" multiple accept={QUESTION_IMPORT_ACCEPT} aria-label="Оберіть файли тесту" disabled={blocked} onChange={event => void files(event.target.files)} /><p className="teaching-import-hint">До 10 файлів, по 10 МБ кожен, разом до 20 МБ. Можна також вставити файли через Ctrl+V, якщо браузер це підтримує.</p>
    </section>
    <p className="teaching-import-privacy"><ShieldCheck size={16} aria-hidden="true" />Файли читаються у вашому браузері. До підтвердження жодне запитання не зберігається; платне розпізнавання не використовується.</p>
    <div className="teaching-import-templates"><div><strong>Немає готового формату?</strong><p>Скопіюйте запитання з Word чи таблиці. Правильні відповіді мають бути вказані явно.</p></div><div className="teaching-test-actions"><TeachingButton disabled={blocked} onClick={() => downloadTemplate('text')}><Download size={14} />Шаблон TXT</TeachingButton><TeachingButton disabled={blocked} onClick={() => downloadTemplate('table')}><Download size={14} />Шаблон таблиці</TeachingButton><TeachingButton disabled={blocked} onClick={() => addText(QUESTION_IMPORT_TEXT_TEMPLATE, 'Приклад тесту')}>Спробувати приклад</TeachingButton></div></div>
    <details className="teaching-import-help"><summary>Як підготувати відповіді й що не переноситься автоматично</summary><p>Для звичайного тексту: умова, варіанти A), B), C), D), потім «Відповідь: A». Для кількох правильних: «Відповідь: A,C». Для відкритої відповіді вкажіть «Тип: есе». Можна додати «Бали: 2».</p><pre>{QUESTION_IMPORT_TEXT_TEMPLATE}</pre><p>У таблиці потрібні колонки «Запитання», A, B, C, D, «Відповідь», «Бали» і «Тип». Зайві варіанти можна залишити порожніми. Для числового питання додайте колонку «Похибка». Усі аркуші XLSX мають використовувати однакові заголовки.</p><p>Фото, скани, старі DOC/XLS, макроси, захищені документи і зовнішні зв’язки не розпізнаються. Збережіть текстовий DOCX/PDF або вставте текст. Правильна відповідь не визначається за кольором, жирним шрифтом чи припущенням. Формули, зображення й нестандартні ваги Moodle потребують ручної перевірки.</p></details>
    {sources.length > 0 && <section className="teaching-import-sources" aria-label="Додані джерела"><div className="teaching-test-heading"><h3>Додано джерел: {sources.length}</h3><p>Файли разом утворюють один імпорт до 100 запитань.</p></div>{sources.map(source => <article className="teaching-import-source" key={source.id}><header><div><FileText size={17} /><strong>{source.name}</strong><span>{source.result?.questions.length || 0} запитань</span></div><button type="button" className="teaching-icon-button" disabled={blocked} aria-label={`Прибрати джерело ${source.name}`} onClick={() => { setConfirmed(false); setSources(value => value.filter(item => item.id !== source.id)) }}><Trash2 size={16} /></button></header>{source.extractionError ? <p className="teaching-error">{source.extractionError}</p> : <><details open={source.result === null || Boolean(source.result?.issues.length)}><summary>Текст і формат джерела</summary><TeachingField label={`Формат: ${source.name}`}><select className={teachingInput} disabled={blocked} value={source.format} onChange={event => update(source.id, { format: event.target.value as TeachingEasyImportFormat, result: null })}>{formats.map(format => <option key={format.value} value={format.value}>{format.label}</option>)}</select></TeachingField><TeachingField label={`Текст: ${source.name}`}><textarea className={teachingInput} rows={8} maxLength={QUESTION_IMPORT_MAX_TEXT} value={source.text} disabled={blocked} onChange={event => update(source.id, { text: event.target.value, result: null })} spellCheck={false} /></TeachingField><TeachingButton disabled={blocked || !source.text.trim()} onClick={() => update(source.id, { result: importTeachingQuestionsEasy(source.text, source.format) })}>Оновити попередній перегляд</TeachingButton></details>{source.notes.map(note => <p className="teaching-import-hint" key={note}>{note}</p>)}</>}</article>)}</section>}
    {sources.length > 0 && <section className="teaching-import-preview" aria-label="Попередній перегляд імпорту"><div className="teaching-test-heading"><div><span className="teaching-badge">Крок 2</span><h3>Перевірте запитання · {questions.length}</h3></div></div>{pending && <p className="teaching-note" role="status">Текст або формат змінено. Оновіть попередній перегляд у відповідному джерелі.</p>}{issues.length > 0 && <div className="teaching-error" role="alert"><strong>Ці пункти потребують виправлення</strong><ul>{issues.map((item, index) => <li key={index}><b>{item.source}.</b> {item.message}</li>)}</ul><p>Виправте текст джерела й оновіть перегляд або приберіть непотрібне джерело. Проблемні запитання не додаються мовчки.</p></div>}{questions.length > 100 && <p className="teaching-error" role="alert">Знайдено більше 100 запитань. Приберіть частину джерел і імпортуйте їх окремо.</p>}{sources.map(source => source.result?.questions.map((question, index) => <details className="teaching-import-question" key={question.id}><summary><span className="teaching-import-question-number">{index + 1}</span><span><small>{TEST_QUESTION_LABELS[question.kind]} · {question.points} балів · {source.name}</small><strong>{question.text}</strong><em>{answerLabel(question)}</em></span><PencilLabel /></summary><div className="teaching-import-question-body"><fieldset disabled={blocked}><TeachingQuestionEditor compact question={question} onChange={fields => { setConfirmed(false); setSources(value => value.map(item => item.id === source.id && item.result ? { ...item, result: { ...item.result, questions: item.result.questions.map(current => current.id === question.id ? { ...current, ...fields } : current) } } : item)) }} /></fieldset>{validateEasyImportedQuestion(question) && <p className="teaching-error" role="alert">{validateEasyImportedQuestion(question)}</p>}</div></details>))}{questions.length > 0 && <div className="teaching-import-confirm"><span className="teaching-badge">Крок 3</span>{destination === 'bank' && <TeachingField label="Тема для цих запитань, необов’язково"><input maxLength={120} className={teachingInput} disabled={blocked} value={category} onChange={event => setCategory(event.target.value)} placeholder="Наприклад, Модуль 1" /></TeachingField>}<label className="teaching-check"><input type="checkbox" checked={confirmed} disabled={blocked || pending || Boolean(issues.length) || Boolean(editedInvalid.length) || questions.length > 100} onChange={event => setConfirmed(event.target.checked)} />Я перевірив умови, правильні відповіді та бали</label><p>{destination === 'test' ? `У редактор тесту буде додано ${questions.length} запитань. Потім перевірте налаштування й збережіть тест. Імпорт не публікує його автоматично.` : `До банку буде додано ${questions.length} запитань. Наявні тести, відповіді студентів та оцінки не змінюються. Після імпорту виберіть потрібні запитання для тесту.`}</p><TeachingButton primary busy={busy || confirming} disabled={!canConfirm} onClick={() => void confirmImport()}><Check size={16} />Підтвердити й додати {questions.length} запитань {destination === 'test' ? 'у тест' : 'у банк'}</TeachingButton></div>}</section>}
    <div className="teaching-test-footer"><TeachingButton disabled={blocked} onClick={onCancel}>{destination === 'test' ? 'Назад до редактора тесту' : 'Назад до банку'}</TeachingButton></div>
  </div>
}
function PencilLabel() { return <span className="teaching-import-edit-label">Перевірити / змінити</span> }
