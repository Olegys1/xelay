import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { Link2 } from 'lucide-react'
import { MAX_TEST_FORMULA_LENGTH, splitTeachingTestContent, teachingTestFormulaFromTextPaste, teachingTestLink, wrapTeachingTestFormula } from '../../lib/teachingTestContent'
import { readTeachingWordEquations } from '../../lib/teachingTestWordMath'
import { TeachingTestContent } from './TeachingTestContent'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

const raster = /^image\/(?:png|jpeg|webp)$/i

function pastedImages(clipboard: DataTransfer, equation: boolean): File[] {
  const direct = Array.from(clipboard.files).filter(file => raster.test(file.type))
  if (direct.length) return direct
  const items = Array.from(clipboard.items).filter(item => item.kind === 'file' && raster.test(item.type))
    .map(item => item.getAsFile()).filter((file): file is File => Boolean(file))
  if (items.length || !equation) return items
  // Word sometimes provides a raster fallback as an embedded data URL.
  // Read bytes from the clipboard only, never load a remote or file URL.
  const html = clipboard.getData('text/html')
  if (html.length > 17_000_000) return []
  const embedded = html.match(/<img\b[^<>]{0,4096}\bsrc\s*=\s*["']data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\r\n]+)["']/i)
  if (!embedded) return []
  try {
    const bytes = Uint8Array.from(atob(embedded[2]), character => character.charCodeAt(0))
    return bytes.length <= 12 * 1024 * 1024 ? [new File([bytes], 'word-formula', { type: embedded[1] })] : []
  } catch {
    return []
  }
}

type Props = {
  value: string
  onChange: (value: string) => void
  label: string
  hint?: string
  multiline?: boolean
  required?: boolean
  maxLength: number
  onImagePaste?: (files: File[]) => void
}

export function TeachingTestRichField({ value, onChange, label, hint, multiline, required, maxLength, onImagePaste }: Props) {
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const cursor = useRef<number | null>(null)
  const [tool, setTool] = useState<'formula' | 'link' | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState('')
  const preview = useMemo(() => splitTeachingTestContent(value).some(part => part.kind !== 'text'), [value])
  const inserted = tool === 'formula' ? wrapTeachingTestFormula(draft) : teachingTestLink(draft.trim())

  useEffect(() => {
    if (cursor.current === null || !field.current) return
    field.current.focus()
    field.current.setSelectionRange(cursor.current, cursor.current)
    cursor.current = null
  }, [value, tool])

  function insert(content: string, separate = false) {
    const start = field.current?.selectionStart ?? value.length
    const end = field.current?.selectionEnd ?? start
    const before = value.slice(0, start)
    const after = value.slice(end)
    const text = `${separate && before && !/\s$/.test(before) ? ' ' : ''}${content}${separate && after && !/^\s/.test(after) ? ' ' : ''}`
    if (before.length + text.length + after.length > maxLength) {
      setMessage(`У цьому полі можна зберегти до ${maxLength} символів.`)
      return false
    }
    cursor.current = before.length + text.length
    onChange(before + text + after)
    setMessage('')
    return true
  }

  function paste(event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const equations = readTeachingWordEquations(event.clipboardData)
    if (equations.formulas.length) {
      event.preventDefault()
      insert(equations.formulas.join(' '))
      return
    }
    if (onImagePaste) {
      const files = pastedImages(event.clipboardData, equations.recognized)
      if (files.length) {
        event.preventDefault()
        setMessage(equations.recognized ? 'Вставляємо формулу як зображення.' : '')
        onImagePaste(files)
        return
      }
    }
    if (equations.recognized) {
      event.preventDefault()
      setMessage('Цю формулу Word не вдалося прочитати. Скопіюйте її як фото або вставте LaTeX через «Формула».')
      return
    }
    const text = event.clipboardData.getData('text/plain').trim()
    if (teachingTestLink(text)) {
      event.preventDefault()
      insert(text, true)
      return
    }
    const formula = teachingTestFormulaFromTextPaste(text)
    if (formula) {
      event.preventDefault()
      insert(formula)
    }
  }

  const attributes = {
    className: teachingInput, maxLength, required, value, onPaste: paste,
    onChange: (event: { target: { value: string } }) => { onChange(event.target.value); setMessage('') },
  }

  return <div className="teaching-test-rich-field">
    {multiline
      ? <TeachingField label={label} hint={hint}><textarea {...attributes} rows={3} ref={element => { field.current = element }} /></TeachingField>
      : <input {...attributes} aria-label={label} ref={element => { field.current = element }} />}
    <div className="teaching-test-rich-tools" aria-label={`Вставка · ${label}`}>
      <TeachingButton onClick={() => { setTool(tool === 'link' ? null : 'link'); setDraft(''); setMessage('') }}><Link2 size={14} aria-hidden="true" />Посилання</TeachingButton>
      <TeachingButton onClick={() => { setTool(tool === 'formula' ? null : 'formula'); setDraft(''); setMessage('') }}><span aria-hidden="true">∑</span>Формула</TeachingButton>
    </div>
    {tool && <div className="teaching-test-rich-insert">
      <TeachingField label={tool === 'formula' ? 'Формула LaTeX' : 'Адреса посилання'} hint={tool === 'formula' ? 'Наприклад, \\frac{1}{2}. Формулу з Word можна вставити прямо в поле через Ctrl+V.' : 'Можна також вставити адресу прямо в текст через Ctrl+V.'}>
        <input className={teachingInput} value={draft} maxLength={tool === 'formula' ? MAX_TEST_FORMULA_LENGTH : maxLength}
          inputMode={tool === 'link' ? 'url' : 'text'} onChange={event => setDraft(event.target.value)}
          onPaste={event => {
            if (tool !== 'formula') return
            const equations = readTeachingWordEquations(event.clipboardData)
            if (equations.formulas.length !== 1) return
            event.preventDefault()
            setDraft(equations.formulas[0].slice(2, -2))
          }} />
      </TeachingField>
      {tool === 'formula' && inserted && <div className="teaching-test-rich-preview"><small>Перегляд формули</small><TeachingTestContent text={inserted} /></div>}
      <div className="teaching-test-rich-insert-actions">
        <TeachingButton disabled={!inserted} onClick={() => { if (inserted && insert(inserted, tool === 'link')) setTool(null) }}>Вставити {tool === 'link' ? 'посилання' : 'формулу'}</TeachingButton>
        <TeachingButton onClick={() => setTool(null)}>Закрити</TeachingButton>
      </div>
    </div>}
    {preview && <div className="teaching-test-rich-preview"><small>Як побачить студент</small><TeachingTestContent text={value} /></div>}
    {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
  </div>
}
