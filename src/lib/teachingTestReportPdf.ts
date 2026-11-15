import type { TeachingTestQuestion, TeachingTestQuestionImage } from './teachingTests'
import { plainTeachingTestContent } from './teachingTestContent'
import { loadTeachingTestQuestionImage, readableTeachingTestQuestionImages } from './teachingTestQuestionImages'
import {
  buildTeachingTestReportSheets, formatTeachingTestAnswer, teachingTestCorrectAnswer, teachingTestOptionLabel,
  teachingTestReportDate, teachingTestReportResultStatus, teachingTestVariantLabel, type TeachingTestReportData,
} from './teachingTestReports'

type PdfReport = 'summary-pdf' | 'selected-answers' | 'selected-details'
const margin = 40
const accent = '#802242'
const ink = '#231f22'
const muted = '#5d5660'
const encoder = new TextEncoder()

/** Use the browser's Unicode fonts for Ukrainian and retain pagination in the downloaded PDF. */
export function makeTeachingTestPagePdf(pages: Uint8Array<ArrayBuffer>[], width: number, height: number, landscape: boolean) {
  const paperWidth = landscape ? 842 : 595
  const paperHeight = landscape ? 595 : 842
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const offsets = [0]
  let size = 0
  function write(value: string | Uint8Array<ArrayBuffer>) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    chunks.push(bytes)
    size += bytes.byteLength
  }
  function object(id: number, content: string) {
    offsets[id] = size
    write(`${id} 0 obj\n${content}\nendobj\n`)
  }
  write('%PDF-1.4\n%Xelay\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  for (const [index, jpeg] of pages.entries()) {
    const page = 3 + index * 3
    const operations = `q ${paperWidth} 0 0 ${paperHeight} 0 0 cm /PageImage Do Q\n`
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${paperWidth} ${paperHeight}] /Resources << /XObject << /PageImage ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`)
    object(page + 1, `<< /Length ${operations.length} >>\nstream\n${operations}endstream`)
    offsets[page + 2] = size
    write(`${page + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`)
    write(jpeg)
    write('\nendstream\nendobj\n')
  }
  const xref = size
  write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks, { type: 'application/pdf' })
}

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/u)) {
      const joined = line ? `${line} ${word}` : word
      if (context.measureText(joined).width <= maxWidth) { line = joined; continue }
      if (line) { lines.push(line); line = '' }
      for (const character of word) {
        if (line && context.measureText(line + character).width > maxWidth) { lines.push(line); line = '' }
        line += character
      }
    }
    lines.push(line)
  }
  return lines
}

function selectedImages(question: TeachingTestQuestion, selected: unknown) {
  const ids = Array.isArray(selected) ? selected : [selected]
  return question.options.filter(option => ids.includes(option.id)).flatMap(option => readableTeachingTestQuestionImages(option.images))
}

export async function createTeachingTestReportPdf(format: PdfReport, report: TeachingTestReportData, signal: AbortSignal) {
  const landscape = format === 'summary-pdf'
  const canvas = document.createElement('canvas')
  canvas.width = landscape ? 1240 : 877
  canvas.height = landscape ? 877 : 1240
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('У цьому браузері не вдалося підготувати PDF.')
  const width = canvas.width
  const height = canvas.height
  const contentWidth = width - margin * 2
  const contentBottom = height - 67
  const pages: Uint8Array<ArrayBuffer>[] = []
  const images = new Map<string, string>()
  let y = 0

  function style(size: number, bold = false, color = ink) {
    context!.font = `${bold ? 700 : 400} ${size}px "Segoe UI", Arial, sans-serif`
    context!.fillStyle = color
    context!.textBaseline = 'top'
  }
  function page() {
    signal.throwIfAborted()
    context!.fillStyle = '#fff'
    context!.fillRect(0, 0, width, height)
    context!.fillStyle = accent
    context!.fillRect(margin, margin, 48, 4)
    style(16, true, accent)
    context!.fillText('XELAY · ЗВІТ ТЕСТУ', margin, margin + 14)
    style(25, true)
    const titleLines = wrap(context!, report.title, contentWidth)
    titleLines.forEach((line, index) => context!.fillText(line, margin, margin + 43 + index * 32))
    y = margin + 49 + titleLines.length * 32
    style(13, false, muted)
    const subtitle = `${report.courseTitle} · ${format === 'summary-pdf' ? 'Зведення результатів' : format === 'selected-answers' ? 'Відповіді студентів' : 'Деталі перевірки'} · Час за Києвом`
    const subtitleLines = wrap(context!, subtitle, contentWidth)
    subtitleLines.forEach((line, index) => context!.fillText(line, margin, y + index * 18))
    y += subtitleLines.length * 18 + 20
  }
  function finishPage() {
    if (pages.length >= 300) throw new Error('Звіт перевищує 300 сторінок. Виберіть менше робіт або скористайтеся XLSX.')
    style(12, false, muted)
    context!.fillText('Xelay · Для викладача', margin, height - 42)
    context!.textAlign = 'right'
    context!.fillText(`Сторінка ${pages.length + 1}`, width - margin, height - 42)
    context!.textAlign = 'left'
    const jpeg = canvas.toDataURL('image/jpeg', .82).split(',')[1]
    if (!jpeg) throw new Error('Не вдалося підготувати сторінку PDF.')
    pages.push(Uint8Array.from(atob(jpeg), character => character.charCodeAt(0)))
  }
  function nextPage() { finishPage(); page() }
  function space(required: number) { if (y + required > contentBottom) nextPage() }
  function paragraph(value: string, size = 16, bold = false, color = ink) {
    style(size, bold, color)
    const lines = wrap(context!, value, contentWidth)
    const lineHeight = Math.ceil(size * 1.32)
    for (const line of lines) {
      space(lineHeight)
      style(size, bold, color)
      context!.fillText(line, margin, y)
      y += lineHeight
    }
    y += 5
  }
  async function photos(source: TeachingTestQuestionImage[]) {
    for (const photo of source) {
      signal.throwIfAborted()
      try {
        let url = images.get(photo.id)
        if (!url) {
          url = await loadTeachingTestQuestionImage(photo.id, signal)
          images.set(photo.id, url)
        }
        const image = new Image()
        image.src = url
        await image.decode()
        signal.throwIfAborted()
        const scale = Math.min(contentWidth / image.naturalWidth, 230 / image.naturalHeight, 1)
        const imageHeight = image.naturalHeight * scale
        space(imageHeight + 32)
        context!.drawImage(image, margin, y, image.naturalWidth * scale, imageHeight)
        y += imageHeight + 5
        if (photo.alt) paragraph(photo.alt, 12, false, muted)
        y += 8
      } catch {
        signal.throwIfAborted()
        paragraph(photo.alt ? `Зображення недоступне · ${photo.alt}` : 'Зображення недоступне', 12, false, muted)
      }
    }
  }

  page()
  if (format === 'summary-pdf') {
    const [{ rows }] = buildTeachingTestReportSheets(format, report)
    const widths = [134, 73, 48, 79, 110, 110, 63, 80, 86, 59, 99, 67, 151, 115]
    const total = widths.reduce((sum, value) => sum + value, 0)
    const sizes = widths.map(value => value * contentWidth / total)
    function cells(row: (string | number | null)[], heading: boolean) {
      style(13, heading)
      return row.map((value, index) => wrap(context!, String(value ?? '—'), sizes[index] - 15))
    }
    function tableRow(columns: string[][], background: string, heading = false) {
      const rowHeight = Math.max(...columns.map(column => column.length)) * 17 + 16
      context!.fillStyle = background
      context!.fillRect(margin, y, contentWidth, rowHeight)
      style(13, heading, heading ? '#fff' : ink)
      let x = margin
      columns.forEach((column, index) => {
        column.forEach((line, lineIndex) => context!.fillText(line, x + 7, y + 8 + 17 * lineIndex))
        x += sizes[index]
      })
      y += rowHeight
    }
    const header = cells(rows[0], true)
    tableRow(header, accent, true)
    for (const [index, row] of rows.slice(1).entries()) {
      const columns = cells(row, false)
      if (y + Math.max(...columns.map(column => column.length)) * 17 + 16 > contentBottom) {
        nextPage()
        tableRow(header, accent, true)
      }
      tableRow(columns, index % 2 ? '#f6f2f5' : '#fff')
    }
  } else {
    const detailed = format === 'selected-details'
    for (const [position, attempt] of report.attempts.entries()) {
      if (position) nextPage()
      paragraph(attempt.student_name || 'Учасник групи', 24, true)
      paragraph(`${report.groupNames.get(attempt.group_id) || 'Група'} · Спроба №${attempt.attempt_number || 1} · ${attempt.id.slice(-8).toUpperCase()}`, 14, false, muted)
      paragraph(teachingTestVariantLabel(attempt), 14, false, muted)
      paragraph(`Початок ${teachingTestReportDate(attempt.started_at)} · Здано ${teachingTestReportDate(attempt.submitted_at)}${attempt.elapsed_seconds == null ? '' : ` · ${attempt.elapsed_seconds} с`}`, 14, false, muted)
      const score = report.finalized ? attempt.final_score : attempt.score
      paragraph(`${teachingTestReportResultStatus(attempt, report.finalized, report.personalRetakePublished)} · ${score ?? '—'} із ${report.maxPoints} балів`, 15, true, accent)
      y += 15
      if (!attempt.questions) paragraph('Немає збереженого варіанта цієї спроби.', 16, false, muted)
      for (const [index, question] of (attempt.questions || []).entries()) {
        space(105)
        const answer = attempt.answers[question.id]
        paragraph(`${index + 1}. ${plainTeachingTestContent(question.text)}`, 17, true)
        await photos(readableTeachingTestQuestionImages(question.images))
        if (detailed && question.options.length) {
          paragraph(`Видані варіанти: ${question.options.map(option => teachingTestOptionLabel(question, option.id)).join('\n')}`, 14, false, muted)
        }
        paragraph(`Відповідь: ${formatTeachingTestAnswer(question, answer)}`)
        await photos(selectedImages(question, answer))
        if (detailed) {
          paragraph(`Ключ або оцінювання: ${teachingTestCorrectAnswer(question)}`, 14)
          const result = attempt.question_results?.find(item => item.question_id === question.id)
          paragraph(`Автоматично: ${result?.automatic_points ?? '—'} · За перевіркою: ${question.kind === 'essay' && !result?.manual ? 'Очікує' : result?.points ?? '—'} із ${question.points} · Відкрито: ${teachingTestReportDate(attempt.opened_at?.[question.id])}`, 13, false, muted)
          if (result?.reason) paragraph(`Причина зміни балів: ${result.reason}`, 13, false, muted)
        }
        y += 12
      }
    }
  }
  signal.throwIfAborted()
  finishPage()
  return makeTeachingTestPagePdf(pages, width, height, landscape)
}
