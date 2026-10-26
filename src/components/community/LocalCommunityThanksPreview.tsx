import { useEffect, useRef, useState } from 'react'
import { Check, RotateCcw, Sparkles } from 'lucide-react'
import { AppreciationGiftCard, CommunitySparkMark } from './AppreciationGiftCard'
import '../../styles/halloween-theme.css'
import './communityThanksPreview.css'
export function LocalCommunityThanksPreview({ recipientName = 'Настю', profileName = 'Анастасія' }: { recipientName?: string; profileName?: string }) {
  const [claimed, setClaimed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const [theme, setTheme] = useState<'halloween' | 'light' | 'dark'>('halloween')
  const [burst, setBurst] = useState(0)
  const burstSequence = useRef(0)
  const claimTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const root = document.documentElement
    const previousClass = root.className
    const previousTheme = root.getAttribute('data-theme')
    root.classList.toggle('dark', theme !== 'light')
    root.setAttribute('data-theme', theme)
    return () => { root.className = previousClass; if (previousTheme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', previousTheme) }
  }, [theme])
  useEffect(() => () => { if (claimTimer.current !== null) clearTimeout(claimTimer.current) }, [])
  useEffect(() => { if (!burst) return; const timer = setTimeout(() => setBurst(0), 2300); return () => clearTimeout(timer) }, [burst])
  const show = (next: boolean) => { if (claimTimer.current !== null) clearTimeout(claimTimer.current); claimTimer.current = null; setBusy(false); setClaimed(next); setBurst(0); setOpen(true) }
  const claim = () => {
    if (busy || claimed) return
    setBusy(true)
    claimTimer.current = setTimeout(() => { claimTimer.current = null; setBusy(false); setClaimed(true); setBurst(++burstSequence.current) }, 850)
  }
  return <div className="community-thanks-preview">
    <header className="community-thanks-header"><div className="community-thanks-brand"><strong>Xelay</strong><span>Гелловінська подяка · локальний перегляд</span></div><div className="community-thanks-theme-controls" role="group" aria-label="Тема перегляду">{([{ value: 'halloween', label: 'Гелловін' }, { value: 'light', label: 'Світла' }, { value: 'dark', label: 'Темна' }] as const).map(item => <button key={item.value} type="button" className="community-thanks-control" aria-pressed={theme === item.value} onClick={() => setTheme(item.value)}>{item.label}</button>)}</div></header>
    <main className="community-thanks-main">
      <aside className="community-thanks-aside">
        <p className="community-thanks-kicker"><Sparkles size={13} aria-hidden="true" />Трошки магії для своїх</p><h1>Іскра, яка запалює спільноту.</h1><p className="community-thanks-intro">Особиста подяка за те, що допомагаєш Xelay знаходити своїх людей. Трохи гелловінської магії від команди, місяць можливостей і відзнака зі своїм характером.</p>
        <section className="community-thanks-profile" aria-label="Попередній перегляд бейджа у профілі"><div className="community-thanks-profile-cover"><span /><span /><span /></div><div className="community-thanks-profile-body"><div className="community-thanks-avatar" aria-hidden="true">{profileName ? profileName[0] : 'k'}</div><p className="community-thanks-profile-eyebrow">Так виглядатиме у профілі</p><h2>{profileName || '@kn.vanov'}</h2>{profileName && <p className="community-thanks-profile-handle">@kn.vanov</p>}<p className="community-thanks-profile-role">{claimed ? 'Учасник' : 'Учасник спільноти'}</p><span className="community-thanks-profile-badge"><CommunitySparkMark compact /><strong>Іскра Xelay</strong></span><p className="community-thanks-badge-description">Допомагає спільноті рости<br />й запалює інших.</p><span className={`community-thanks-profile-state ${claimed ? 'community-thanks-profile-state--claimed' : ''}`}>{claimed ? <><Check size={12} aria-hidden="true" />Відзнаку отримано</> : 'Попередній перегляд відзнаки'}</span></div></section>
        <div className="community-thanks-controls" role="group" aria-label="Стани локального прикладу"><button type="button" className="community-thanks-control" aria-pressed={!claimed} onClick={() => show(false)}><RotateCcw size={12} aria-hidden="true" />До отримання</button><button type="button" className="community-thanks-control" aria-pressed={claimed} onClick={() => show(true)}>Після отримання</button><button type="button" className="community-thanks-control" disabled={!claimed || !open} onClick={() => setBurst(++burstSequence.current)}><Sparkles size={12} aria-hidden="true" />Повторити святкування</button></div>
        <p className="community-thanks-demo-note">Лише макет. Кнопка змінює стан у пам’яті сторінки. Справжні підписки, бейджі та сповіщення не змінюються.</p>
      </aside>
      <div className="community-thanks-gift"><p className="community-thanks-stage-label"><span />Особисте повідомлення від команди</p>{open ? <AppreciationGiftCard validUntil="2026-11-26T12:00:00Z" claimed={claimed} busy={busy} burst={burst} recipientName={recipientName} onClaim={claim} onClose={() => { setOpen(false); setBurst(0) }} /> : <div className="community-thanks-closed"><CommunitySparkMark /><p>Подяка чекає на тебе.</p><button type="button" className="community-thanks-control" onClick={() => setOpen(true)}>Відкрити подяку</button></div>}<p className="community-thanks-stage-note">Локальна демонстрація · приклад дати завершення підписки</p></div>
    </main>
  </div>
}
