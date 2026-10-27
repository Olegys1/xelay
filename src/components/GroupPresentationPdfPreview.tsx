import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { TeachingButton } from './teaching/TeachingUI'

/** Renders the shared PDF locally. No Office/Google viewer receives the private file. */
export function GroupPresentationPdfPreview({ url, name }: { url: string; name: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true), [rendering, setRendering] = useState(false), [error, setError] = useState(''), [width, setWidth] = useState(650)
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const measure = () => setWidth(Math.max(220, Math.min(1000, element.clientWidth - 20)))
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let current = true, task: PDFDocumentLoadingTask | undefined
    const controller = new AbortController()
    setPdf(null); setPage(1); setError(''); setLoading(true)
    void (async () => {
      const [response, pdfjs] = await Promise.all([fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }), import('pdfjs-dist')])
      if (!response.ok) throw new Error('PDF недоступний. Закрийте перегляд та відкрийте файл ще раз.')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('PDF завеликий для перегляду.')
      if (!current) return
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      const options = { data: bytes, isEvalSupported: false, enableXfa: false, useWorkerFetch: false, useWasm: false, useSystemFonts: true, stopAtErrors: true }
      task = pdfjs.getDocument(options)
      task.onPassword = () => { if (current) setError('PDF захищено паролем. Попросіть автора додати відкриту копію.'); void task?.destroy().catch(() => {}) }
      const document = await task.promise
      if (current) setPdf(document)
    })().catch(reason => { if (current && !controller.signal.aborted) setError(reason instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(reason.message) ? reason.message : 'Не вдалося відкрити PDF. Спробуйте завантажити оригінал.') }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; controller.abort(); void task?.destroy().catch(() => {}) }
  }, [url])
  useEffect(() => {
    const target = canvas.current
    if (!pdf || !target) return
    let current = true, task: RenderTask | undefined
    setRendering(true)
    void (async () => {
      const source = await pdf.getPage(page)
      if (!current) return
      const base = source.getViewport({ scale: 1 })
      if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) throw new Error('Некоректний PDF.')
      const viewport = source.getViewport({ scale: width / base.width })
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)))
      target.width = Math.max(1, Math.floor(viewport.width * ratio)); target.height = Math.max(1, Math.floor(viewport.height * ratio))
      target.style.width = `${viewport.width}px`; target.style.height = `${viewport.height}px`
      task = source.render({ canvas: target, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0], background: '#fff' })
      await task.promise
    })().catch(() => { if (current) setError('Не вдалося показати сторінку. Спробуйте завантажити оригінал.') }).finally(() => { if (current) setRendering(false) })
    return () => { current = false; task?.cancel() }
  }, [pdf, page, width])
  return <div className="space-y-3">{pdf && <div className="flex flex-wrap items-center justify-between gap-2"><TeachingButton disabled={rendering || page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} />Назад</TeachingButton><span className="text-xs tabular-nums">Сторінка {page} з {pdf.numPages}</span><TeachingButton disabled={rendering || page >= pdf.numPages} onClick={() => setPage(value => value + 1)}>Далі<ChevronRight size={15} /></TeachingButton></div>}{(loading || rendering) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />Відкриваємо презентацію…</p>}{error && <p role="alert" className="teaching-error">{error}</p>}<div ref={container} className="max-h-[65dvh] min-h-48 overflow-auto rounded-xl border border-border bg-muted/30 p-2"><canvas ref={canvas} role="img" aria-label={`Презентація: ${name}`} className="mx-auto block bg-white" /></div></div>
}
