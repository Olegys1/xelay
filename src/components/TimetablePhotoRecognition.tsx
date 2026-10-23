import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, Crop, FileSpreadsheet, ImagePlus, Link, Loader2, RotateCw, ScanText, TriangleAlert, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { isTimetableDate, LESSON_TYPES, mondayForDate } from '../lib/studyGroupTimetable'
import type { TimetableRecognitionResult, TimetableSourceAnalysis, TimetableSourceSelection } from '../lib/timetableRecognition'
import {
  analyzeTimetableSources, loadTimetableGoogleSheet, loadTimetableSpreadsheet, prepareTimetablePhoto, recognizeTimetableSources,
  timetableRecognitionAvailability, timetableSourceMatches, TimetableRecognitionRequestError, type TimetablePhotoOptions,
} from '../lib/timetableRecognitionClient'
import {
  normalizeTimetableRecognitionPackage, timetableRecognitionPackageByteLength,
  TIMETABLE_RECOGNITION_MAX_SOURCES, TIMETABLE_RECOGNITION_MAX_IMAGE_BYTES,
  TIMETABLE_RECOGNITION_MAX_TOTAL_IMAGE_BYTES, TIMETABLE_RECOGNITION_MAX_BODY_BYTES,
  TIMETABLE_RECOGNITION_MAX_SOURCE_NAME_LENGTH,
  emptyTimetableRecognitionLayoutHint,
  type TimetableRecognitionSource, type TimetableRecognitionTarget, type TimetableRecognitionWeekHint,
  type TimetableRecognitionLayoutHint,
} from '../lib/timetableRecognitionSources'

const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']
const weekNames = { every: 'Щотижня', upper: 'Верхній', lower: 'Нижній' }
const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const fieldClass = 'mt-1 min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50'
const fullCrop = { left: 0, top: 0, right: 100, bottom: 100 }
const levelNames: Record<string, string> = { bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' }
const weekHints: Record<TimetableRecognitionWeekHint, string> = { auto: 'Визначити з фото', upper: 'Верхній тиждень', lower: 'Нижній тиждень', every: 'Щотижня' }
const emptySettings = { validFrom: '', validUntil: '', upperMonday: '' }
type PhotoCrop = typeof fullCrop
type PhotoEntry = { id: string; kind: 'image'; file: File; rotation: 0 | 90 | 180 | 270; cropEnabled: boolean; crop: PhotoCrop; weekHint: TimetableRecognitionWeekHint; layoutHint: TimetableRecognitionLayoutHint }
type SheetEntry = { id: string; kind: 'spreadsheet'; file: File; selectedSheets: string[]; layoutHint: TimetableRecognitionLayoutHint }
type SourceEntry = PhotoEntry | SheetEntry
type PreparedPhoto = { key: string; image: string; error: string }
type Workbook = { name: string; sheets: Array<{ name: string; table_text: string }> }
type ParsedWorkbook = { workbook: Workbook | null; error: string }
export type TimetableRecognitionImportSettings = { validFrom: string; validUntil: string; upperMonday: string }

function errorText(error: unknown): string {
  if (error instanceof Error && error.message && !/^[A-Z_\d]+$/.test(error.message)) return error.message
  return 'Не вдалося розпізнати розклад. Перевірте з’єднання або спробуйте чіткіші джерела.'
}
function sourceLabel(source: TimetableSourceSelection): string {
  return [source.group_name, source.study_level ? levelNames[source.study_level] : '', source.study_year ? String(source.study_year) + ' курс' : '', source.program, source.section_label].filter(Boolean).join(' · ') || 'Один розклад без підпису групи'
}
const compareLabel = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[^\p{L}\p{N}]+/gu, '')
const sourceName = (name: string) => name.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, TIMETABLE_RECOGNITION_MAX_SOURCE_NAME_LENGTH) || 'Розклад'
const photoKey = (entry: PhotoEntry, maximumBytes: number) => entry.id + ':' + JSON.stringify([entry.rotation, entry.cropEnabled ? entry.crop : fullCrop, maximumBytes])
function initialTarget(name?: string, course?: number | null, program?: string, level?: string | null): TimetableRecognitionTarget {
  return { group_name: (name || '').slice(0, 100), study_year: course && course >= 1 && course <= 6 ? course : null,
    study_level: level === 'bachelor' || level === 'master' || level === 'postgraduate' ? level : null, program: (program || '').slice(0, 160) }
}
function settingsError(settings: TimetableRecognitionImportSettings): string {
  if (!isTimetableDate(settings.validFrom) || !isTimetableDate(settings.validUntil) || !isTimetableDate(settings.upperMonday)) return 'Оберіть початок і завершення імпорту та понеділок верхнього тижня.'
  if (settings.validFrom > settings.validUntil) return 'Завершення імпорту має бути не раніше його початку.'
  if (mondayForDate(settings.upperMonday) !== settings.upperMonday) return 'Для верхнього тижня оберіть саме понеділок.'
  return ''
}

function SourceLayoutFields({ value, onChange }: { value: TimetableRecognitionLayoutHint; onChange: (value: TimetableRecognitionLayoutHint) => void }) {
  return <fieldset className="space-y-3 rounded-xl border border-primary/20 bg-background p-3 sm:p-4">
    <legend className="px-1 text-sm font-semibold">Як читати цю таблицю</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-xs font-medium">Групи всередині кожного дня<select className={fieldClass} value={value.group_columns} onChange={event => {
        const group_columns = event.target.value as TimetableRecognitionLayoutHint['group_columns']
        onChange({ ...value, group_columns, group_column_count: group_columns === 'split' ? 2 : null, group_column_index: null })
      }}><option value="auto">Визначити за заголовками</option><option value="shared">Тут розклад лише однієї групи</option><option value="split">Кілька груп поруч у стовпцях</option></select></label>
      <label className="min-w-0 text-xs font-medium">Горизонтальний поділ однієї пари<select className={fieldClass} value={value.week_rows} onChange={event => onChange({ ...value, week_rows: event.target.value as TimetableRecognitionLayoutHint['week_rows'] })}><option value="auto">Визначити з підписів; якщо їх немає — запитати</option><option value="upper_lower">Зверху — верхній тиждень, знизу — нижній</option><option value="lower_upper">Зверху — нижній тиждень, знизу — верхній</option><option value="none">Це не поділ на верхній і нижній тижні</option></select></label>
      {value.group_columns === 'split' && <>
        <label className="min-w-0 text-xs font-medium">Кількість груп поруч<select className={fieldClass} value={value.group_column_count ?? 2} onChange={event => {
          const count = Number(event.target.value)
          onChange({ ...value, group_column_count: count, group_column_index: value.group_column_index && value.group_column_index <= count ? value.group_column_index : null })
        }}>{[2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} {count < 5 ? 'групи' : 'груп'}</option>)}</select></label>
        <label className="min-w-0 text-xs font-medium">Де моя група в кожному дні<select className={fieldClass} value={value.group_column_index ?? ''} onChange={event => onChange({ ...value, group_column_index: event.target.value ? Number(event.target.value) : null })}><option value="">Оберіть свій стовпець</option>{Array.from({ length: value.group_column_count ?? 2 }, (_, index) => <option key={index} value={index + 1}>{value.group_column_count === 2 ? index === 0 ? 'Ліва група' : 'Права група' : `Група №${index + 1} зліва направо`}</option>)}</select></label>
      </>}
    </div>
    {value.group_columns === 'split' && <p className="text-xs leading-relaxed text-muted-foreground">Обирайте стовпець групи всередині кожного дня, а не половину всього фото. Заняття в об’єднаній клітинці на всі групи також враховуються. Стовпці підгруп не позначайте як окремі навчальні групи.</p>}
    <label className="block text-xs font-medium">Пояснення до джерела · необов’язково<textarea rows={2} maxLength={400} className={fieldClass} value={value.notes} onChange={event => onChange({ ...value, notes: event.target.value })} placeholder="Наприклад: це продовження першого фото; ліворуч ЕУБ-1, праворуч ЕУБ-2; риски позначають тижні." /><span className="mt-1 block font-normal text-muted-foreground">Додавайте тільки відомості про розклад: назви груп, легенду, підписи й продовження фото.</span></label>
  </fieldset>
}

export function TimetablePhotoRecognition({ groupId, destinationName, destinationCourse, destinationProgram, destinationStudyLevel, hasDraft, draftRevision, importSettings, onImportSettingsChange, onApply }: {
  groupId: string
  destinationName?: string
  destinationCourse?: number | null
  destinationProgram?: string
  destinationStudyLevel?: string | null
  hasDraft: boolean
  draftRevision?: string
  importSettings?: TimetableRecognitionImportSettings
  onImportSettingsChange?: (settings: TimetableRecognitionImportSettings) => void
  onApply: (result: TimetableRecognitionResult, settings: TimetableRecognitionImportSettings) => void
}) {
  const { authUser } = useAuth()
  const identity = (authUser?.id || '') + ':' + groupId
  const currentIdentity = useRef(identity); currentIdentity.current = identity
  const inputId = useId()
  const [entries, setEntries] = useState<SourceEntry[]>([])
  const [activeId, setActiveId] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [prepared, setPrepared] = useState<Record<string, PreparedPhoto>>({})
  const [workbooks, setWorkbooks] = useState<Record<string, ParsedWorkbook>>({})
  const [preparationRefresh, setPreparationRefresh] = useState(0)
  const [target, setTarget] = useState(() => initialTarget(destinationName, destinationCourse, destinationProgram, destinationStudyLevel))
  const [localSettings, setLocalSettings] = useState<TimetableRecognitionImportSettings>(importSettings || emptySettings)
  const settings = onImportSettingsChange && importSettings ? importSettings : localSettings
  const dateError = settingsError(settings)
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null)
  const [availabilityError, setAvailabilityError] = useState('')
  const [statusRefresh, setStatusRefresh] = useState(0)
  const [busy, setBusy] = useState<'analyze' | 'extract' | null>(null)
  const [googleSheetUrl, setGoogleSheetUrl] = useState('')
  const [googleSheetLoading, setGoogleSheetLoading] = useState(false)
  const [googleSheetNotice, setGoogleSheetNotice] = useState('')
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState<TimetableSourceAnalysis | null>(null)
  const [courseFilter, setCourseFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [result, setResult] = useState<TimetableRecognitionResult | null>(null)
  const [applied, setApplied] = useState(false)
  const [confirmedSource, setConfirmedSource] = useState(false)
  const [confirmedReplacement, setConfirmedReplacement] = useState(false)
  const request = useRef<AbortController | null>(null)
  const requestVersion = useRef(0)
  const googleSheetRequest = useRef<AbortController | null>(null)
  const googleSheetRequestVersion = useRef(0)
  const applying = useRef(false)
  const appliedResult = useRef<TimetableRecognitionResult | null>(null)
  const currentResult = useRef<TimetableRecognitionResult | null>(null)
  const resultOwner = useRef('')
  const photoDialog = useRef<HTMLDialogElement | null>(null)
  const layoutPanel = useRef<HTMLDivElement | null>(null)
  const entryNumber = useRef(0)
  const photoCache = useRef<Record<string, PreparedPhoto>>({})
  const workbookCache = useRef<Record<string, ParsedWorkbook>>({})

  const imageCount = entries.filter((entry) => entry.kind === 'image').length
  const maximumPhotoBytes = Math.min(TIMETABLE_RECOGNITION_MAX_IMAGE_BYTES, Math.floor(TIMETABLE_RECOGNITION_MAX_TOTAL_IMAGE_BYTES / Math.max(1, imageCount)))
  const activeEntry = entries.find(entry => entry.id === activeId) || null
  const activePhoto = entries.find((entry): entry is PhotoEntry => entry.id === activeId && entry.kind === 'image') || null
  const activePrepared = activePhoto ? prepared[activePhoto.id] : undefined
  const preparedImage = activePhoto && activePrepared?.key === photoKey(activePhoto, maximumPhotoBytes) ? activePrepared.image : ''
  const preparing = entries.some((entry) => entry.kind === 'image'
    ? prepared[entry.id]?.key !== photoKey(entry, maximumPhotoBytes)
    : !workbooks[entry.id])
  const selectedSourceCount = entries.reduce((total, entry) => total + (entry.kind === 'image' ? 1 : entry.selectedSheets.length), 0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAvailability(null); setAvailabilityError('')
    void timetableRecognitionAvailability(groupId, controller.signal).then((status) => {
      if (active && currentIdentity.current === identity) setAvailability(status)
    }).catch((problem: unknown) => {
      if (active && currentIdentity.current === identity && !controller.signal.aborted) setAvailabilityError(errorText(problem))
    })
    return () => { active = false; controller.abort() }
  }, [groupId, identity, statusRefresh])

  useEffect(() => {
    setEntries([]); setActiveId(''); setPrepared({}); setWorkbooks({})
    photoCache.current = {}; workbookCache.current = {}
    setTarget(initialTarget(destinationName, destinationCourse, destinationProgram, destinationStudyLevel))
    setLocalSettings(emptySettings); setAnalysis(null); setSelectedId(''); setResult(null)
    resultOwner.current = ''; currentResult.current = null; appliedResult.current = null
    setApplied(false); setError(''); setBusy(null); setConfirmedSource(false); setConfirmedReplacement(false)
    setGoogleSheetUrl(''); setGoogleSheetLoading(false); setGoogleSheetNotice('')
    setCourseFilter(''); setLevelFilter(''); photoDialog.current?.close()
    return () => {
      requestVersion.current += 1; request.current?.abort(); request.current = null
      googleSheetRequestVersion.current += 1; googleSheetRequest.current?.abort(); googleSheetRequest.current = null
    }
    // Destination metadata is a default search criterion, never a replacement for source headers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  useEffect(() => { setConfirmedReplacement(false) }, [draftRevision])
  useEffect(() => {
    if (importSettings) setLocalSettings({ ...importSettings })
    // Prefill from the manual editor; AI date edits are committed only on explicit Apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importSettings?.validFrom, importSettings?.validUntil, importSettings?.upperMonday])
  useEffect(() => {
    if (!activePhoto) { setPhotoUrl(''); return }
    const url = URL.createObjectURL(activePhoto.file)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [activePhoto?.file])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const images = entries.filter((entry): entry is PhotoEntry => entry.kind === 'image')
    void (async () => {
      // Sequential preparation avoids keeping a whole batch of large canvases alive on a phone.
      for (const entry of images) {
        const key = photoKey(entry, maximumPhotoBytes)
        let value = photoCache.current[entry.id]
        if (value?.key !== key) {
          try {
            const options: TimetablePhotoOptions = { rotation: entry.rotation, crop: entry.cropEnabled ? entry.crop : fullCrop, maximumBytes: maximumPhotoBytes }
            const image = await prepareTimetablePhoto(entry.file, options, controller.signal)
            value = { key, image, error: '' }
          } catch (problem) {
            if (!active || controller.signal.aborted) return
            value = { key, image: '', error: errorText(problem) }
          }
        }
        if (!active || controller.signal.aborted || currentIdentity.current !== identity) return
        photoCache.current[entry.id] = value
        setPrepared((current) => ({ ...current, [entry.id]: value }))
      }
    })()
    return () => { active = false; controller.abort() }
  }, [entries, maximumPhotoBytes, identity, preparationRefresh])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      for (const entry of entries) {
        if (entry.kind !== 'spreadsheet') continue
        let value = workbookCache.current[entry.id]
        if (!value) {
          try { value = { workbook: await loadTimetableSpreadsheet(entry.file, controller.signal), error: '' } }
          catch (problem) {
            if (!active || controller.signal.aborted) return
            value = { workbook: null, error: errorText(problem) }
          }
        }
        if (!active || controller.signal.aborted || currentIdentity.current !== identity) return
        workbookCache.current[entry.id] = value
        setWorkbooks((current) => ({ ...current, [entry.id]: value }))
      }
    })()
    return () => { active = false; controller.abort() }
  }, [entries, identity, preparationRefresh])

  const cancelGoogleSheet = () => {
    googleSheetRequestVersion.current += 1; googleSheetRequest.current?.abort(); googleSheetRequest.current = null; setGoogleSheetLoading(false)
  }
  const cancel = () => {
    requestVersion.current += 1; request.current?.abort(); request.current = null; setBusy(null)
    cancelGoogleSheet()
  }
  const clearResult = () => {
    resultOwner.current = ''; appliedResult.current = null; currentResult.current = null
    setResult(null); setApplied(false); setConfirmedSource(false); setConfirmedReplacement(false); setError('')
  }
  const invalidate = () => {
    cancel(); clearResult(); setAnalysis(null); setSelectedId(''); setCourseFilter(''); setLevelFilter('')
  }
  const changeEntries = (next: SourceEntry[]) => { invalidate(); setEntries(next) }
  const changeLayout = (id: string, layoutHint: TimetableRecognitionLayoutHint) => {
    changeEntries(entries.map(entry => entry.id === id ? { ...entry, layoutHint } : entry))
  }
  const changePhoto = (id: string, changes: Partial<Pick<PhotoEntry, 'rotation' | 'cropEnabled' | 'crop' | 'weekHint'>>) => {
    photoDialog.current?.close()
    changeEntries(entries.map((entry) => entry.id === id && entry.kind === 'image' ? { ...entry, ...changes } : entry))
  }
  const addFiles = (files: readonly File[]) => {
    if (!files.length) return
    invalidate()
    setGoogleSheetNotice('')
    let message = ''
    const next = [...entries]
    let count = selectedSourceCount
    for (const file of files) {
      if (next.length >= TIMETABLE_RECOGNITION_MAX_SOURCES) { message = `Можна додати до ${TIMETABLE_RECOGNITION_MAX_SOURCES} файлів. Приберіть зайві перед додаванням нових.`; break }
      const image = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)
      const spreadsheet = /\.(xlsx|csv|tsv)$/i.test(file.name)
      if ((!image && !spreadsheet) || file.size <= 0) { message = 'Оберіть JPG, PNG, WebP, XLSX, CSV або TSV. Старий формат XLS не підтримується.'; continue }
      if (image && file.size > 8 * 1024 * 1024) { message = 'Одне вихідне фото може мати розмір до 8 МБ.'; continue }
      if (image && count >= TIMETABLE_RECOGNITION_MAX_SOURCES) { message = `У пакеті може бути до ${TIMETABLE_RECOGNITION_MAX_SOURCES} фото та вибраних листів разом. Зніміть вибір зайвого листа.`; continue }
      const id = 'source-' + String(++entryNumber.current)
      if (image) { next.push({ id, file, kind: 'image', rotation: 0, cropEnabled: false, crop: { ...fullCrop }, weekHint: 'auto', layoutHint: emptyTimetableRecognitionLayoutHint() }); count += 1 }
      else next.push({ id, file, kind: 'spreadsheet', selectedSheets: [], layoutHint: emptyTimetableRecognitionLayoutHint() })
    }
    setEntries(next)
    setActiveId(current => current || next[0]?.id || '')
    if (message) setError(message)
  }
  const chooseFiles = (files: FileList | null) => { if (files?.length) addFiles(Array.from(files)) }
  const loadGoogleSheet = async () => {
    if (!googleSheetUrl.trim() || googleSheetLoading || googleSheetRequest.current || entries.length >= TIMETABLE_RECOGNITION_MAX_SOURCES) return
    invalidate(); setGoogleSheetNotice('')
    const controller = new AbortController(); googleSheetRequest.current = controller
    const version = ++googleSheetRequestVersion.current, owner = identity
    setGoogleSheetLoading(true)
    try {
      const file = await loadTimetableGoogleSheet(groupId, googleSheetUrl.trim(), controller.signal)
      if (googleSheetRequestVersion.current !== version || currentIdentity.current !== owner || controller.signal.aborted) return
      addFiles([file])
      setGoogleSheetNotice('Таблицю завантажено. Оберіть потрібні листи нижче та перевірте курс і назву групи.')
    } catch (problem) {
      if (googleSheetRequestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) setError(errorText(problem))
    } finally {
      if (googleSheetRequestVersion.current === version && currentIdentity.current === owner) { googleSheetRequest.current = null; setGoogleSheetLoading(false) }
    }
  }
  const removeEntry = (id: string) => {
    photoDialog.current?.close()
    const next = entries.filter((entry) => entry.id !== id)
    changeEntries(next)
    delete photoCache.current[id]; delete workbookCache.current[id]
    setPrepared((current) => { const clean = { ...current }; delete clean[id]; return clean })
    setWorkbooks((current) => { const clean = { ...current }; delete clean[id]; return clean })
    if (activeId === id) setActiveId(next[0]?.id || '')
  }
  const changeSheet = (entry: SheetEntry, name: string, checked: boolean) => {
    if (checked && selectedSourceCount >= TIMETABLE_RECOGNITION_MAX_SOURCES) return
    const selectedSheets = checked ? [...entry.selectedSheets, name] : entry.selectedSheets.filter((sheet) => sheet !== name)
    changeEntries(entries.map((item) => item.id === entry.id ? { ...entry, selectedSheets } : item))
  }
  const retryPreparation = () => {
    invalidate(); photoCache.current = {}; workbookCache.current = {}
    setPrepared({}); setWorkbooks({}); setPreparationRefresh((current) => current + 1)
  }
  const changeTarget = (changes: Partial<TimetableRecognitionTarget>) => { invalidate(); setTarget((current) => ({ ...current, ...changes })) }
  const changeSettings = (changes: Partial<TimetableRecognitionImportSettings>) => {
    const next = { ...settings, ...changes }
    setConfirmedReplacement(false)
    if (onImportSettingsChange) onImportSettingsChange(next)
    else setLocalSettings(next)
  }

  const bundle = useMemo(() => {
    if (!entries.length || preparing) return { value: null, error: '' }
    const sources: TimetableRecognitionSource[] = []
    try {
      for (const entry of entries) {
        if (entry.kind === 'image') {
          const photo = prepared[entry.id]
          if (!photo || photo.key !== photoKey(entry, maximumPhotoBytes) || !photo.image) return { value: null, error: photo?.error || 'Дочекайтеся підготовки всіх фото.' }
          sources.push({ kind: 'image', name: sourceName(entry.file.name), image_data_url: photo.image, week_hint: entry.weekHint, layout_hint: entry.layoutHint })
        } else {
          const parsed = workbooks[entry.id]
          if (!parsed?.workbook) return { value: null, error: parsed?.error || 'Дочекайтеся читання таблиць.' }
          for (const sheet of parsed.workbook.sheets) if (entry.selectedSheets.includes(sheet.name)) {
            sources.push({ kind: 'spreadsheet', name: sourceName(entry.file.name.slice(0, 80) + ' · ' + sheet.name), table_text: sheet.table_text, layout_hint: entry.layoutHint })
          }
        }
      }
      const value = normalizeTimetableRecognitionPackage(sources, target)
      if (timetableRecognitionPackageByteLength({ action: 'analyze', group_id: groupId, ...value }) > TIMETABLE_RECOGNITION_MAX_BODY_BYTES) return { value: null, error: 'Пакет завеликий. Приберіть зайве фото або лист таблиці.' }
      return { value, error: '' }
    } catch (problem) { return { value: null, error: errorText(problem) } }
  }, [entries, preparing, prepared, workbooks, target, maximumPhotoBytes, groupId])
  const packageSourceEntries = entries.flatMap<SourceEntry>(entry => entry.kind === 'image' ? [entry]
    : (workbooks[entry.id]?.workbook?.sheets || []).filter(sheet => entry.selectedSheets.includes(sheet.name)).map(() => entry))
  const preparationFailed = entries.some((entry) => entry.kind === 'image' ? Boolean(prepared[entry.id]?.error) : Boolean(workbooks[entry.id]?.error))
  const selected = analysis?.candidates.find((candidate) => candidate.id === selectedId) || null
  const chooseSource = (id: string) => { cancel(); clearResult(); setSelectedId(id) }
  const destination = [destinationName || 'Поточна навчальна група', destinationStudyLevel ? levelNames[destinationStudyLevel] : '', destinationCourse ? String(destinationCourse) + ' курс' : '', destinationProgram].filter(Boolean).join(' · ')
  const sourceDiffers = Boolean(selected && ((selected.group_name && destinationName && compareLabel(selected.group_name) !== compareLabel(destinationName))
    || (selected.study_year && destinationCourse && selected.study_year !== destinationCourse)
    || (selected.study_level && destinationStudyLevel && selected.study_level !== destinationStudyLevel)
    || (selected.program && destinationProgram && compareLabel(selected.program) !== compareLabel(destinationProgram))))
  const unlabelledSource = Boolean(selected && !selected.group_name)
  const unknownSourceFields = selected ? [
    destinationName && !selected.group_name ? 'назву групи' : '',
    destinationCourse && !selected.study_year ? 'курс' : '',
    destinationStudyLevel && !selected.study_level ? 'рівень освіти' : '',
    destinationProgram && !selected.program ? 'освітню програму' : '',
  ].filter(Boolean) : []
  const requiresSourceConfirmation = sourceDiffers || unlabelledSource || unknownSourceFields.length > 0
  const sourceMatches = Boolean(result && selected && timetableSourceMatches(result, selected))

  const analyze = async () => {
    if (!bundle.value || !availability?.available || request.current || preparing || googleSheetLoading) return
    const controller = new AbortController(); request.current = controller
    const version = ++requestVersion.current, owner = identity
    setBusy('analyze'); clearResult(); setAnalysis(null); setSelectedId(''); setCourseFilter(''); setLevelFilter('')
    try {
      const found = await analyzeTimetableSources(groupId, bundle.value.sources, bundle.value.target, controller.signal)
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) {
        setAnalysis(found)
        setSelectedId(found.layout === 'single' && found.candidates.length === 1 ? found.candidates[0].id : '')
      }
    } catch (problem) {
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) setError(errorText(problem))
    } finally {
      if (requestVersion.current === version && currentIdentity.current === owner) { request.current = null; setBusy(null) }
    }
  }
  const recognize = async () => {
    if (!bundle.value || !analysis || !selected || !availability?.available || request.current || preparing || googleSheetLoading) return
    if (timetableRecognitionPackageByteLength({ action: 'extract', group_id: groupId, ...bundle.value, source_selection: selected, analysis_token: analysis.analysis_token }) > TIMETABLE_RECOGNITION_MAX_BODY_BYTES) {
      setError('Пакет завеликий для розпізнавання. Приберіть зайве джерело й повторіть пошук груп.'); return
    }
    const controller = new AbortController(); request.current = controller
    const version = ++requestVersion.current, owner = identity
    setBusy('extract'); clearResult()
    try {
      const recognized = await recognizeTimetableSources(groupId, bundle.value.sources, bundle.value.target, selected, analysis.analysis_token, controller.signal)
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) { resultOwner.current = owner; currentResult.current = recognized; setResult(recognized) }
    } catch (problem) {
      if (requestVersion.current === version && currentIdentity.current === owner && !controller.signal.aborted) {
        if (problem instanceof TimetableRecognitionRequestError && (problem.status === 409 || problem.requiresAnalysis)) {
          const clarifications = problem.clarifications.filter(question => question.source_index <= bundle.value!.sources.length)
          setAnalysis(clarifications.length ? { version: 2, kind: 'source_analysis', layout: 'unreadable', candidates: [],
            warnings: [problem.message], analysis_token: analysis.analysis_token, clarifications } : null)
          setSelectedId('')
        }
        setError(errorText(problem))
      }
    } finally {
      if (requestVersion.current === version && currentIdentity.current === owner) { request.current = null; setBusy(null) }
    }
  }
  const apply = () => {
    if (!result || currentResult.current !== result || resultOwner.current !== currentIdentity.current || appliedResult.current === result || applied || applying.current || dateError || !sourceMatches || (requiresSourceConfirmation && !confirmedSource) || (hasDraft && !confirmedReplacement)) return
    applying.current = true; appliedResult.current = result
    try { onApply(result, { ...settings }); setApplied(true) } catch (problem) { appliedResult.current = null; setError(errorText(problem)) }
    finally { applying.current = false }
  }
  const affected = result?.week_mode === 'upper_only' ? 'верхнього тижня' : result?.week_mode === 'lower_only' ? 'нижнього тижня' : 'обох тижнів'
  const reviewCount = result?.lessons.filter((lesson) => lesson.needs_review || !lesson.subject || Boolean(lesson.date_note)).length || 0
  const missingTimeCount = result?.slots.filter((slot) => !slot.starts_at || !slot.ends_at).length || 0
  const courseOptions = Array.from(new Set((analysis?.candidates || []).map((candidate) => candidate.study_year))).sort((left, right) => (left || 99) - (right || 99))
  const levelOptions = Array.from(new Set((analysis?.candidates || []).map((candidate) => candidate.study_level)))
  const visibleCandidates = (analysis?.candidates || []).filter((candidate) => (!courseFilter || String(candidate.study_year ?? 'unknown') === courseFilter) && (!levelFilter || (candidate.study_level ?? 'unknown') === levelFilter))

  return <section className="min-w-0 rounded-2xl border border-primary/20 bg-primary/[0.025] p-4 sm:p-5" aria-labelledby={inputId + '-title'}>
    <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><ScanText size={21} aria-hidden="true" /></span><div className="min-w-0"><h3 id={inputId + '-title'} className="font-semibold">Розпізнати розклад</h3><p className="mt-1 text-sm text-muted-foreground">Додайте фото, файл таблиці або посилання на Google Таблицю. ШІ знайде групи, а ви оберете потрібну й перевірите заняття.</p></div></div>
    <div className="mt-3 rounded-xl border border-border bg-background px-3 py-2 text-xs"><span className="text-muted-foreground">Додати до групи на платформі: </span><strong className="break-words font-medium">{destination}</strong></div>
    <fieldset className="mt-4 rounded-xl border border-border bg-background p-3">
      <legend className="px-1 text-sm font-medium">Яку групу шукати в розкладі</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-xs font-medium">Назва групи<input value={target.group_name} maxLength={100} className={fieldClass} placeholder="Наприклад, ЕУБ-4" onChange={(event) => changeTarget({ group_name: event.target.value })} /></label>
        <label className="min-w-0 text-xs font-medium">Освітня програма<input value={target.program} maxLength={160} className={fieldClass} placeholder="Як у заголовку таблиці" onChange={(event) => changeTarget({ program: event.target.value })} /></label>
        <label className="text-xs font-medium">Курс<select className={fieldClass} value={target.study_year ?? ''} onChange={(event) => changeTarget({ study_year: event.target.value ? Number(event.target.value) : null })}><option value="">Не вказано</option>{[1, 2, 3, 4, 5, 6].map((course) => <option key={course} value={course}>{course} курс</option>)}</select></label>
        <label className="text-xs font-medium">Рівень освіти<select className={fieldClass} value={target.study_level ?? ''} onChange={(event) => changeTarget({ study_level: (event.target.value || null) as TimetableRecognitionTarget['study_level'] })}><option value="">Не вказано</option>{Object.entries(levelNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Ці поля допомагають знайти потрібний стовпець. Дані, яких немає у файлах, не вгадуються. Група призначення на платформі залишається вказаною вище.</p>
    </fieldset>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label htmlFor={inputId} className={secondaryButton + ' relative cursor-pointer ' + (entries.length >= TIMETABLE_RECOGNITION_MAX_SOURCES ? 'pointer-events-none opacity-50' : '')}><ImagePlus size={16} aria-hidden="true" />Додати файли<input id={inputId} type="file" multiple accept="image/jpeg,image/png,image/webp,.xlsx,.csv,.tsv" disabled={entries.length >= TIMETABLE_RECOGNITION_MAX_SOURCES} className="sr-only" onChange={(event) => { chooseFiles(event.target.files); event.target.value = '' }} /></label>
      <span className="text-xs text-muted-foreground">JPG, PNG, WebP · XLSX, CSV, TSV · до {TIMETABLE_RECOGNITION_MAX_SOURCES} фото й листів разом</span>
    </div>
    <div className="mt-3 space-y-2 rounded-xl border border-border bg-background p-3">
      <label htmlFor={inputId + '-google-sheet'} className="block text-xs font-medium">Посилання на Google Таблицю</label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input id={inputId + '-google-sheet'} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048} value={googleSheetUrl} aria-describedby={inputId + '-google-sheet-help'} className={fieldClass + ' mt-0 flex-1'} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={event => { cancelGoogleSheet(); setGoogleSheetUrl(event.target.value); setGoogleSheetNotice(''); setError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void loadGoogleSheet() } }} />
        <button type="button" className={secondaryButton + ' shrink-0'} disabled={!googleSheetUrl.trim() || googleSheetLoading || entries.length >= TIMETABLE_RECOGNITION_MAX_SOURCES} onClick={() => void loadGoogleSheet()}>{googleSheetLoading ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Link size={16} aria-hidden="true" />}{googleSheetLoading ? 'Завантажуємо таблицю…' : 'Завантажити за посиланням'}</button>
        {googleSheetLoading && <button type="button" className={secondaryButton} onClick={cancelGoogleSheet}>Скасувати</button>}
      </div>
      <p id={inputId + '-google-sheet-help'} className="text-xs leading-relaxed text-muted-foreground">Таблиця має відкриватися без входу в Google та дозволяти завантаження. За посиланням — до 4 МБ. Завантажується поточна копія: щоб оновити її, приберіть попередню та завантажте посилання ще раз. Листи, курс і групу обираєте ви; розклад не зберігається автоматично.</p>
      {googleSheetLoading && <p role="status" className="text-xs text-muted-foreground">Завантажуємо таблицю без запуску ШІ. Після цього можна буде вибрати потрібні листи.</p>}
      {googleSheetNotice && <p role="status" className="text-xs font-medium text-primary">{googleSheetNotice}</p>}
    </div>
    {entries.length > 0 && <ul className="mt-3 space-y-2" aria-label="Джерела розкладу">{entries.map((entry) => {
      const parsed = workbooks[entry.id]
      const photo = entry.kind === 'image' ? prepared[entry.id] : undefined
      const ready = entry.kind === 'image' ? photo?.key === photoKey(entry, maximumPhotoBytes) : Boolean(parsed)
      return <li key={entry.id} className="min-w-0 rounded-xl border border-border bg-background p-3">
        <div className="flex items-start gap-2">{entry.kind === 'image' ? <ImagePlus size={17} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" /> : <FileSpreadsheet size={17} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />}<div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{entry.file.name}</p><p className="mt-0.5 text-xs text-muted-foreground">{entry.kind === 'image' ? 'Фото · ' : 'Таблиця · '}{(entry.file.size / 1024 / 1024).toFixed(1)} МБ{!ready ? ' · Готуємо…' : ''}</p></div><button type="button" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label={'Прибрати файл ' + entry.file.name} onClick={() => removeEntry(entry.id)}><X size={17} aria-hidden="true" /></button></div>
        {entry.kind === 'image' ? <div className="mt-2 flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-xs font-medium">Тиждень на цьому фото<select className={fieldClass} value={entry.weekHint} onChange={(event) => changePhoto(entry.id, { weekHint: event.target.value as TimetableRecognitionWeekHint })}>{Object.entries(weekHints).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button type="button" className={secondaryButton} aria-pressed={activeId === entry.id} onClick={() => { photoDialog.current?.close(); setActiveId(entry.id) }}>{activeId === entry.id ? 'Фото вибрано' : 'Перегляд і обрізання'}</button></div> : parsed?.workbook && <fieldset className="mt-3 space-y-2"><legend className="mb-1 text-xs font-medium">Оберіть листи для розпізнавання</legend>{parsed.workbook.sheets.map((sheet) => <label key={sheet.name} className="flex min-w-0 cursor-pointer items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={entry.selectedSheets.includes(sheet.name)} disabled={!entry.selectedSheets.includes(sheet.name) && selectedSourceCount >= TIMETABLE_RECOGNITION_MAX_SOURCES} onChange={(event) => changeSheet(entry, sheet.name, event.target.checked)} /><span className="min-w-0 break-words">{sheet.name}<span className="ml-1 text-xs text-muted-foreground">({sheet.table_text.length.toLocaleString('uk-UA')} символів)</span></span></label>)}{!entry.selectedSheets.length && <p className="text-xs text-muted-foreground">Жоден лист не вибрано. Вміст листа не надсилатиметься, доки ви його не позначите.</p>}</fieldset>}
        {entry.kind === 'spreadsheet' && <button type="button" className={secondaryButton + ' mt-3'} aria-pressed={activeId === entry.id} onClick={() => { photoDialog.current?.close(); setActiveId(entry.id) }}>{activeId === entry.id ? 'Уточнення таблиці відкрито' : 'Уточнити групи й поділ таблиці'}</button>}
        {(photo?.error || parsed?.error) && <p className="mt-2 text-xs text-destructive">{photo?.error || parsed?.error}</p>}
      </li>
    })}</ul>}
    {activePhoto && <div className="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div>{(preparedImage || photoUrl) && <button type="button" onClick={() => photoDialog.current?.showModal()} aria-label="Збільшити обране фото розкладу" className="block w-full rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><img src={preparedImage || photoUrl} alt={preparedImage ? 'Підготовлене фото розкладу' : 'Обране фото розкладу'} className="max-h-80 w-full rounded-xl border border-border bg-background object-contain" /></button>}<p className="mt-1 text-xs text-muted-foreground">Натисніть на фото, щоб збільшити.{!preparedImage && !activePrepared?.error ? ' Готуємо перегляд…' : ''}</p></div>
      <div className="min-w-0"><p className="break-words text-sm font-medium">{activePhoto.file.name}</p>
        <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={secondaryButton} onClick={() => changePhoto(activePhoto.id, { rotation: ((activePhoto.rotation + 90) % 360) as PhotoEntry['rotation'] })}><RotateCw size={15} aria-hidden="true" />Повернути на 90°</button><button type="button" className={secondaryButton} aria-expanded={activePhoto.cropEnabled} aria-controls={inputId + '-crop'} onClick={() => changePhoto(activePhoto.id, { cropEnabled: !activePhoto.cropEnabled, crop: { ...fullCrop } })}><Crop size={15} aria-hidden="true" />{activePhoto.cropEnabled ? 'Скасувати обрізання' : 'Обрізати фото'}</button></div>
        {activePhoto.cropEnabled && <fieldset id={inputId + '-crop'} className="mt-3 rounded-xl border border-border p-3"><legend className="px-1 text-xs font-medium">Межі області, % від оригіналу</legend><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['left', 'top', 'right', 'bottom'] as const).map((side) => <label key={side} className="min-w-0 text-xs text-muted-foreground">{{ left: 'Ліва', top: 'Верхня', right: 'Права', bottom: 'Нижня' }[side]}<input type="number" min="0" max="100" step="1" className={fieldClass} value={activePhoto.crop[side]} onChange={(event) => changePhoto(activePhoto.id, { crop: { ...activePhoto.crop, [side]: event.target.value === '' ? 0 : Number(event.target.value) } })} /></label>)}</div><p className="mt-2 text-xs text-muted-foreground">Залиште підписи групи, курсу, дні й час пар. Ліворуч — результат підготовки.</p></fieldset>}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Для дрібного тексту краще додати кілька ближчих знімків із заголовками або оригінал XLSX. Фото пакета готуються в межах 3 МБ разом; вибрані таблиці — до 180 000 символів.</p>
      </div>
    </div>}
    {activeEntry && <div ref={layoutPanel} tabIndex={-1} className="mt-4 scroll-mt-24 outline-none"><p className="mb-2 break-words text-xs text-muted-foreground">Уточнення: {activeEntry.file.name}{activeEntry.kind === 'spreadsheet' ? ' · для вибраних листів цього файлу' : ''}</p><SourceLayoutFields value={activeEntry.layoutHint} onChange={value => changeLayout(activeEntry.id, value)} /><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Якщо назви груп обрізано, укажіть свій стовпець. Якщо значення поділу невідоме, залиште автоматичне визначення — ШІ поставить уточнювальне запитання. Після зміни цих пояснень потрібно заново натиснути «Знайти групи у файлах».</p></div>}
    {entries.length > 0 && <div className="mt-4 space-y-2">
      <p className="text-xs text-muted-foreground">Вибрано джерел: {selectedSourceCount} / {TIMETABLE_RECOGNITION_MAX_SOURCES}. Кожен позначений лист рахується окремо.</p>
      <p id={inputId + '-disclosure'} className="text-xs leading-relaxed text-muted-foreground">Фото й вибрані листи буде передано OpenAI після натискання кнопки. Результат спочатку з’явиться для перевірки й не збережеться автоматично.</p>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={!availability?.available || Boolean(busy) || googleSheetLoading || preparing || !bundle.value} aria-describedby={inputId + '-disclosure'} onClick={() => void analyze()} className={primaryButton}>{busy === 'analyze' || preparing ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanText size={16} aria-hidden="true" />}{preparing ? 'Готуємо джерела…' : busy === 'analyze' ? 'Шукаємо групи…' : analysis ? 'Знайти групи ще раз' : 'Знайти групи у файлах'}</button>{busy && <button type="button" className={secondaryButton} onClick={cancel}>Скасувати</button>}{preparationFailed && <button type="button" className={secondaryButton} onClick={retryPreparation}>Підготувати файли ще раз</button>}</div>
    </div>}
    {!availability && !availabilityError && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Перевіряємо доступність розпізнавання…</p>}
    {availability && !availability.available && <p role="status" className="mt-3 rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">Розпізнавання ще не підключено.{availability.reason && <span className="mt-1 block text-xs">{availability.reason}</span>}<span className="mt-1 block text-xs">Таблицю нижче можна заповнити вручну або вставити з Excel.</span></p>}
    {availabilityError && <div role="alert" className="mt-3 text-sm text-destructive"><p>{availabilityError}</p><button type="button" className={secondaryButton + ' mt-2 text-foreground'} onClick={() => setStatusRefresh((current) => current + 1)}>Перевірити ще раз</button></div>}
    {(error || bundle.error) && <p role="alert" className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error || bundle.error}</p>}
    {busy && <p role="status" className="mt-3 text-xs text-muted-foreground">{busy === 'analyze' ? 'Визначаємо групи та курси у вибраних джерелах.' : 'Читаємо заняття лише для обраної групи.'} Це може зайняти до двох хвилин. Розклад ще не змінюється.</p>}
    {analysis && <div className="mt-5 space-y-3 rounded-xl border border-border bg-background p-3 sm:p-4">
      <h4 className="text-sm font-semibold">{analysis.clarifications?.length ? '1. Уточніть структуру розкладу' : '1. Оберіть знайдений розклад'}</h4>
      {analysis.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{analysis.warnings.map((warning, index) => <li key={String(index) + ':' + warning}>{warning}</li>)}</ul>}
      {Boolean(analysis.clarifications?.length) && <div role="status" className="space-y-3 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><p className="text-sm font-semibold">Спочатку уточніть розклад</p><p className="text-xs leading-relaxed">Щоб не змішати групи або тижні, заповніть пояснення до зазначеного джерела й повторіть пошук. Поки що заняття не імпортуються.</p><ul className="space-y-3">{analysis.clarifications?.map((question, index) => {
        const entry = packageSourceEntries[question.source_index - 1]
        return <li key={`${question.source_index}:${question.kind}:${index}`} className="text-xs"><p className="font-medium">{bundle.value?.sources[question.source_index - 1]?.name || `Джерело ${question.source_index}`}</p><p className="mt-1 leading-relaxed">{question.question}</p>{entry && <button type="button" className={secondaryButton + ' mt-2'} onClick={() => { photoDialog.current?.close(); setActiveId(entry.id); layoutPanel.current?.focus(); layoutPanel.current?.scrollIntoView({ block: 'center' }) }}>Уточнити це джерело</button>}</li>
      })}</ul></div>}
      {analysis.layout === 'unreadable' ? <p className="text-sm text-muted-foreground">{analysis.clarifications?.length ? 'Після уточнення знову натисніть «Знайти групи у файлах». Поточний розклад залишається без змін.' : 'Не вдалося надійно визначити розклад. Залиште потрібну таблицю із заголовками, додайте чіткіший знімок або перевірте вибрані листи.'}</p> : <>
        {analysis.layout === 'multiple' ? <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium">Рівень освіти у джерелах<select className={fieldClass} value={levelFilter} disabled={Boolean(busy)} onChange={(event) => { cancel(); clearResult(); setSelectedId(''); setLevelFilter(event.target.value) }}><option value="">Усі рівні</option>{levelOptions.map((level) => <option key={level ?? 'unknown'} value={level ?? 'unknown'}>{level ? levelNames[level] : 'Рівень не вказано'}</option>)}</select></label><label className="text-xs font-medium">Курс у джерелах<select className={fieldClass} value={courseFilter} disabled={Boolean(busy)} onChange={(event) => { cancel(); clearResult(); setSelectedId(''); setCourseFilter(event.target.value) }}><option value="">Усі курси</option>{courseOptions.map((course) => <option key={course ?? 'unknown'} value={course ?? 'unknown'}>{course ? String(course) + ' курс' : 'Курс не вказано'}</option>)}</select></label><label className="min-w-0 text-xs font-medium sm:col-span-2">Група та освітня програма<select className={fieldClass} value={selectedId} disabled={Boolean(busy)} onChange={(event) => chooseSource(event.target.value)}><option value="">Оберіть потрібну групу</option>{visibleCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{sourceLabel(candidate)}</option>)}</select></label></div> : selected && <p className="text-sm"><span className="text-muted-foreground">Знайдено: </span><strong className="font-medium">{sourceLabel(selected)}</strong></p>}
        <p className="text-xs text-muted-foreground">Однакові назви груп можуть бути на різних курсах. Перевірте освітню програму, рівень освіти й підпис блоку.</p>
        {sourceDiffers && <p className="flex items-start gap-2 rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><TriangleAlert size={16} className="shrink-0" aria-hidden="true" />Підпис обраного розкладу відрізняється від групи призначення «{destination}». Переконайтеся, що обрали правильний стовпець.</p>}
        {unknownSourceFields.length > 0 && <p className="rounded-xl border border-border p-3 text-xs text-muted-foreground">У джерелах не визначено {unknownSourceFields.join(', ')}. Переконайтеся, що це розклад вашої групи; ці дані не будуть вгадуватися.</p>}
        <button type="button" disabled={!selected || Boolean(busy) || googleSheetLoading || !bundle.value || preparing || !availability?.available} className={primaryButton} onClick={() => void recognize()}>{busy === 'extract' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ScanText size={16} aria-hidden="true" />}{busy === 'extract' ? 'Розпізнаємо заняття…' : 'Розпізнати обраний розклад'}</button>
      </>}
    </div>}
    {result && selected && resultOwner.current === identity && <div className="mt-5 space-y-3 border-t border-primary/15 pt-4">
      <div><h4 className="text-sm font-semibold">2. Перевірте результат</h4><p className="mt-1 text-xs text-muted-foreground">Із джерел: {sourceLabel(selected)}<br />До групи: {destination}</p></div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{result.lessons.length}</strong>занять</div><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{reviewCount}</strong>перевірити</div><div className="rounded-xl border border-border bg-background p-2"><strong className="block text-lg">{missingTimeCount}</strong>пар без часу</div></div>
      <p className="text-xs leading-relaxed text-muted-foreground">ШІ може помилятися навіть без позначок. Звірте всі заняття з фото або таблицею перед додаванням.</p>
      <p className="text-xs text-muted-foreground">{result.week_mode === 'every' ? 'Розклад повторюється щотижня.' : result.week_mode === 'alternating' ? 'Розпізнано верхній і нижній тижні.' : `Розпізнано лише ${result.week_mode === 'upper_only' ? 'верхній' : 'нижній'} тиждень; інший залишиться без змін.`}</p>
      {(Boolean(result.warnings.length) || reviewCount > 0 || missingTimeCount > 0) && <div className="rounded-xl border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"><p className="flex items-center gap-2 font-medium"><TriangleAlert size={16} aria-hidden="true" />Потрібна перевірка</p><ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{result.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}{reviewCount > 0 && <li>Позначених занять: {reviewCount}. У таблиці виправте їх або виключіть з імпорту.</li>}{result.lessons.some((lesson) => lesson.date_note) && <li>Є примітки про дати або кількість пар. Встановіть окремий період цих занять у чернетці.</li>}{missingTimeCount > 0 && <li>Частину часу не вдалося прочитати. Вкажіть його у блоці «Час пар».</li>}</ul></div>}
      <div className="max-h-72 overflow-auto rounded-xl border border-border bg-background"><table className="w-full min-w-[31rem] text-left text-xs"><caption className="sr-only">Заняття, розпізнані для обраної групи</caption><thead className="sticky top-0 bg-muted"><tr><th scope="col" className="p-2.5">День / пара</th><th scope="col" className="p-2.5">Час</th><th scope="col" className="p-2.5">Тиждень</th><th scope="col" className="p-2.5">Предмет</th></tr></thead><tbody>{result.lessons.map((lesson, index) => {
        const slot = result.slots.find((item) => item.number === lesson.lesson_number)
        return <tr key={`${lesson.week_pattern}:${lesson.weekday}:${lesson.lesson_number}:${index}`} className="border-t border-border"><td className="whitespace-nowrap p-2.5 align-top">{days[lesson.weekday - 1]} · {lesson.lesson_number}</td><td className="whitespace-nowrap p-2.5 align-top">{slot?.starts_at || '?'}–{slot?.ends_at || '?'}</td><td className="p-2.5 align-top">{weekNames[lesson.week_pattern]}</td><td className="p-2.5"><span className="font-medium">{lesson.subject || 'Назву не розпізнано'}</span><span className="mt-1 block text-muted-foreground">{LESSON_TYPES[lesson.lesson_type]}{lesson.location ? ` · ${lesson.location}` : ''}</span>{lesson.date_note && <span className="mt-1 block font-medium text-amber-700 dark:text-amber-300">Період: {lesson.date_note}</span>}{(lesson.needs_review || !lesson.subject) && <span className="mt-1 block text-amber-700 dark:text-amber-300">{lesson.review_note || 'Перевірте за фото'}</span>}</td></tr>
      })}</tbody></table></div>
      {!applied && <>
        <fieldset className="rounded-xl border border-border bg-background p-3"><legend className="px-1 text-sm font-medium">3. Вкажіть період імпорту</legend><div className="grid gap-3 sm:grid-cols-3"><label className="min-w-0 text-xs font-medium">Імпортувати з<input type="date" className={fieldClass} value={settings.validFrom} onChange={(event) => changeSettings({ validFrom: event.target.value })} /></label><label className="min-w-0 text-xs font-medium">Імпортувати по<input type="date" className={fieldClass} min={settings.validFrom || undefined} value={settings.validUntil} onChange={(event) => changeSettings({ validUntil: event.target.value })} /></label><label className="min-w-0 text-xs font-medium">Понеділок верхнього тижня<input type="date" className={fieldClass} value={settings.upperMonday} onChange={(event) => changeSettings({ upperMonday: event.target.value })} /></label></div><p className="mt-2 text-xs text-muted-foreground">Дати обираєте ви за навчальним календарем. ШІ їх не встановлює. Для занять із примітками про окремі дати період потрібно додатково уточнити в чернетці.</p>{dateError && <p className="mt-2 text-xs text-destructive">{dateError}</p>}</fieldset>
        {!sourceMatches && <p role="alert" className="text-sm text-destructive">Група у результаті не збігається з обраною у джерелах. Повторіть розпізнавання.</p>}
        {requiresSourceConfirmation && <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-amber-300/50 p-3 text-xs"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={confirmedSource} onChange={(event) => setConfirmedSource(event.target.checked)} /><span>{unlabelledSource ? `Підтверджую: цей розклад без назви групи належить групі «${destination}».` : unknownSourceFields.length > 0 ? `Підтверджую належність розкладу до групи «${destination}», хоча частину підписів не визначено.` : `Перевірив(-ла) підписи: обраний розклад потрібно додати саме до групи «${destination}».`}</span></label>}
        <p className="text-xs text-muted-foreground">{hasDraft ? `Застосування замінить клітинки ${affected} у вашій чернетці та оновить час пар. ` : 'Результат заповнить чернетку для редагування. '}Вказані вами дати застосуються до чернетки. Наявний розклад групи зберігається.</p>
        {hasDraft && <label className="flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={confirmedReplacement} onChange={(event) => setConfirmedReplacement(event.target.checked)} /><span>Замінити відповідні клітинки моєї поточної чернетки.</span></label>}
        <button type="button" disabled={Boolean(dateError) || !result.lessons.length || !sourceMatches || (requiresSourceConfirmation && !confirmedSource) || (hasDraft && !confirmedReplacement)} className={primaryButton} onClick={apply}><Check size={16} aria-hidden="true" />Перенести в чернетку</button>
      </>}
      {applied && <p role="status" className="flex items-center gap-2 text-sm font-medium text-primary"><Check size={16} aria-hidden="true" />Перенесено в чернетку нижче. Перевірте її перед додаванням.</p>}
    </div>}
    <dialog ref={photoDialog} aria-label="Перегляд фото для розпізнавання" className="m-auto max-h-[90dvh] w-[96vw] max-w-6xl rounded-2xl border border-border bg-background p-3 text-foreground shadow-xl backdrop:bg-black/80 sm:p-5" onKeyDown={(event) => event.stopPropagation()} onMouseDown={(event) => { if (event.target === event.currentTarget) photoDialog.current?.close() }}>
      <div className="sticky top-0 z-10 mb-3 flex items-center justify-between gap-3 bg-background"><p className="text-sm font-medium">Фото для розпізнавання</p><button type="button" autoFocus onClick={() => photoDialog.current?.close()} aria-label="Закрити перегляд фото" className={secondaryButton}><X size={17} aria-hidden="true" />Закрити</button></div>
      {(preparedImage || photoUrl) && <div className="overflow-auto rounded-xl bg-white"><img src={preparedImage || photoUrl} alt="Збільшене фото розкладу для перевірки" className="mx-auto h-auto w-auto max-w-none" /></div>}
    </dialog>
  </section>
}
