import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TeachingFile, TeachingPublication, TeachingRepository } from '../../lib/teaching'
import { TEACHING_MATERIAL_CHUNK_BYTES, type TeachingMaterialFileInfo } from '../../lib/teachingMaterialPreview'
import { TeachingButton, TeachingModal } from './TeachingUI'

type Props = { publication: TeachingPublication; repository: TeachingRepository; file: TeachingFile; onClose: () => void }
const TEXT_SEGMENT_BYTES = 512 * 1024
const MAX_CANVAS_PIXELS = 16_000_000

function viewError(error: unknown) {
  if (error instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(error.message)) return error.message
  return 'Не вдалося відкрити матеріал. Оновіть список або попросіть викладача перевірити файл.'
}

function watermark(canvas: HTMLCanvasElement, info: TeachingMaterialFileInfo) {
  const context = canvas.getContext('2d')
  if (!context) return
  const label = `${info.author_name || 'Викладач'} · ${info.viewer_name || 'Учасник групи'}`.slice(0, 160)
  const font = Math.max(12, Math.min(28, canvas.width / 38))
  context.save()
  context.globalAlpha = 0.15
  context.fillStyle = '#1e3a5f'
  context.font = `600 ${font}px sans-serif`
  context.rotate(-Math.PI / 9)
  for (let y = -canvas.width; y < canvas.height * 1.5; y += Math.max(100, font * 8)) {
    for (let x = -canvas.width; x < canvas.width * 1.5; x += Math.max(340, font * 29)) context.fillText(label, x, y)
  }
  context.restore()
}

export function TeachingMaterialViewer({ publication, repository, file, onClose }: Props) {
  const [info, setInfo] = useState<TeachingMaterialFileInfo | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [image, setImage] = useState<ImageBitmap | null>(null)
  const [page, setPage] = useState(1)
  const [segment, setSegment] = useState(0)
  const [text, setText] = useState('')
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(850)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    const node = container.current
    if (!node) return
    const measure = () => setWidth(Math.max(240, Math.min(1100, node.clientWidth - 16)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const cancellation = new AbortController()
    controller.current = cancellation
    let task: PDFDocumentLoadingTask | undefined
    let bitmap: ImageBitmap | undefined
    let fileSize = 0
    setInfo(null); setDocument(null); setImage(null); setPage(1); setSegment(0); setText(''); setError(''); setLoading(true)
    async function readRange(begin: number, end: number) {
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > fileSize) throw new Error('Некоректний фрагмент матеріалу.')
      const output = new Uint8Array(end - begin)
      for (let offset = begin; offset < end; offset += TEACHING_MATERIAL_CHUNK_BYTES) {
        const length = Math.min(TEACHING_MATERIAL_CHUNK_BYTES, end - offset)
        const bytes = new Uint8Array(await repository.materialFileChunk(publication, file, offset, length, cancellation.signal))
        if (bytes.byteLength !== length) throw new Error('Матеріал змінився. Відкрийте файл ще раз.')
        output.set(bytes, offset - begin)
      }
      return output
    }
    void (async () => {
      const metadata = await repository.materialFileInfo(publication, file, cancellation.signal)
      if (cancellation.signal.aborted) return
      if (metadata.version !== publication.version) throw new Error('Матеріал змінився. Оновіть список і відкрийте файл ще раз.')
      fileSize = metadata.size
      setInfo(metadata)
      if (metadata.preview_kind === 'pdf') {
        const pdfjs = await import('pdfjs-dist')
        if (cancellation.signal.aborted) return
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const initial = await readRange(0, Math.min(65_536, metadata.size))
        const transport = new pdfjs.PDFDataRangeTransport(metadata.size, initial, true)
        transport.abort = () => cancellation.abort()
        transport.requestDataRange = (begin, end) => {
          void readRange(begin, end).then(bytes => {
            if (!cancellation.signal.aborted) transport.onDataRange(begin, bytes)
          }).catch(failure => {
            if (cancellation.signal.aborted) return
            setError(viewError(failure)); setLoading(false)
            void task?.destroy().catch(() => {})
          })
        }
        const pdfOptions = { range: transport, rangeChunkSize: TEACHING_MATERIAL_CHUNK_BYTES,
          disableAutoFetch: true, disableStream: true, useWorkerFetch: false, useWasm: false,
          isEvalSupported: false, enableXfa: false, useSystemFonts: true, stopAtErrors: true }
        task = pdfjs.getDocument(pdfOptions)
        task.onPassword = () => { setError('Цей PDF захищено паролем. Попросіть викладача додати версію для перегляду.'); void task?.destroy().catch(() => {}) }
        const pdf = await task.promise
        if (!cancellation.signal.aborted) setDocument(pdf)
      } else if (metadata.preview_kind === 'image') {
        const bytes = await readRange(0, metadata.size)
        bitmap = await createImageBitmap(new Blob([bytes], { type: metadata.mime_type }))
        if (cancellation.signal.aborted) { bitmap.close(); bitmap = undefined; return }
        if (bitmap.width * bitmap.height > 32_000_000) {
          bitmap.close(); bitmap = undefined
          throw new Error('Зображення завелике для перегляду. Попросіть викладача додати меншу версію.')
        }
        setImage(bitmap)
      }
    })().catch(failure => { if (!cancellation.signal.aborted) setError(viewError(failure)) })
      .finally(() => { if (!cancellation.signal.aborted) setLoading(false) })
    return () => {
      cancellation.abort()
      if (controller.current === cancellation) controller.current = null
      void task?.destroy().catch(() => {})
      bitmap?.close()
    }
  }, [publication.id, publication.version, file.storage_path, repository])

  useEffect(() => {
    const target = canvas.current
    if (!target || !info || info.preview_kind === 'text' || !document && !image) return
    let stopped = false
    let render: RenderTask | undefined
    setRendering(true)
    void (async () => {
      if (document) {
        const pdfPage = await document.getPage(page)
        if (stopped) return
        const base = pdfPage.getViewport({ scale: 1 })
        if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('Некоректний розмір сторінки PDF.')
        const viewport = pdfPage.getViewport({ scale: width / base.width * zoom })
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
        target.width = Math.max(1, Math.floor(viewport.width * ratio))
        target.height = Math.max(1, Math.floor(viewport.height * ratio))
        target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
        render = pdfPage.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' })
        await render.promise
      } else if (image) {
        const displayWidth = Math.min(width, image.width) * zoom
        const displayHeight = image.height / image.width * displayWidth
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (displayWidth * displayHeight)))
        target.width = Math.max(1, Math.floor(displayWidth * ratio)); target.height = Math.max(1, Math.floor(displayHeight * ratio))
        target.style.width = `${displayWidth}px`; target.style.height = `${displayHeight}px`
        const context = target.getContext('2d')
        if (!context) throw new Error('Перегляд зображення недоступний у цьому браузері.')
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, target.width, target.height)
        context.drawImage(image, 0, 0, target.width, target.height)
      }
      if (!stopped) watermark(target, info)
    })().catch(failure => { if (!stopped) setError(viewError(failure)) })
      .finally(() => { if (!stopped) setRendering(false) })
    return () => { stopped = true; render?.cancel() }
  }, [document, image, info, page, width, zoom])

  useEffect(() => {
    if (!info || info.preview_kind !== 'text') return
    const cancellation = new AbortController()
    const outer = controller.current
    const abort = () => cancellation.abort()
    if (outer?.signal.aborted) cancellation.abort()
    outer?.signal.addEventListener('abort', abort, { once: true })
    setRendering(true); setText('')
    const offset = segment * TEXT_SEGMENT_BYTES
    const length = Math.min(TEXT_SEGMENT_BYTES, info.size - offset)
    void repository.materialFileChunk(publication, file, offset, length, cancellation.signal).then(bytes => {
      if (!cancellation.signal.aborted) setText(new TextDecoder('utf-8').decode(bytes).replace(/\u0000/g, ''))
    }).catch(failure => { if (!cancellation.signal.aborted) setError(viewError(failure)) })
      .finally(() => { if (!cancellation.signal.aborted) setRendering(false) })
    return () => { cancellation.abort(); outer?.signal.removeEventListener('abort', abort) }
  }, [info, segment, publication.id, publication.version, file.storage_path, repository])

  const textSegments = info ? Math.ceil(info.size / TEXT_SEGMENT_BYTES) : 1
  const hasPages = Boolean(document || info?.preview_kind === 'text' && textSegments > 1)
  return <TeachingModal title={info?.name || file.name} description="Перегляд на платформі" wide onClose={onClose}>
    <div className="space-y-4">
      {info && <p className="text-xs leading-relaxed text-muted-foreground">Автор: {info.author_name || 'Викладач'} · Переглядає: {info.viewer_name || 'Учасник групи'}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {hasPages ? <div className="flex items-center gap-2">
          <TeachingButton disabled={loading || rendering || (document ? page <= 1 : segment <= 0)} onClick={() => document ? setPage(value => value - 1) : setSegment(value => value - 1)}><ChevronLeft size={16} />Назад</TeachingButton>
          <span className="text-xs tabular-nums">{document ? `Сторінка ${page} з ${document.numPages}` : `Фрагмент ${segment + 1} з ${textSegments}`}</span>
          <TeachingButton disabled={loading || rendering || (document ? page >= document.numPages : segment >= textSegments - 1)} onClick={() => document ? setPage(value => value + 1) : setSegment(value => value + 1)}>Далі<ChevronRight size={16} /></TeachingButton>
        </div> : <span />}
        {info && info.preview_kind !== 'text' && <div className="flex items-center gap-2">
          <TeachingButton disabled={loading || rendering || zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))} title="Зменшити"><Minus size={16} /></TeachingButton>
          <span className="text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <TeachingButton disabled={loading || rendering || zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))} title="Збільшити"><Plus size={16} /></TeachingButton>
        </div>}
      </div>
      {error && <p role="alert" className="teaching-error">{error}</p>}
      {(loading || rendering) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />Відкриваємо матеріал…</p>}
      <div ref={container} className="relative min-h-48 max-h-[65dvh] overflow-auto rounded-xl border border-border bg-muted/30 p-2">
        {info?.preview_kind === 'text' ? <div className="relative min-h-48 bg-background p-4">
          <p aria-hidden="true" className="pointer-events-none sticky top-3 z-10 break-words text-right text-xs text-primary/35">{info.author_name} · {info.viewer_name}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{text}</pre>
        </div> : <canvas ref={canvas} aria-label={`Матеріал: ${info?.name || file.name}`} role="img" className="mx-auto block bg-white shadow-sm" />}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">У цьому перегляді немає кнопок завантаження та друку. Технічно можливі скріншоти та збереження даних, які браузер отримує для перегляду.</p>
    </div>
  </TeachingModal>
}
