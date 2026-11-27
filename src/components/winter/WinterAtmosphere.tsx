import { useEffect, useRef } from 'react'
import './winterAtmosphere.css'

type SnowParticle = {
  x: number
  y: number
  depth: number
  size: number
  fall: number
  phase: number
  opacity: number
  variant: number
}

/** Decorative only. The caller owns campaign dates, route and preference gating. */
export function WinterAtmosphere({ active = true, layer = 'foreground' }: { active?: boolean; layer?: 'background' | 'foreground' }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!active || !root || !canvas) return
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let alive = true, inView = typeof IntersectionObserver === 'undefined'
    let width = 0, height = 0, ratio = 1, mobile = false
    let frame = 0, lastDraw = 0, elapsed = 8
    let particles: SnowParticle[] = []
    // Small prepainted flakes avoid per-frame blur, gradients, paths and DOM work.
    const sprites = Array.from({ length: 3 }, (_, index) => {
      const sprite = document.createElement('canvas')
      sprite.width = sprite.height = 40
      const paint = sprite.getContext('2d')
      if (!paint) return sprite
      const gradient = paint.createRadialGradient(16, 14, 2, 21, 21, 16)
      gradient.addColorStop(0, '#ffffff')
      gradient.addColorStop(.6, '#f8fdff')
      gradient.addColorStop(1, index === 2 ? '#f4fbff' : '#cce3ed')
      paint.fillStyle = gradient
      // Far flakes need light-page definition; close flakes are out of focus.
      // Blur is baked into this tiny cached bitmap, never applied per frame.
      paint.shadowColor = index === 2 ? 'transparent' : 'rgba(69,108,135,.25)'
      paint.shadowBlur = index === 2 ? 0 : 1.8
      paint.shadowOffsetY = index === 2 ? 0 : 1
      if (index === 2) paint.filter = 'blur(2.2px)'
      paint.beginPath()
      for (let point = 0; point < 7; point++) {
        const angle = point / 7 * Math.PI * 2 + index * .37
        const radius = 10 + Math.sin(point * 4.1 + index) * 2.8
        const x = 20 + Math.cos(angle) * radius
        const y = 20 + Math.sin(angle) * radius * (index === 1 ? .72 : 1)
        if (point === 0) paint.moveTo(x, y)
        else paint.lineTo(x, y)
      }
      paint.closePath()
      paint.fill()
      return sprite
    })

    // Seeded distribution avoids a random flash/re-layout on every React render.
    const random = (seed: number) => {
      const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
      return value - Math.floor(value)
    }
    const seedParticles = () => {
      const background = layer === 'background'
      const count = reducedMotion.matches ? (background ? 18 : 8) : mobile ? (background ? 32 : 12) : background ? Math.min(92, Math.round(width / 13)) : Math.min(28, Math.round(width / 45))
      particles = Array.from({ length: count }, (_, index) => {
        const depth = background ? index % 2 : 2
        const edge = random(index + 29)
        const position = background || index % 7 === 0 ? random(index + 8) : edge < .5 ? edge * .4 : .8 + (edge - .5) * .4
        return {
          x: position * width,
          y: random(index + 71) * height,
          depth,
          size: (depth === 0 ? 3.4 : depth === 1 ? 6 : 12) + random(index + 17) * (depth === 2 ? 7 : 2),
          fall: (depth === 0 ? 21 : depth === 1 ? 43 : 91) + random(index + 53) * 23,
          phase: random(index + 37) * Math.PI * 2,
          opacity: depth === 0 ? .52 : depth === 1 ? .82 : .64,
          variant: depth,
        }
      })
    }
    const paint = (delta = 0) => {
      context.clearRect(0, 0, width, height)
      const gust = Math.pow(Math.max(0, Math.sin(elapsed * .23 + .9)), 4) * 25
      const wind = Math.sin(elapsed * .35) * 12 + Math.sin(elapsed * .12 + .5) * 8 + gust
      for (const snow of particles) {
        if (delta > 0) {
          snow.y += snow.fall * delta
          snow.x += (wind * (.4 + snow.depth * .45) + Math.sin(elapsed * .8 + snow.phase) * 11) * delta
          if (snow.y > height + 25) { snow.y = -25; snow.x = (snow.x + width * .19) % width }
          if (snow.x > width + 25) snow.x = -25
          if (snow.x < -25) snow.x = width + 25
        }
        // Keep the reading column calm; nearer snow is concentrated at the edges.
        const edgeDistance = Math.min(snow.x / width, 1 - snow.x / width)
        const centreFade = edgeDistance > .22 ? (layer === 'background' ? 1 : .2) : 1
        const verticalFade = Math.min(1, Math.max(0, snow.y / 28), Math.max(0, (height - snow.y) / 28))
        context.globalAlpha = snow.opacity * centreFade * verticalFade
        context.drawImage(sprites[snow.variant], snow.x - snow.size / 2, snow.y - snow.size / 2, snow.size, snow.size)
      }
      context.globalAlpha = 1
    }
    const canAnimate = () => alive && inView && !document.hidden && width > 0 && height > 0 && !reducedMotion.matches
    const tick = (time: number) => {
      frame = 0
      if (!canAnimate()) { root.dataset.motion = 'still'; return }
      const interval = mobile ? 1000 / 24 : 1000 / 30
      if (!lastDraw || time - lastDraw >= interval - .5) {
        const delta = lastDraw ? Math.min((time - lastDraw) / 1000, .08) : 0
        elapsed += delta
        paint(delta)
        lastDraw = time
      }
      frame = requestAnimationFrame(tick)
    }
    const reconcile = () => {
      if (!alive) return
      const running = canAnimate()
      root.dataset.motion = running ? 'running' : 'still'
      if (running) {
        if (!frame) { lastDraw = 0; frame = requestAnimationFrame(tick) }
      } else {
        cancelAnimationFrame(frame); frame = 0; lastDraw = 0
        if (width > 0 && height > 0) paint()
      }
    }
    const resize = () => {
      const box = root.getBoundingClientRect()
      const nextWidth = Math.round(box.width), nextHeight = Math.round(box.height)
      if (nextWidth === width && nextHeight === height) { reconcile(); return }
      width = nextWidth; height = nextHeight
      mobile = width < 700
      // Pixel count is bounded even on large monitors and high-density phones.
      ratio = Math.min(window.devicePixelRatio || 1, mobile ? 1 : 1.35, Math.sqrt(2_800_000 / Math.max(1, width * height)))
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      seedParticles()
      if (width > 0 && height > 0) paint()
      reconcile()
    }
    const updatePreference = () => { seedParticles(); reconcile() }
    const visibility = () => reconcile()
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { inView = Boolean(entry?.isIntersecting); reconcile() })
    observer?.observe(root)
    const sizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    sizeObserver?.observe(root)
    window.addEventListener('resize', resize, { passive: true })
    document.addEventListener('visibilitychange', visibility)
    reducedMotion.addEventListener('change', updatePreference)
    resize()

    return () => {
      alive = false; cancelAnimationFrame(frame)
      observer?.disconnect(); sizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
      reducedMotion.removeEventListener('change', updatePreference)
      root.dataset.motion = 'still'
      context.clearRect(0, 0, width, height)
      // Release backing stores when navigating away, rather than retaining a GPU surface.
      canvas.width = canvas.height = 1
    }
  }, [active, layer])

  if (!active) return null
  return <div ref={rootRef} className="winter-atmosphere" data-motion="still" data-layer={layer} aria-hidden="true">
    <div className="winter-atmosphere-rim winter-atmosphere-rim--left"/>
    <div className="winter-atmosphere-rim winter-atmosphere-rim--right"/>
    <canvas ref={canvasRef} className="winter-atmosphere-snow"/>
  </div>
}
