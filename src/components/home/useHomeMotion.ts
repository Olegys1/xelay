import { useEffect, type RefObject } from 'react'

const targets = [
  '.hd-welcome', '.hd-section-controls', '.hd-management', '.hd-state-card',
  '.hd-schedule > .hd-section-heading', '.hd-focus-card', '.hd-no-lessons', '.hd-next-lesson',
  '.hd-attention > .hd-section-heading', '.hd-task', '.hd-all-clear', '.hd-planned',
  '.hd-updates > .hd-section-heading', '.hd-update', '.hd-updates-empty',
  '.hd-opportunities', '.hd-news > .hd-section-heading', '.hd-news-item',
  '.hd-community > .hd-section-heading', '.hd-community-item', '.hd-page-footer',
].join(',')

/** Enhancement only: no observer, animation support or JS ever leaves content hidden. */
export function useHomeMotion(rootRef: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled || typeof IntersectionObserver === 'undefined' || typeof root.animate !== 'function') return
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const observed = new Set<HTMLElement>()
    const visible = new Set<HTMLElement>()
    const revealed = new WeakSet<HTMLElement>()
    const revealedKeys = new Set<string>()
    const animations = new Map<HTMLElement, Animation>()
    let scanFrame = 0
    const motionAllowed = () => !document.hidden && !preference?.matches
    const cancelAnimations = () => {
      animations.forEach(animation => animation.cancel())
      animations.clear()
    }
    const reveal = (elements: HTMLElement[]) => {
      if (!motionAllowed()) return
      elements.filter(element => root.contains(element)).forEach((element, index) => {
        const key = element.dataset.hdMotionKey
        if (revealed.has(element) || key && revealedKeys.has(key)) return
        revealed.add(element)
        if (key) revealedKeys.add(key)
        if (element.matches(':focus-within')) return
        // Preserve the existing muted state of finished lessons, rather than making them opaque.
        const opacity = window.getComputedStyle(element).opacity
        const animation = element.animate([
          { opacity: 0, transform: 'translateY(14px)' },
          { opacity, transform: 'translateY(0)' },
        ], { duration: 620, delay: Math.min(index, 4) * 55, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' })
        animations.set(element, animation)
        const done = () => { if (animations.get(element) === animation) animations.delete(element) }
        animation.onfinish = done
        animation.oncancel = done
      })
    }
    const observer = new IntersectionObserver(entries => {
      const entering: HTMLElement[] = []
      entries.forEach(entry => {
        const element = entry.target as HTMLElement
        if (entry.isIntersecting) {
          visible.add(element)
          element.dataset.hdInView = 'true'
          entering.push(element)
        } else {
          visible.delete(element)
          delete element.dataset.hdInView
          animations.get(element)?.cancel()
        }
      })
      reveal(entering)
    }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' })
    const scan = () => {
      scanFrame = 0
      observed.forEach(element => {
        if (root.contains(element)) return
        observer.unobserve(element)
        visible.delete(element)
        observed.delete(element)
        animations.get(element)?.cancel()
      })
      root.querySelectorAll<HTMLElement>(targets).forEach(element => {
        if (observed.has(element)) return
        observed.add(element)
        observer.observe(element)
      })
    }
    const updateActivity = () => {
      root.dataset.hdMotionActive = String(motionAllowed())
      if (motionAllowed()) reveal(Array.from(visible))
      else cancelAnimations()
    }
    const revealFocused = (event: FocusEvent) => {
      if (!event.target) return
      animations.forEach((animation, element) => {
        if (element.contains(event.target as Node)) animation.cancel()
      })
    }
    updateActivity()
    scan()
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      if (!scanFrame) scanFrame = window.requestAnimationFrame(scan)
    })
    mutations?.observe(root, { childList: true, subtree: true })
    root.addEventListener('focusin', revealFocused)
    document.addEventListener('visibilitychange', updateActivity)
    preference?.addEventListener?.('change', updateActivity)
    return () => {
      observer.disconnect()
      mutations?.disconnect()
      window.cancelAnimationFrame(scanFrame)
      root.removeEventListener('focusin', revealFocused)
      document.removeEventListener('visibilitychange', updateActivity)
      preference?.removeEventListener?.('change', updateActivity)
      cancelAnimations()
      observed.forEach(element => { delete element.dataset.hdInView })
      delete root.dataset.hdMotionActive
    }
  }, [rootRef, enabled])
}
