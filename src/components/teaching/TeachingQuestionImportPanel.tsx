import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Check, ClipboardPaste, FileText, FolderOpen, Plus, ShieldCheck, Sparkles, Trash2, Upload, Download } from 'lucide-react'
import type { TeachingTestQuestion } from '../../lib/teachingTests'
import type { TeachingQuestionImportResult } from '../../lib/teachingQuestionImport'
import type { TeachingQuestionAiScope } from '../../lib/teachingQuestionImportAi'
import { previewTeachingQuestionsEasy, validateEasyImportedQuestion, QUESTION_IMPORT_MAX_TEXT, QUESTION_IMPORT_TEXT_TEMPLATE, QUESTION_IMPORT_TABLE_TEMPLATE, type TeachingEasyImportFormat } from '../../lib/teachingQuestionImportText'
import { extractTeachingQuestionFile, QUESTION_IMPORT_ACCEPT, QUESTION_IMPORT_MAX_FILE_BYTES, QUESTION_IMPORT_MAX_BATCH_BYTES, QUESTION_IMPORT_MAX_FILES } from '../../lib/teachingQuestionImportFiles'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'
import { TeachingQuestionEditor, TEST_QUESTION_LABELS } from './TeachingQuestionEditor'
import './teaching-question-import.css'

type Source = { id: string; name: string; text: string; format: TeachingEasyImportFormat; notes: string[]; result: TeachingQuestionImportResult | null; fileBytes?: number; extractionError?: string; photo?: File; photoKey?: string; aiNotes?: string[]; beforeAi?: { text: string; format: TeachingEasyImportFormat; result: TeachingQuestionImportResult | null } }
const photoExtension = /\.(?:jpe?g|png|webp)$/i
const photoAccept = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'
const formats: { value: TeachingEasyImportFormat; label: string }[] = [{ value: 'auto', label: 'Визначити автоматично' }, { value: 'plain', label: 'Звичайний текст / AIKEN' }, { value: 'table', label: 'Таблиця CSV / TSV' }, { value: 'gift', label: 'Moodle GIFT' }, { value: 'moodle_xml', label: 'Moodle XML' }]
function downloadTemplate(kind: 'text' | 'table') {
  const text = kind === 'text' ? QUESTION_IMPORT_TEXT_TEMPLATE : QUESTION_IMPORT_TABLE_TEMPLATE
  const url = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: kind === 'text' ? 'text/plain;charset=utf-8' : 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = kind === 'text' ? 'Xelay-test-template.txt' : 'Xelay-test-template.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
}
const answerLabel = (question: TeachingTestQuestion) => {
  if (question.kind === 'essay') return 'Відкрита відповідь. Перевіряє викладач.'
  if (question.kind === 'sorting') return 'Розміщення кожного елемента показано в редакторі.'
  if (question.kind === 'cloze') return 'Допустимі відповіді для пропусків показано в редакторі.'
  if (question.kind === 'calculated') return 'Формулу та змінні показано в редакторі.'
  if (question.answer === undefined || Array.isArray(question.answer) && !question.answer.length) return 'Правильну відповідь ще не вказано'
  if (question.kind === 'short_text') return `Відповіді: ${(question.answer as string[]).join(' / ')}`
  if (question.kind === 'numerical') return `Правильне число: ${question.answer}; похибка: ±${question.tolerance ?? 0}`
  const answers = Array.isArray(question.answer) ? question.answer : [question.answer]
  return `${['sequence', 'sequence_select'].includes(question.kind) ? 'Порядок' : 'Правильно'}: ${answers.map(id => question.options.find(option => option.id === id)?.text || 'Не вказано').join(' → ')}`
}
export function TeachingQuestionImportPanel({ busy = false, onConfirm, onCancel, onBusyChange, destination = 'bank', ai }: {
  busy?: boolean; destination?: 'bank' | 'test'; onConfirm: (questions: TeachingTestQuestion[], category: string) => void | Promise<void>; onCancel: () => void; onBusyChange?: (busy: boolean) => void; ai?: TeachingQuestionAiScope
}) {
  const [sources, setSources] = useState<Source[]>([]), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(''), [category, setCategory] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [questionOpen, setQuestionOpen] = useState<Record<string, boolean>>({})
  const [aiTarget, setAiTarget] = useState(''), [aiConsent, setAiConsent] = useState(false), [aiBusy, setAiBusy] = useState(false)
  const aiAbort = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null), lock = useRef(false), alive = useRef(true), serial = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++; aiAbort.current?.abort() } }, [])
  useEffect(() => { onBusyChange?.(reading || confirming || aiBusy); return () => onBusyChange?.(false) }, [reading, confirming, aiBusy, onBusyChange])
  const totalBytes = sources.reduce((sum, source) => sum + new TextEncoder().encode(source.text).length, 0)
  const questions = sources.flatMap(source => source.result?.questions || [])
  const missingKeys = questions.filter(question => ['choice', 'boolean', 'multiple', 'sequence', 'sequence_select', 'short_text', 'numerical'].includes(question.kind) && (question.answer === undefined || Array.isArray(question.answer) && !question.answer.length)).length
  const issues = sources.flatMap(source => source.extractionError ? [{ source: source.name, message: source.extractionError }] : source.result?.issues.map(issue => ({ source: source.name, message: `${issue.line ? `Рядок ${issue.line}. ` : ''}${issue.question ? `${issue.question}: ` : ''}${issue.message}` })) || [])
  const pending = sources.some(source => source.result === null && !source.extractionError)
  const editedInvalid = questions.map(validateEasyImportedQuestion).filter((value): value is string => Boolean(value))
  const blocked = busy || reading || confirming || aiBusy
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
    setSources(value => [...value, { id: crypto.randomUUID(), name, text, format: 'auto', notes: [], result: text.trim() ? previewTeachingQuestionsEasy(text) : null }])
  }
  async function files(selected: FileList | File[] | null) {
    if (!selected?.length || blocked || lock.current) return
    const list = Array.from(selected)
    if (list.length > QUESTION_IMPORT_MAX_FILES) { setError('За один раз можна додати до 10 файлів або текстових блоків.'); return }
    if (list.some(file => file.size > QUESTION_IMPORT_MAX_FILE_BYTES)) { setError('До 10 МБ на один файл і до 20 МБ на вибрані файли разом.'); return }
    lock.current = true; setReading(true); setError(''); setConfirmed(false)
    const run = ++serial.current, added: Source[] = []
    try {
      const photoKeys = new Set(sources.map(source => source.photoKey))
      const distinct: { file: File; photoKey?: string }[] = []
      let fileBytes = sources.reduce((sum, source) => sum + (source.fileBytes || 0), 0)
      for (const file of list) {
        let photoKey: string | undefined
        if (ai && photoExtension.test(file.name)) {
          const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
          if (!alive.current || serial.current !== run) return
          photoKey = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
          if (photoKeys.has(photoKey)) continue
          photoKeys.add(photoKey)
        }
        distinct.push({ file, photoKey })
        fileBytes += file.size
        if (sources.length + distinct.length > QUESTION_IMPORT_MAX_FILES) { setError('За один раз можна додати до 10 файлів або текстових блоків.'); return }
        if (fileBytes > QUESTION_IMPORT_MAX_BATCH_BYTES) { setError('До 10 МБ на один файл і до 20 МБ на вибрані файли разом.'); return }
      }
      if (!distinct.length) { setError('Це фото вже додано до імпорту.'); return }
      let extractedBytes = totalBytes
      for (const { file, photoKey } of distinct) {
        const id = crypto.randomUUID()
        if (photoKey) {
          added.push({ id, name: file.name, fileBytes: file.size, text: '', format: 'plain', notes: [], result: null, photo: file, photoKey })
          continue
        }
        try {
          const extracted = await extractTeachingQuestionFile(file)
          extractedBytes += new TextEncoder().encode(extracted.text).length
          if (extractedBytes > 4 * 1024 * 1024) throw new Error('Сумарний витягнутий текст перевищує 4 МБ. Імпортуйте менше файлів за один раз.')
          added.push({ id, ...extracted, fileBytes: file.size, result: previewTeachingQuestionsEasy(extracted.text, extracted.format) })
        } catch (failure) { added.push({ id, name: file.name, fileBytes: file.size, text: '', format: 'auto', notes: [], result: null, extractionError: failure instanceof Error ? failure.message : 'Файл не вдалося прочитати. Збережіть текстову копію або вставте текст.' }) }
        if (!alive.current || serial.current !== run) return
      }
      if (alive.current && serial.current === run) setSources(value => [...value, ...added.filter(source => !source.photoKey || !value.some(current => current.photoKey === source.photoKey))])
    } catch {
      if (alive.current && serial.current === run) setError('Не вдалося прочитати фото. Спробуйте вибрати файл ще раз.')
    } finally { lock.current = false; if (alive.current && serial.current === run) setReading(false); if (picker.current) picker.current.value = '' }
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    if (event.defaultPrevented) return
    if (event.clipboardData.files.length) { event.preventDefault(); if (!blocked) void files(event.clipboardData.files); return }
    if (blocked) return
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
  async function recognize(source: Source) {
    if (!ai || !aiConsent || aiTarget !== source.id || blocked || lock.current || !source.photo && !source.text.trim()) return
    const controller = new AbortController(), run = ++serial.current
    aiAbort.current = controller; lock.current = true; setAiBusy(true); setConfirmed(false); setError('')
    try {
      const { recognizeTeachingQuestionSource } = await import('../../lib/teachingQuestionImportAi')
      const result = await recognizeTeachingQuestionSource(ai, source, controller.signal)
      if (!alive.current || serial.current !== run) return
      if (!result.draftText.trim()) throw new Error(result.notes[0] || 'ШІ не знайшов читабельних запитань. Перевірте джерело або введіть текст вручну.')
      update(source.id, { text: result.draftText, format: 'plain', result: previewTeachingQuestionsEasy(result.draftText, 'plain'),
        aiNotes: result.notes, beforeAi: source.beforeAi || { text: source.text, format: source.format, result: source.result } })
    } catch (failure) {
      if (alive.current && serial.current === run && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Не вдалося розпізнати запитання. Можна продовжити звичайний імпорт.')
      }
    } finally {
      if (alive.current && serial.current === run) {
        aiAbort.current = null; lock.current = false; setAiBusy(false); setAiTarget(''); setAiConsent(false)
      }
    }
  }
  return <div className="teaching-easy-import" onPaste={paste}>
    <header className="teaching-import-intro"><span className="teaching-badge"><Upload size={14} />Імпорт тесту</span><h3>Ваш готовий тест, без перенабирання</h3><p>Додайте файл або вставте текст. Xelay збере запитання для перевірки. Якщо ключів немає, позначте правильні відповіді в редакторі.</p><ol aria-label="Кроки імпорту"><li><span>1</span>Додайте матеріал</li><li><span>2</span>Перевірте запитання</li><li><span>3</span>Підтвердьте імпорт</li></ol></header>
    {error && <p className="teaching-error" role="alert">{error}</p>}
    <section className="teaching-import-drop" data-dragging={dragging} aria-label="Додати файли тесту" onDragOver={event => { event.preventDefault(); if (!blocked) setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); void files(event.dataTransfer.files) }}>
      <FolderOpen size={30} aria-hidden="true" /><h4>{reading ? 'Читаємо файли на вашому пристрої…' : 'Перетягніть сюди один або кілька файлів'}</h4><p>DOC, DOCX, текстовий PDF, XLSX, CSV, TSV, TXT, GIFT та Moodle XML{ai && ' · для ШІ також JPG, PNG і WebP'}</p><div className="teaching-test-actions"><TeachingButton primary disabled={blocked} onClick={() => picker.current?.click()}><Upload size={15} />Вибрати файли</TeachingButton><TeachingButton disabled={blocked} onClick={() => void readClipboard()}><ClipboardPaste size={15} />Вставити з буфера</TeachingButton><TeachingButton disabled={blocked} onClick={() => addText()}><Plus size={15} />Ввести текст</TeachingButton></div><input ref={picker} className="teaching-import-file-input" type="file" multiple accept={ai ? QUESTION_IMPORT_ACCEPT + ',' + photoAccept : QUESTION_IMPORT_ACCEPT} aria-label="Оберіть файли тесту" disabled={blocked} onChange={event => void files(event.target.files)} /><p className="teaching-import-hint">До 10 файлів, по 10 МБ кожен, разом до 20 МБ. Можна також вставити файли через Ctrl+V, якщо браузер це підтримує.</p>
    </section>
    <p className="teaching-import-privacy"><ShieldCheck size={16} aria-hidden="true" />Звичайний імпорт працює у браузері. {ai && 'Лише після окремої згоди вміст одного джерела передається OpenAI в межах ліміту помічника. '}Запитання можна переглянути й змінити перед додаванням.</p>
    <div className="teaching-import-templates"><div><strong>Немає готового формату?</strong><p>Скопіюйте запитання з Word чи таблиці. Можна додати тест без ключів і типів. Правильні відповіді ви позначите перед імпортом.</p></div><div className="teaching-test-actions"><TeachingButton disabled={blocked} onClick={() => downloadTemplate('text')}><Download size={14} />Шаблон TXT</TeachingButton><TeachingButton disabled={blocked} onClick={() => downloadTemplate('table')}><Download size={14} />Шаблон таблиці</TeachingButton><TeachingButton disabled={blocked} onClick={() => addText(QUESTION_IMPORT_TEXT_TEMPLATE, 'Приклад тесту')}>Спробувати приклад</TeachingButton></div></div>
    <details className="teaching-import-help"><summary>Докладна інструкція з імпорту</summary>
      <p><strong>1. Додайте те, що вже маєте.</strong> Вставте текст із Word або завантажте файл. Типи й правильні відповіді не обов’язково мають бути в джерелі: Xelay збере запитання, а ви оберете тип і ключ у перегляді. Для точнішого звичайного імпорту нумеруйте запитання, варіанти позначайте A), B), C). Наявний ключ можна записати «Відповідь: A» або «Відповідь: A,C». Для відкритої відповіді — «Тип: есе». Можна додати «Бали: 2».</p><pre>{QUESTION_IMPORT_TEXT_TEMPLATE}</pre>
      <p><strong>2. Перевірте таблицю.</strong> У CSV, TSV або XLSX використовуйте колонки «Запитання», A, B, C, D, «Відповідь», «Бали» і «Тип». Зайві варіанти залишайте порожніми. Для числового питання можна додати «Похибка». Усі аркуші XLSX мають використовувати однакові заголовки.</p>
      {ai && <p><strong>3. За потреби увімкніть ШІ.</strong> Біля джерела натисніть «Розпізнати з ШІ». Для PDF зі сканами збережіть сторінки як JPG, PNG або WebP і додавайте по одній. Перегляньте примітки, виправте неточності та впишіть відсутні ключі.</p>}
      <p><strong>{ai ? '4' : '3'}. Перегляньте результат.</strong> Звірте умову, усі варіанти, тип і бали кожного запитання. Запитання без ключа відкриються для редагування: позначте правильну відповідь самостійно або оберіть «Розгорнута відповідь» для ручної перевірки. ШІ не розв’язує тест і не вигадує ключів. Нерозпізнані фрагменти залишаться у джерелі та примітках; виправте їх перед підтвердженням. Формули, ілюстрації та нестандартні ваги Moodle можуть потребувати ручного перенесення. Для DOC із формулами, вкладеними об’єктами, прихованим текстом або правками, старих XLS і захищених файлів збережіть звичайну текстову копію.</p>
      <p><strong>{ai ? '5' : '4'}. Підтвердьте додавання.</strong> {destination === 'test' ? 'Запитання з’являться в поточному варіанті. Збережіть чернетку або окремо підтвердьте публікацію після перевірки налаштувань.' : 'Після підтвердження запитання з’являться в банку. Звідти їх можна додати в потрібний тест.'}</p>
    </details>
    {sources.length > 0 && <section className="teaching-import-sources" aria-label="Додані джерела">
      <div className="teaching-test-heading"><h3>Додано джерел: {sources.length}</h3><p>Файли разом утворюють один імпорт до 100 запитань.</p></div>
      {sources.map(source => <article className="teaching-import-source" key={source.id}>
        <header>
          <div><FileText size={17} /><strong>{source.name}</strong><span>{source.result?.questions.length || 0} запитань</span></div>
          <button type="button" className="teaching-icon-button" disabled={blocked} aria-label={`Прибрати джерело ${source.name}`} onClick={() => { setConfirmed(false); setSources(value => value.filter(item => item.id !== source.id)) }}><Trash2 size={16} /></button>
        </header>
        {source.extractionError ? <p className="teaching-error">{source.extractionError}</p> : <>
          {ai && (source.photo || source.text.trim()) && <div className="teaching-import-ai">
            {aiTarget !== source.id ? <TeachingButton disabled={blocked} onClick={() => { setAiTarget(source.id); setAiConsent(false) }}><Sparkles size={15} />Розпізнати з ШІ</TeachingButton> : <>
              <strong>ШІ підготує текст для перевірки</strong>
              <p>До OpenAI передається тільки {source.photo ? 'це фото' : 'текст цього джерела'}. Приберіть імена, оцінки та інші особисті дані. Результат замінить поточний перегляд цього джерела. Початковий варіант можна повернути.</p>
              <label className="teaching-check"><input type="checkbox" disabled={blocked} checked={aiConsent} onChange={event => setAiConsent(event.target.checked)} />Маю право передати цей матеріал OpenAI та погоджуюсь на обробку</label>
              <div className="teaching-test-actions">
                <TeachingButton primary busy={aiBusy} disabled={blocked || !aiConsent} onClick={() => void recognize(source)}><Sparkles size={15} />{aiBusy ? 'Розпізнаємо…' : 'Підтвердити й розпізнати'}</TeachingButton>
                <TeachingButton disabled={blocked} onClick={() => { setAiTarget(''); setAiConsent(false) }}>Назад</TeachingButton>
              </div>
            </>}
            {source.aiNotes && <div role="status" className="teaching-note">
              <strong>Підготовлено з ШІ. Звірте з джерелом.</strong>
              {source.aiNotes.length > 0 && <ul>{source.aiNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
            </div>}
            {source.beforeAi && <TeachingButton disabled={blocked} onClick={() => update(source.id, { ...source.beforeAi, beforeAi: undefined, aiNotes: undefined })}>Повернути початковий варіант</TeachingButton>}
          </div>}
          <details open={source.result === null || Boolean(source.result?.issues.length)}>
            <summary>Текст і формат джерела</summary>
            <TeachingField label={`Формат: ${source.name}`}><select className={teachingInput} disabled={blocked} value={source.format} onChange={event => update(source.id, { format: event.target.value as TeachingEasyImportFormat, result: null })}>{formats.map(format => <option key={format.value} value={format.value}>{format.label}</option>)}</select></TeachingField>
            <TeachingField label={`Текст: ${source.name}`}><textarea className={teachingInput} rows={8} maxLength={QUESTION_IMPORT_MAX_TEXT} value={source.text} disabled={blocked} onChange={event => update(source.id, { text: event.target.value, result: null })} spellCheck={false} /></TeachingField>
            <TeachingButton disabled={blocked || !source.text.trim()} onClick={() => update(source.id, { result: previewTeachingQuestionsEasy(source.text, source.format) })}>Оновити попередній перегляд</TeachingButton>
          </details>
          {source.notes.map(note => <p className="teaching-import-hint" key={note}>{note}</p>)}
        </>}
      </article>)}
    </section>}
    {sources.length > 0 && <section className="teaching-import-preview" aria-label="Попередній перегляд імпорту">
      <div className="teaching-test-heading"><div><span className="teaching-badge">Крок 2</span><h3>Перевірте запитання · {questions.length}</h3></div></div>
      {pending && <p className="teaching-note" role="status">Текст або формат змінено. Оновіть попередній перегляд у відповідному джерелі.</p>}
      {missingKeys > 0 && <div className="teaching-note" role="status"><strong>Без правильних відповідей · {missingKeys}</strong><p>Імпорт зберіг текст і варіанти, але не розв’язує тест за вас. Позначте правильні відповіді в редакторах нижче. Якщо це відкрите запитання, оберіть «Розгорнута відповідь». Підтвердити імпорт можна після перевірки всіх запитань.</p></div>}
      {issues.length > 0 && <div className="teaching-error" role="alert"><strong>Ці пункти потребують виправлення</strong><ul>{issues.map((item, index) => <li key={index}><b>{item.source}.</b> {item.message}</li>)}</ul><p>Виправте текст джерела й оновіть перегляд або приберіть непотрібне джерело. Проблемні запитання не додаються мовчки.</p></div>}
      {questions.length > 100 && <p className="teaching-error" role="alert">Знайдено більше 100 запитань. Приберіть частину джерел і імпортуйте їх окремо.</p>}
      {sources.map(source => source.result?.questions.map((question, index) => {
        const invalid = validateEasyImportedQuestion(question)
        const inferred = source.result?.inferredTypes?.includes(question.id)
        return <details className="teaching-import-question" key={question.id} open={questionOpen[question.id] ?? Boolean(invalid)} onToggle={event => {
          const open = event.currentTarget.open
          setQuestionOpen(value => value[question.id] === open ? value : { ...value, [question.id]: open })
        }}>
          <summary><span className="teaching-import-question-number">{index + 1}</span><span><small>{TEST_QUESTION_LABELS[question.kind]} · {question.points} балів · {source.name}</small><strong>{question.text}</strong><em>{answerLabel(question)}</em>{inferred && <small>Тип визначено за структурою — перевірте або змініть.</small>}</span><PencilLabel /></summary>
          <div className="teaching-import-question-body"><fieldset disabled={blocked}><TeachingQuestionEditor compact question={question} onChange={fields => {
            setConfirmed(false)
            // Fixing the last validation error must not close the editor or
            // remove focus from the selected key before the teacher checks it.
            setQuestionOpen(value => value[question.id] === true ? value : { ...value, [question.id]: true })
            setSources(value => value.map(item => item.id === source.id && item.result ? { ...item, result: {
              ...item.result,
              inferredTypes: fields.kind !== undefined ? item.result.inferredTypes?.filter(id => id !== question.id) : item.result.inferredTypes,
              questions: item.result.questions.map(current => current.id === question.id ? { ...current, ...fields } : current),
            } } : item))
          }} /></fieldset>{invalid && <p className="teaching-error" role="alert">{invalid}</p>}</div>
        </details>
      }))}
      {questions.length > 0 && <div className="teaching-import-confirm"><span className="teaching-badge">Крок 3</span>{destination === 'bank' && <TeachingField label="Тема для цих запитань, необов’язково"><input maxLength={120} className={teachingInput} disabled={blocked} value={category} onChange={event => setCategory(event.target.value)} placeholder="Наприклад, Модуль 1" /></TeachingField>}<label className="teaching-check"><input type="checkbox" checked={confirmed} disabled={blocked || pending || Boolean(issues.length) || Boolean(editedInvalid.length) || questions.length > 100} onChange={event => setConfirmed(event.target.checked)} />Я перевірив типи запитань, умови, правильні відповіді та бали</label><p>{destination === 'test' ? `У редактор тесту буде додано ${questions.length} запитань. Потім перевірте налаштування й збережіть тест. Імпорт не публікує його автоматично.` : `До банку буде додано ${questions.length} запитань. Наявні тести, відповіді студентів та оцінки не змінюються. Після імпорту виберіть потрібні запитання для тесту.`}</p><TeachingButton primary busy={busy || confirming} disabled={!canConfirm} onClick={() => void confirmImport()}><Check size={16} />Підтвердити й додати {questions.length} запитань {destination === 'test' ? 'у тест' : 'у банк'}</TeachingButton></div>}
    </section>}
    <div className="teaching-test-footer"><TeachingButton disabled={blocked} onClick={onCancel}>{destination === 'test' ? 'Назад до редактора тесту' : 'Назад до банку'}</TeachingButton></div>
  </div>
}
function PencilLabel() { return <span className="teaching-import-edit-label">Перевірити / змінити</span> }
