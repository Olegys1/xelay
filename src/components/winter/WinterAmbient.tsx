import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, TreePine, X } from 'lucide-react'
import { winterDocumentBlocked } from '../../lib/winterBlockers'
import { winterPhase } from '../../lib/winterCampaign'
import { WinterDecorations } from './WinterDecorations'
import { WinterHolidayArt } from './WinterHolidayArt'
import './winterExperience.css'

export const winterWelcomeKey = (userId: string | null) => 'xelay:winter-2026:welcome:' + (userId || 'guest')
function bannerDismissed(key: string) { try { return localStorage.getItem(key) === '1' } catch { return false } }

function WinterWelcome({ now, userId }: { now: number; userId: string | null }) {
  const key = winterWelcomeKey(userId)
  const [dismissed, setDismissed] = useState(() => bannerDismissed(key))
  // This component only mounts on an unobstructed home page, never over a test/dialog.
  useEffect(() => { if (userId && !dismissed) { try { localStorage.setItem(key, '1') } catch { /* Keep the greeting usable if storage is unavailable. */ } } }, [userId, key, dismissed])
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(key, '1') } catch { /* Closed for this visit. */ } }
  if (dismissed) return null
  const adventActive = winterPhase(now) === 'active'
  return <aside className="winter-home-banner" aria-label="Зима в Xelay">
    <WinterHolidayArt/>
    <span className="winter-home-icon" aria-hidden="true"><TreePine size={25}/></span>
    <div className="winter-home-copy"><span className="winter-home-eyebrow">ЗИМА У XELAY</span><strong>Зустрічаємо зиму разом.</strong><p>{adventActive ? 'З груднем! Щодня відкривай подарунок: бонусні кредити, дні підписки й зимові знижки.' : 'Дякуємо за цей грудень. Збережені подарунки чекають у твоєму календарі.'}</p></div>
    <Link to="/winter" className="winter-home-link">{adventActive ? 'Відкрити подарунок' : 'Мої подарунки'}<ArrowRight size={16} aria-hidden="true"/></Link>
    <button type="button" className="winter-home-close" onClick={dismiss} aria-label="Закрити зимове привітання"><X size={17}/></button>
  </aside>
}

export function WinterAmbient({ now, pathname, userId = null }: { now: number; pathname: string; userId?: string | null }) {
  const [blocked, setBlocked] = useState(() => winterDocumentBlocked(document))
  useEffect(() => {
    const check = () => setBlocked(winterDocumentBlocked(document))
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active', 'role', 'aria-modal', 'open', 'hidden'] })
    document.addEventListener('fullscreenchange', check)
    check()
    return () => { observer.disconnect(); document.removeEventListener('fullscreenchange', check) }
  }, [])
  if (blocked) return null
  return <>
    <WinterDecorations now={now} pathname={pathname} />
    {pathname === '/' && <WinterWelcome key={userId || 'guest'} now={now} userId={userId}/>}
  </>
}
