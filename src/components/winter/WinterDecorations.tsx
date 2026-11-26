import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Snowflake } from 'lucide-react'
import { WINTER_EFFECTS_KEY, winterDecorationsAvailable, winterRouteAllowed } from '../../lib/winterCampaign'
import './winter.css'

const changed = 'xelay:winter-effects-changed'
let unsavedPreference: boolean | null = null
function readEffects() { if (unsavedPreference !== null) return unsavedPreference; try { return localStorage.getItem(WINTER_EFFECTS_KEY) !== 'off' } catch { return true } }
function subscribeEffects(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === WINTER_EFFECTS_KEY || event.key === null) { unsavedPreference = null; notify() } }
  window.addEventListener('storage', storage); window.addEventListener(changed, notify)
  return () => { window.removeEventListener('storage', storage); window.removeEventListener(changed, notify) }
}
export function useWinterEffects() {
  const enabled = useSyncExternalStore(subscribeEffects, readEffects, () => true)
  const setEnabled = (next: boolean) => {
    try { localStorage.setItem(WINTER_EFFECTS_KEY, next ? 'on' : 'off'); unsavedPreference = null } catch { unsavedPreference = next }
    window.dispatchEvent(new Event(changed))
  }
  return { enabled, setEnabled }
}
export function WinterEffectsControl() {
  const { enabled, setEnabled } = useWinterEffects()
  return <button type="button" className="winter-effects-control" aria-pressed={enabled} onClick={() => setEnabled(!enabled)}><Snowflake size={16}/><span>Святкові ефекти</span><span className="winter-effects-switch" aria-hidden="true"/></button>
}

/** The caller supplies the current campaign time. This layer never grants access or rewards. */
export function WinterDecorations({ now, pathname, blocked = false, preview = false }: { now: number; pathname: string; blocked?: boolean; preview?: boolean }) {
  const { enabled } = useWinterEffects()
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update) }, [])
  if (!enabled || blocked || !winterRouteAllowed(pathname) || !preview && !winterDecorationsAvailable(now)) return null
  return <div className="winter-decorations" data-visible={visible} aria-hidden="true">
    <div className="winter-garland">{Array.from({ length: 17 }, (_, index) => <span key={index} style={{ '--winter-delay': `${index * .38}s`, '--winter-wire': `${Math.sin(index / 16 * Math.PI) * 13}px` } as CSSProperties}/>)}</div>
    <div className="winter-snow">{Array.from({ length: 22 }, (_, index) => <i key={index} style={{ '--winter-x': `${(index * 47.13) % 100}%`, '--winter-duration': `${13 + index % 9}s`, '--winter-delay': `-${index * 2.13}s`, '--winter-drift': `${index % 2 ? -33 : 46}px`, '--winter-size': `${2 + index % 3}px` } as CSSProperties}/>)}</div>
  </div>
}
