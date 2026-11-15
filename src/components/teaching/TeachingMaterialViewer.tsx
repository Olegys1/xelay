import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Maximize, Minimize, Minus, Plus } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { TeachingFile, TeachingPublication, TeachingRepository } from '../../lib/teaching'
import { TEACHING_MATERIAL_CHUNK_BYTES, TEACHING_MATERIAL_MAX_PAGES, type TeachingMaterialFileInfo } from '../../lib/teachingMaterialPreview'
import { PROFILE_NAME_MAX_LENGTH } from '../../lib/profileNames'
import { TeachingButton, TeachingModal } from './TeachingUI'
import { teachingMaterialFitScale } from '../../lib/teachingMaterialFullscreen'
import { useTeachingMaterialFullscreen } from './useTeachingMaterialFullscreen'
import './teaching-material-viewer.css'

type Props = { publication: TeachingPublication; repository: TeachingRepository; file: TeachingFile; onClose: () => void }
const TEXT_SEGMENT_BYTES = 512 * 1024
const MAX_CANVAS_PIXELS = 16_000_000

function viewError(error: unknown) {
  if (error instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(error.message)) return error.message
  return 'Не вдалося відкрити матеріал. Оновіть список або попросіть викладача перевірити файл.'
}

function watermark(canvas: HTMLCanvasElement, info: TeachingMaterialFileInfo) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Не вдалося нанести водяний знак на матеріал.')
  const viewer = [...(info.viewer_name.trim() || 'Учасник групи')].slice(0, PROFILE_NAME_MAX_LENGTH)
  const author = [...(info.author_name.trim() || 'Викладач')].slice(0, 160 - viewer.length - 3)
  const label = `${viewer.join('')} · ${author.join('')}`
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
  const [height, setHeight] = useState(600)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')
  const [rasterPage, setRasterPage] = useState<{ info: TeachingMaterialFileInfo; page: number; bitmap: ImageBitmap } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const controller = useRef<AbortController | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  const fullscreen = useTeachingMaterialFullscreen(surface, fullscreenButton)
  const renderQueue = useRef<Promise<void>>(Promise.resolve())
  const availableHeight = fullscreen.expanded ? height : null
  const currentInfo = info && info.item_id === publication.id && info.storage_path === file.storage_path && info.version === publication.version ? info : null
  const sourceInfo = currentInfo?.render_mode === 'source' && currentInfo.download_allowed === true ? currentInfo : null
  const rasterInfo = currentInfo?.render_mode === 'raster' && currentInfo.download_allowed === false ? currentInfo : null
  const rasterBitmap = rasterInfo && rasterPage?.info === rasterInfo && rasterPage.page === page ? rasterPage.bitmap : null
  const canvasImage = rasterInfo ? rasterBitmap : sourceInfo ? image : null
  const pdfDocument = sourceInfo ? document : null
  const sourceText = sourceInfo?.preview_kind === 'text' ? sourceInfo : null
  const busy = loading || rendering || Boolean(rasterInfo && !rasterBitmap && !error)
  const restrictCanvas = !sourceInfo

  useEffect(() => {
    const node = container.current
    if (!node) return
    const measure = () => {
      setWidth(Math.max(120, Math.min(fullscreen.expanded ? Infinity : 1100, node.clientWidth - 16)))
      setHeight(Math.max(80, node.clientHeight - 16))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [fullscreen.expanded])

  useEffect(() => {
    const cancellation = new AbortController()
    controller.current = cancellation
    let task: PDFDocumentLoadingTask | undefined
    let bitmap: ImageBitmap | undefined
    let fileSize = 0
    setInfo(null); setDocument(null); setImage(null); setRasterPage(null); setPage(1); setSegment(0); setText(''); setError(''); setLoading(true)
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
      if (metadata.item_id !== publication.id || metadata.storage_path !== file.storage_path || metadata.version !== publication.version) {
        throw new Error('Матеріал змінився. Оновіть список і відкрийте файл ще раз.')
      }
      if (metadata.render_mode === 'raster' && metadata.download_allowed === false
        && Number.isSafeInteger(metadata.page_count) && metadata.page_count >= 1 && metadata.page_count <= TEACHING_MATERIAL_MAX_PAGES) {
        setInfo(metadata)
        return
      }
      if (metadata.render_mode !== 'source' || metadata.download_allowed !== true || metadata.page_count !== undefined) {
        throw new Error('Не вдалося підтвердити режим перегляду матеріалу.')
      }
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
    if (!target || !currentInfo || sourceText || !pdfDocument && !canvasImage) return
    let stopped = false
    let render: RenderTask | undefined
    target.removeAttribute('data-material-painted')
    setRendering(true)
    const previousRender = renderQueue.current
    const currentRender = (async () => {
      await previousRender
      if (stopped) return
      if (pdfDocument) {
        const pdfPage = await pdfDocument.getPage(page)
        if (stopped) return
        const base = pdfPage.getViewport({ scale: 1 })
        if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('Некоректний розмір сторінки PDF.')
        const viewport = pdfPage.getViewport({ scale: teachingMaterialFitScale(base.width, base.height, width, availableHeight, zoom) })
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)))
        target.width = Math.max(1, Math.floor(viewport.width * ratio))
        target.height = Math.max(1, Math.floor(viewport.height * ratio))
        target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
        render = pdfPage.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], background: '#ffffff' })
        await render.promise
      } else if (canvasImage) {
        const scale = teachingMaterialFitScale(canvasImage.width, canvasImage.height, Math.min(width, canvasImage.width), availableHeight === null ? null : Math.min(availableHeight, canvasImage.height), zoom)
        const displayWidth = canvasImage.width * scale
        const displayHeight = canvasImage.height * scale
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_CANVAS_PIXELS / (displayWidth * displayHeight)))
        target.width = Math.max(1, Math.floor(displayWidth * ratio)); target.height = Math.max(1, Math.floor(displayHeight * ratio))
        target.style.width = `${displayWidth}px`; target.style.height = `${displayHeight}px`
        const context = target.getContext('2d')
        if (!context) throw new Error('Перегляд зображення недоступний у цьому браузері.')
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, target.width, target.height)
        context.drawImage(canvasImage, 0, 0, target.width, target.height)
      }
      if (!stopped) {
        if (!rasterInfo) watermark(target, currentInfo)
        target.setAttribute('data-material-painted', 'true')
      }
    })()
    renderQueue.current = currentRender.catch(() => {})
    void currentRender.catch(failure => { if (!stopped) setError(viewError(failure)) })
      .finally(() => { if (!stopped) setRendering(false) })
    return () => {
      stopped = true
      target.removeAttribute('data-material-painted')
      render?.cancel()
    }
  }, [pdfDocument, canvasImage, currentInfo, rasterInfo, sourceText, page, width, availableHeight, zoom])

  useEffect(() => {
    if (!rasterInfo) return
    const cancellation = new AbortController()
    const outer = controller.current?.signal
    const abort = () => cancellation.abort()
    if (outer?.aborted) cancellation.abort()
    outer?.addEventListener('abort', abort, { once: true })
    let bitmap: ImageBitmap | undefined
    setRasterPage(null)
    setError('')
    void (async () => {
      cancellation.signal.throwIfAborted()
      if (!Number.isSafeInteger(page) || page < 1 || page > rasterInfo.page_count) throw new Error('Некоректна сторінка матеріалу.')
      const bytes = await repository.materialFilePage(publication, file, page, cancellation.signal)
      cancellation.signal.throwIfAborted()
      const decoded = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }))
      if (cancellation.signal.aborted) { decoded.close(); return }
      if (decoded.width <= 0 || decoded.height <= 0 || decoded.width * decoded.height > MAX_CANVAS_PIXELS) {
        decoded.close()
        throw new Error('Сторінка завелика для перегляду.')
      }
      bitmap = decoded
      setRasterPage({ info: rasterInfo, page, bitmap })
    })().catch(failure => { if (!cancellation.signal.aborted) setError(viewError(failure)) })
    return () => {
      cancellation.abort()
      outer?.removeEventListener('abort', abort)
      bitmap?.close()
    }
  }, [rasterInfo, page, publication.id, publication.version, file.storage_path, repository])

  useEffect(() => {
    if (!sourceText) return
    const cancellation = new AbortController()
    const outer = controller.current
    const abort = () => cancellation.abort()
    if (outer?.signal.aborted) cancellation.abort()
    outer?.signal.addEventListener('abort', abort, { once: true })
    setRendering(true); setText('')
    const offset = segment * TEXT_SEGMENT_BYTES
    const length = Math.min(TEXT_SEGMENT_BYTES, sourceText.size - offset)
    void repository.materialFileChunk(publication, file, offset, length, cancellation.signal).then(bytes => {
      if (!cancellation.signal.aborted) setText(new TextDecoder('utf-8').decode(bytes).replace(/\u0000/g, ''))
    }).catch(failure => { if (!cancellation.signal.aborted) setError(viewError(failure)) })
      .finally(() => { if (!cancellation.signal.aborted) setRendering(false) })
    return () => { cancellation.abort(); outer?.signal.removeEventListener('abort', abort) }
  }, [sourceText, segment, publication.id, publication.version, file.storage_path, repository])

  const textSegments = sourceText ? Math.ceil(sourceText.size / TEXT_SEGMENT_BYTES) : 1
  const pageCount = rasterInfo?.page_count ?? pdfDocument?.numPages ?? 0
  const hasPages = pageCount > 0 || textSegments > 1
  return <TeachingModal title={info?.name || file.name} description="Перегляд на платформі" wide viewport={fullscreen.expanded} className="teaching-material-modal" surfaceRef={surface} onEscape={fullscreen.escape} onClose={() => { fullscreen.leave(); onClose() }} headingActions={<button ref={fullscreenButton} type="button" className="teaching-button teaching-material-fullscreen-button" onClick={fullscreen.toggle} aria-pressed={fullscreen.expanded} aria-label={fullscreen.expanded ? 'Згорнути перегляд' : 'Розгорнути на весь екран'} title={fullscreen.expanded ? 'Згорнути перегляд (Esc)' : 'Розгорнути на весь екран'}>{fullscreen.expanded ? <Minimize size={17} /> : <Maximize size={17} />}<span>{fullscreen.expanded ? 'Згорнути' : 'На весь екран'}</span></button>}>
    <div className="teaching-material-viewer" data-expanded={fullscreen.expanded || undefined}>
      {info && <p className="teaching-material-attribution text-xs leading-relaxed text-muted-foreground">Автор: {info.author_name || 'Викладач'} · Переглядає: {info.viewer_name || 'Учасник групи'}</p>}
      <div className="teaching-material-toolbar flex flex-wrap items-center justify-between gap-3">
        {hasPages ? <div className="flex items-center gap-2">
          <TeachingButton disabled={busy || (pageCount ? page <= 1 : segment <= 0)} onClick={() => pageCount ? setPage(value => Math.max(1, value - 1)) : setSegment(value => Math.max(0, value - 1))}><ChevronLeft size={16} />Назад</TeachingButton>
          <span className="text-xs tabular-nums">{pageCount ? `Сторінка ${page} з ${pageCount}` : `Фрагмент ${segment + 1} з ${textSegments}`}</span>
          <TeachingButton disabled={busy || (pageCount ? page >= pageCount : segment >= textSegments - 1)} onClick={() => pageCount ? setPage(value => Math.min(pageCount, value + 1)) : setSegment(value => Math.min(textSegments - 1, value + 1))}>Далі<ChevronRight size={16} /></TeachingButton>
        </div> : <span />}
        {currentInfo && !sourceText && <div className="flex items-center gap-2">
          <TeachingButton disabled={busy || Boolean(rasterInfo && !rasterBitmap) || zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))} title="Зменшити"><Minus size={16} /></TeachingButton>
          <span className="text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <TeachingButton disabled={busy || Boolean(rasterInfo && !rasterBitmap) || zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.25))} title="Збільшити"><Plus size={16} /></TeachingButton>
        </div>}
      </div>
      {error && <p role="alert" className="teaching-error">{error}</p>}
      <p role="status" aria-live="polite" className="teaching-material-status flex items-center gap-2 text-sm text-muted-foreground">{busy && <><Loader2 size={16} className="animate-spin" /><span className="teaching-material-status-label">Відкриваємо матеріал…</span></>}</p>
      <div ref={container} className="teaching-material-viewport relative min-h-48 max-h-[65dvh] overflow-auto rounded-xl border border-border bg-muted/30 p-2">
        {sourceText ? <div className="relative min-h-48 bg-background p-4">
          <p aria-hidden="true" className="pointer-events-none sticky top-3 z-10 break-words text-right text-xs text-primary/35">{sourceText.author_name} · {sourceText.viewer_name}</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{text}</pre>
        </div> : <canvas
          ref={canvas}
          role="img"
          aria-label={`Матеріал: ${info?.name || file.name}`}
          aria-busy={busy || !currentInfo || Boolean(rasterInfo && !rasterBitmap) || undefined}
          className={`teaching-material-canvas mx-auto block bg-white shadow-sm${restrictCanvas ? ' teaching-material-canvas-restricted' : ''}`}
          draggable={restrictCanvas ? false : undefined}
          onContextMenu={restrictCanvas ? event => event.preventDefault() : undefined}
          onDragStart={restrictCanvas ? event => event.preventDefault() : undefined}
        />}
      </div>
      <p className="teaching-material-disclaimer text-xs leading-relaxed text-muted-foreground">{currentInfo && restrictCanvas ? 'Завантаження оригіналу в цьому перегляді вимкнено.' : 'У цьому перегляді немає кнопок завантаження та друку.'} Технічно можливі скріншоти та збереження даних, які браузер отримує для перегляду.</p>
    </div>
  </TeachingModal>
}
