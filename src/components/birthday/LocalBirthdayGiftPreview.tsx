import { useEffect, useRef, useState } from 'react'
import { Gift, Info, RotateCcw, Sparkles } from 'lucide-react'
import { BirthdayGiftCard } from './BirthdayGiftCard'
import '../../styles/halloween-theme.css'

type PreviewTheme = 'light' | 'dark' | 'halloween'
type PreviewState = 'pending' | 'error' | 'claimed'
const CLAIMED_AT = '2026-10-26T12:00:00Z'
const VALID_UNTIL = '2026-11-26T12:00:00Z'
const SAMPLE_ERROR = 'Не вдалося отримати подарунок. Спробуй ще раз — він чекає на тебе.'

export function LocalBirthdayGiftPreview() {
  const [theme, setTheme] = useState<PreviewTheme>('light')
  const [state, setState] = useState<PreviewState>('pending')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)
  const [celebrating, setCelebrating] = useState(false)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const replayFrame = useRef<number | null>(null)

  useEffect(() => {
    const root = document.documentElement
    const previousClass = root.className
    const previousTheme = root.getAttribute('data-theme')
    root.classList.toggle('dark', theme !== 'light')
    root.setAttribute('data-theme', theme === 'halloween' ? 'halloween' : theme)
    return () => {
      root.className = previousClass
      if (previousTheme === null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', previousTheme)
    }
  }, [theme])

  useEffect(() => () => {
    if (pendingTimer.current !== null) clearTimeout(pendingTimer.current)
    if (replayFrame.current !== null) cancelAnimationFrame(replayFrame.current)
  }, [])

  function show(next: PreviewState) {
    if (pendingTimer.current !== null) clearTimeout(pendingTimer.current)
    if (replayFrame.current !== null) cancelAnimationFrame(replayFrame.current)
    pendingTimer.current = null
    replayFrame.current = null
    setBusy(false)
    setCelebrating(false)
    setState(next)
    setOpen(true)
  }

  function claim() {
    if (busy || state === 'claimed') return
    setBusy(true)
    setState('pending')
    setCelebrating(false)
    pendingTimer.current = setTimeout(() => {
      pendingTimer.current = null
      setBusy(false)
      setState('claimed')
      setCelebrating(true)
    }, 1100)
  }

  function replay() {
    if (state !== 'claimed') return
    setCelebrating(false)
    // A full painted frame separates the two values, so the card sees a new request.
    if (replayFrame.current !== null) cancelAnimationFrame(replayFrame.current)
    replayFrame.current = requestAnimationFrame(() => {
      replayFrame.current = requestAnimationFrame(() => {
        replayFrame.current = null
        setCelebrating(true)
      })
    })
  }

  return <div className="birthday-gift-preview">
    <header className="birthday-gift-preview-header">
      <div className="birthday-gift-preview-brand"><strong>Xelay</strong><span>Локальний перегляд</span></div>
      <div className="birthday-gift-preview-themes" role="group" aria-label="Тема перегляду">
        {([{ value: 'light', label: 'Світла' }, { value: 'dark', label: 'Темна' }, { value: 'halloween', label: 'Гелловін' }] as const).map(item => <button type="button" key={item.value} aria-pressed={theme === item.value} onClick={() => setTheme(item.value)}>{item.label}</button>)}
      </div>
    </header>
    <main className="birthday-gift-preview-main">
      <div className="birthday-gift-preview-copy">
        <p className="birthday-gift-preview-kicker"><Gift size={13} aria-hidden="true" />Персональний подарунок</p>
        <h1>Трохи більше радості у твій день.</h1>
        <p className="birthday-gift-preview-intro">Невелике привітання від Xelay та місяць «Учасника». Натисни кнопку на картці, щоб побачити отримання подарунка.</p>
        <div className="birthday-gift-preview-demo-note"><Info size={15} aria-hidden="true" /><p><strong>Це демонстрація з вигаданими даними.</strong> Усі зміни живуть лише в пам’яті цієї сторінки. Статус облікового запису не змінюється.</p></div>
        <section className="birthday-gift-preview-controls" aria-label="Сценарії демонстрації">
          <h2>Перевірка станів</h2>
          <div className="birthday-gift-preview-controls-row">
            <button type="button" className="birthday-gift-preview-control" aria-pressed={state === 'pending' && !busy} onClick={() => show('pending')}><RotateCcw size={12} aria-hidden="true" />До отримання</button>
            <button type="button" className="birthday-gift-preview-control" aria-pressed={state === 'error'} onClick={() => show('error')}>Помилка</button>
            <button type="button" className="birthday-gift-preview-control" aria-pressed={state === 'claimed'} onClick={() => show('claimed')}>Після отримання</button>
          </div>
          <button type="button" className="birthday-gift-preview-control birthday-gift-preview-replay" disabled={state !== 'claimed' || !open} onClick={replay}><Sparkles size={12} aria-hidden="true" />Повторити святкування</button>
        </section>
      </div>
      <div className="birthday-gift-preview-stage">
        <p className="birthday-gift-preview-stage-label"><span />Так виглядатиме картка в Xelay</p>
        {open ? <BirthdayGiftCard recipientName="Аліна" claimedAt={state === 'claimed' ? CLAIMED_AT : null} validUntil={state === 'claimed' ? VALID_UNTIL : null} busy={busy} error={state === 'error' ? SAMPLE_ERROR : undefined} onClaim={claim} onClose={() => setOpen(false)} celebrating={celebrating} /> : <div className="birthday-gift-preview-closed"><Gift size={28} strokeWidth={1.3} aria-hidden="true" /><p>Картку закрито</p><button type="button" className="birthday-gift-preview-control" onClick={() => { setCelebrating(false); setOpen(true) }}>Відкрити подарунок</button></div>}
        <p className="birthday-gift-preview-stage-footnote">Оновлення сторінки повертає початковий стан.<br />Святкова анімація з’являється після отримання.</p>
      </div>
    </main>
  </div>
}
