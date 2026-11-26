import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, TreePine, X } from 'lucide-react'
import { winterDocumentBlocked } from '../../lib/winterBlockers'
import { winterPhase } from '../../lib/winterCampaign'
import { WinterDecorations } from './WinterDecorations'
import './winterExperience.css'

const bannerKey = 'xelay:winter-2026:home-banner-dismissed'
function bannerDismissed() { try { return localStorage.getItem(bannerKey) === '1' } catch { return false } }

export function WinterAmbient({ now, pathname }: { now: number; pathname: string }) {
  const [blocked, setBlocked] = useState(() => winterDocumentBlocked(document))
  const [dismissed, setDismissed] = useState(bannerDismissed)
  useEffect(() => {
    const check = () => setBlocked(winterDocumentBlocked(document))
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active', 'role', 'aria-modal', 'open', 'hidden'] })
    document.addEventListener('fullscreenchange', check)
    check()
    return () => { observer.disconnect(); document.removeEventListener('fullscreenchange', check) }
  }, [])
  const dismiss = () => {
    setDismissed(true)
    try { localStorage.setItem(bannerKey, '1') } catch { /* Dismissal still works for this visit. */ }
  }
  if (blocked) return null
  const adventActive = winterPhase(now) === 'active'
  return <>
    <WinterDecorations now={now} pathname={pathname} />
    {pathname === '/' && !dismissed && <aside className="winter-home-banner" aria-label="Зима в Xelay">
      <span className="winter-home-icon" aria-hidden="true"><TreePine size={25} /></span>
      <div className="winter-home-copy"><strong>Трохи зими серед справ</strong><p>{adventActive ? 'Відкрийте сьогоднішній подарунок у своєму календарі.' : 'Ваші грудневі подарунки залишилися у колекції.'}</p></div>
      <Link to="/winter" className="winter-home-link">{adventActive ? 'До календаря' : 'Моя колекція'}<ArrowRight size={16} aria-hidden="true" /></Link>
      <button type="button" className="winter-home-close" onClick={dismiss} aria-label="Приховати зимовий банер"><X size={17} /></button>
    </aside>}
  </>
}
