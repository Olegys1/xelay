import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Check, Gift, LoaderCircle } from 'lucide-react'
import type { WinterReward } from '../../lib/winterCampaign'
import { WinterGlyph } from './WinterArt'

export const WINTER_SCRATCH_MAX_STEPS = 32
type ScratchPoint = { x: number; y: number }
export function boundedWinterScratchStroke(width: number, height: number, point: ScratchPoint, previous: ScratchPoint | null) {
  if (![width, height, point.x, point.y, previous?.x ?? 0, previous?.y ?? 0].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const clamp = (p: ScratchPoint) => ({ x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) })
  const to = clamp(point), from = previous ? clamp(previous) : to
  return { from, to, steps: Math.min(WINTER_SCRATCH_MAX_STEPS, Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 8))) }
}

export function WinterScratchCard({ reward, opened, available, busy, onOpen }: { reward: WinterReward; opened: boolean; available: boolean; busy: boolean; onOpen: () => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const scratched = useRef(new Set<number>())
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const requesting = useRef(false)
  const [progress, setProgress] = useState(0)
  const [canvasReady, setCanvasReady] = useState(false)
  const [retry, setRetry] = useState(0)
  const open = async () => {
    if (opened || busy || requesting.current || !available) return
    requesting.current = true
    try { await onOpen() } catch { setRetry(value => value + 1) } finally { requesting.current = false }
  }
  useEffect(() => {
    scratched.current.clear(); pointer.current = null; setProgress(0); setCanvasReady(false)
    if (opened || !available || !canvas.current || !surface.current) return
    const target = canvas.current
    const draw = () => {
      const bounds = surface.current?.getBoundingClientRect()
      if (!bounds?.width || !bounds.height) return
      const scale = Math.min(2, window.devicePixelRatio || 1)
      target.width = Math.round(bounds.width * scale); target.height = Math.round(bounds.height * scale)
      const context = target.getContext('2d')
      if (!context) return
      context.scale(scale, scale)
      const gradient = context.createLinearGradient(0, 0, bounds.width, bounds.height)
      gradient.addColorStop(0, '#e7dfd1'); gradient.addColorStop(.45, '#f6efe3'); gradient.addColorStop(1, '#cec7b9')
      context.fillStyle = gradient; context.fillRect(0, 0, bounds.width, bounds.height)
      context.strokeStyle = 'rgba(128, 100, 78, .12)'; context.lineWidth = 1
      for (let x = -bounds.height; x < bounds.width; x += 21) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x + bounds.height, bounds.height); context.stroke() }
      context.fillStyle = '#6f2840'; context.textAlign = 'center'; context.font = '500 15px system-ui, sans-serif'
      context.fillText('Зітріть сніг', bounds.width / 2, bounds.height / 2 - 4)
      context.fillStyle = '#665b56'; context.font = '12px system-ui, sans-serif'
      context.fillText('або відкрийте кнопкою нижче', bounds.width / 2, bounds.height / 2 + 20)
      scratched.current.clear(); setProgress(0); setCanvasReady(true)
    }
    draw()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw)
    observer?.observe(surface.current)
    return () => observer?.disconnect()
  }, [reward.day, opened, available, retry])
  const scratch = (event: PointerEvent<HTMLCanvasElement>, start = false) => {
    if (!available || busy || opened || !canvasReady || (!start && pointer.current?.id !== event.pointerId)) return
    if (start && event.button !== 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const stroke = boundedWinterScratchStroke(bounds.width, bounds.height, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, start ? null : pointer.current)
    if (!stroke) return
    const { from: prior, to: { x, y }, steps } = stroke
    const context = event.currentTarget.getContext('2d')
    if (!context) return
    if (start) { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { id: event.pointerId, x, y } }
    context.globalCompositeOperation = 'destination-out'; context.lineWidth = 42; context.lineCap = 'round'
    context.beginPath(); context.moveTo(prior.x, prior.y); context.lineTo(x, y); context.stroke()
    for (let step = 0; step <= steps; step++) {
      const px = prior.x + (x - prior.x) * step / steps, py = prior.y + (y - prior.y) * step / steps
      for (let row = 0; row < 12; row++) for (let col = 0; col < 20; col++) {
        if (Math.hypot((col + .5) * bounds.width / 20 - px, (row + .5) * bounds.height / 12 - py) < 22) scratched.current.add(row * 20 + col)
      }
    }
    pointer.current = { id: event.pointerId, x, y }
    const next = Math.min(100, Math.round(scratched.current.size / 240 * 100)); setProgress(next)
    if (next >= 32) void open()
  }
  return <div className={`winter-scratch${opened ? ' is-opened' : ''}`} aria-busy={busy}>
    <div className="winter-scratch-surface" ref={surface}>
      <div className="winter-scratch-reward"><WinterGlyph symbol={reward.symbol}/><span>{opened ? reward.name : 'Ваш зимовий подарунок'}</span></div>
      {!opened && available && <canvas ref={canvas} className="winter-scratch-canvas" aria-hidden="true" onPointerDown={event => scratch(event, true)} onPointerMove={event => scratch(event)} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }}/>}
      {!opened && !available && <div className="winter-scratch-locked"><span>{String(reward.day).padStart(2, '0')}</span><small>грудня</small></div>}
      {busy && <div className="winter-scratch-saving" role="status"><LoaderCircle size={22}/><span>Зберігаємо подарунок…</span></div>}
    </div>
    {opened ? <p className="winter-scratch-confirmation"><Check size={16}/>У вашій зимовій колекції</p> : <button type="button" className="winter-primary-button" onClick={() => { void open() }} disabled={!available || busy}><Gift size={17}/>{busy ? 'Зберігаємо…' : 'Відкрити подарунок'}</button>}
    {!opened && available && <span className="winter-visually-hidden" aria-live="polite">{progress >= 20 && progress < 32 ? 'Майже відкрили. Можна продовжити або скористатися кнопкою.' : ''}</span>}
  </div>
}
