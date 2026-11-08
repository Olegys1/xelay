type FullscreenDocument = Pick<Document, 'fullscreenElement' | 'fullscreenEnabled' | 'exitFullscreen' | 'addEventListener' | 'removeEventListener'> & {
  webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => Promise<void> | void
}
type FullscreenSurface = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
export type MaterialFullscreenState = { expanded: boolean; native: boolean }

/** Owns only this viewer's fullscreen request. It never exits another element. */
export function createTeachingMaterialFullscreen({ document, target, change, restoreFocus = () => {}, now = Date.now }: {
  document: FullscreenDocument; target: () => FullscreenSurface | null; change: (state: MaterialFullscreenState) => void
  restoreFocus?: () => void; now?: () => number
}) {
  let expanded = false, native = false, disposed = false, sequence = 0, owned: FullscreenSurface | null = null, requested: FullscreenSurface | null = null, escapeUntil = 0
  const current = () => document.fullscreenElement || document.webkitFullscreenElement || null
  const emit = () => { if (!disposed) change({ expanded, native }) }
  const exitOwned = async (surface: FullscreenSurface | null): Promise<void> => {
    if (!surface || current() !== surface) return
    const exit = document.webkitFullscreenElement === surface && document.webkitExitFullscreen ? document.webkitExitFullscreen : document.exitFullscreen
    try { await exit?.call(document) } catch { /* Retain ownership if the browser rejects exit so another attempt can retry. */ }
  }
  const changed = () => {
    if (disposed) return
    if (!owned && requested && current() === requested) {
      owned = requested
      if (!expanded) { leave(); return }
    }
    const active = Boolean(owned && current() === owned)
    if (native && !active) { expanded = false; owned = null; escapeUntil = now() + 250; restoreFocus() }
    native = active
    emit()
  }
  document.addEventListener('fullscreenchange', changed)
  document.addEventListener('webkitfullscreenchange', changed)
  const leave = () => {
    const surface = owned
    const attempt = ++sequence
    expanded = false; native = false
    if (!surface || current() !== surface) owned = null
    void exitOwned(surface).then(() => {
      if (disposed || attempt !== sequence) return
      if (surface && current() === surface) { owned = surface; expanded = true; native = true; emit() }
      else if (owned === surface) owned = null
    })
    emit(); if (!disposed) restoreFocus()
  }
  const enter = () => {
    if (disposed || expanded) return
    const surface = target()
    if (!surface) return
    const attempt = ++sequence
    expanded = true
    if (current() === surface) { owned = surface; native = true; emit(); return }
    emit()
    if (current()) return
    const request = document.fullscreenEnabled !== false && surface.requestFullscreen ? surface.requestFullscreen
      : document.webkitFullscreenEnabled !== false ? surface.webkitRequestFullscreen : undefined
    if (!request) return
    owned = surface; requested = surface
    const failed = () => {
      if (disposed || attempt !== sequence) return
      if (current() === surface) { owned = surface; expanded = true; native = true }
      else { owned = null; native = false }
      emit()
    }
    try {
      void Promise.resolve(request.call(surface)).then(() => {
        if (disposed || attempt !== sequence) { if (disposed || owned !== surface) void exitOwned(surface); return }
        changed()
      }).catch(failed)
    } catch { failed() }
  }
  return {
    enter, leave, toggle: () => expanded ? leave() : enter(),
    escape() {
      if (expanded) { leave(); return true }
      if (now() < escapeUntil) { escapeUntil = 0; return true }
      return false
    },
    dispose() {
      if (disposed) return
      disposed = true; ++sequence
      document.removeEventListener('fullscreenchange', changed); document.removeEventListener('webkitfullscreenchange', changed)
      const surface = owned; owned = null; requested = null; expanded = false; native = false; void exitOwned(surface)
    },
  }
}

export function teachingMaterialFitScale(width: number, height: number, availableWidth: number, availableHeight: number | null, zoom: number): number {
  if (![width, height, availableWidth, zoom].every(value => Number.isFinite(value) && value > 0)
    || availableHeight !== null && (!Number.isFinite(availableHeight) || availableHeight <= 0)) throw new Error('Некоректний розмір сторінки матеріалу.')
  return Math.min(availableWidth / width, availableHeight === null ? Infinity : availableHeight / height) * zoom
}
