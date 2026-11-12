import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, Menu, Moon, RotateCcw, Sun, Wrench, X } from 'lucide-react'
import { XelayLogo } from '../XelayLogo'
import { AdminPartnerToolsPanel } from './AdminPartnerToolsPanel'
import { UsefulToolsCatalog } from './UsefulToolsCatalog'
import { HomeUsefulTools } from './HomeUsefulTools'
import { createPartnerToolsPreview } from '../../lib/partnerToolsPreview'
import type { PartnerTool, PartnerToolSource } from '../../lib/partnerTools'
import './local-useful-tools-preview.css'

type View = 'home' | 'catalog' | 'admin'
type Role = 'guest' | 'student' | 'teacher' | 'admin'
const roles: Record<Role, string> = { guest: 'Гість', student: 'Студент', teacher: 'Викладач', admin: 'Адміністратор' }
const adminId = '26666666-6666-4666-8666-666666666666'

export function LocalUsefulToolsPreview() {
  const preview = useMemo(() => createPartnerToolsPreview({ storage: window.localStorage }), [])
  const [view, setView] = useState<View>('catalog')
  const [role, setRole] = useState<Role>('student')
  const [tools, setTools] = useState<PartnerTool[]>([])
  const [resetKey, setResetKey] = useState(0)
  const [menu, setMenu] = useState(false)
  const [dark, setDark] = useState(false)
  const [opened, setOpened] = useState<{ name: string; url: string; source: PartnerToolSource } | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  const refresh = useCallback(() => {
    void preview.api.listPublic().then(setTools)
  }, [preview])
  useEffect(() => { refresh(); return preview.subscribe(refresh) }, [preview, refresh])
  useEffect(() => {
    const original = document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', dark)
    return () => { document.documentElement.classList.toggle('dark', original) }
  }, [dark])
  useEffect(() => { if (role !== 'admin' && view === 'admin') setView('catalog') }, [role, view])
  useEffect(() => {
    if (!opened) return
    previousFocus.current = document.activeElement as HTMLElement
    close.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow; previousFocus.current?.focus() }
  }, [opened])
  const changeView = (next: View) => { setView(next); setMenu(false); window.scrollTo({ top: 0, behavior: 'instant' }) }
  const open = (tool: PartnerTool, source: PartnerToolSource) => {
    void preview.api.recordClick(tool.id, source).catch(() => {})
    setOpened({ name: tool.name, url: tool.destinationUrl, source })
    return false
  }
  const handleLocalNavigation = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const url = new URL(anchor.href, window.location.href)
    if (url.origin === window.location.origin && ['/', '/tools'].includes(url.pathname)) {
      event.preventDefault(); changeView(url.pathname === '/tools' ? 'catalog' : 'home')
    }
  }

  return <div className="pt-preview" onClickCapture={handleLocalNavigation} onAuxClickCapture={event => {
    if ((event.target as HTMLElement).closest('a[href^="https:"]')) event.preventDefault()
  }}>
    <div className="pt-preview-note"><span>Локальний перегляд</span><p>Усі картки й переходи демонстраційні. Дані робочого Xelay не змінюються.</p><button type="button" onClick={() => { preview.reset(); setOpened(null); setResetKey(value => value + 1) }}><RotateCcw size={14} />Скинути демодані</button></div>
    <header className="pt-preview-header">
      <div className="pt-preview-brand"><button type="button" className="pt-preview-menu" aria-label="Відкрити меню" aria-expanded={menu} onClick={() => setMenu(value => !value)}><Menu size={24} /></button><button type="button" className="pt-preview-logo" aria-label="Xelay — на головну" onClick={() => changeView('home')}><XelayLogo className="h-12 w-32" /></button></div>
      <nav aria-label="Розділи локального перегляду" className="pt-preview-nav">
        <button type="button" className={view === 'home' ? 'is-active' : ''} aria-current={view === 'home' ? 'page' : undefined} onClick={() => changeView('home')}>Головна</button>
        <button type="button" className={view === 'catalog' ? 'is-active' : ''} aria-current={view === 'catalog' ? 'page' : undefined} onClick={() => changeView('catalog')}>Корисні інструменти</button>
        {role === 'admin' && <button type="button" className={view === 'admin' ? 'is-active' : ''} aria-current={view === 'admin' ? 'page' : undefined} onClick={() => changeView('admin')}>Керування</button>}
      </nav>
      <div className="pt-preview-settings"><button type="button" aria-label={dark ? 'Увімкнути світлу тему' : 'Увімкнути темну тему'} onClick={() => setDark(value => !value)}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button><label><span>Перегляд як</span><select aria-label="Роль для локального перегляду" value={role} onChange={event => setRole(event.target.value as Role)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    </header>

    {menu && <div className="pt-preview-menu-panel"><p>Навігація</p><button type="button" onClick={() => changeView('home')}>Головна <ArrowRight size={16} /></button><button type="button" onClick={() => changeView('catalog')}><Wrench size={17} />Корисні інструменти <ArrowRight size={16} /></button>{role === 'admin' && <button type="button" onClick={() => changeView('admin')}>Керування партнерами <ArrowRight size={16} /></button>}</div>}

    {view === 'catalog' && <UsefulToolsCatalog tools={tools} onOpen={open} />}
    {view === 'home' && <main className="pt-preview-home">
      <div className="pt-preview-home-intro"><p className="pt-eyebrow">Навчайся. Ділися. Знайомся.</p><h1>{role === 'guest' ? 'Ваш навчальний день.' : role === 'teacher' ? 'Усе для викладання.' : 'Усе потрібне поруч.'}</h1><p>{role === 'guest' ? 'Розклад, завдання, матеріали та корисні інструменти в одному місці.' : 'Навчальний день, найближчі справи та оновлення ваших груп.'}</p></div>
      <section className="pt-preview-home-context" aria-label="Контекст головної сторінки"><article><CalendarDays size={22} /><div><span>Мій розклад</span><h2>Наступне заняття — завтра</h2><p>Навчальна група · приклад головної сторінки</p></div></article><article><span className="pt-preview-quiet-dot" /><div><span>На черзі</span><h2>Нічого термінового</h2><p>Нові завдання та повідомлення залишаються поруч.</p></div></article></section>
      <div className="pt-preview-home-separator"><span>Нижня частина головної сторінки</span></div>
      <HomeUsefulTools tools={tools} onOpen={open} />
      <footer className="pt-preview-home-footer"><span><b>Xelay</b> Навчайся. Ділися. Знайомся.</span><button type="button" onClick={() => changeView('catalog')}>Корисні інструменти <ArrowRight size={15} /></button></footer>
    </main>}
    {view === 'admin' && role === 'admin' && <main className="pt-preview-admin"><div className="pt-preview-admin-intro"><button type="button" onClick={() => changeView('catalog')}><ArrowLeft size={16} />До каталогу</button><p className="pt-eyebrow">Адміністратор · демонстрація</p><h1>Партнери Xelay</h1><p>Публікуйте та приховуйте картки, змінюйте порядок і переглядайте переходи.</p></div><AdminPartnerToolsPanel actorId={adminId} api={preview.api} onChanged={refresh} key={`partner-admin-${resetKey}`} /></main>}

    {opened && <div className="pt-preview-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setOpened(null) }}><div ref={dialog} className="pt-preview-modal" role="dialog" aria-modal="true" aria-labelledby="pt-preview-open-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpened(null) }
      if (event.key === 'Tab') {
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = buttons?.[0], last = buttons?.[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}><button ref={close} type="button" aria-label="Закрити демонстраційний перехід" className="pt-preview-modal-close" onClick={() => setOpened(null)}><X size={20} /></button><span className="pt-preview-modal-icon"><Wrench size={24} /></span><p className="pt-eyebrow">Демонстраційний перехід</p><h2 id="pt-preview-open-title">{opened.name}</h2><p>На робочому Xelay тут відкриється сайт партнера в новій вкладці. У цьому перегляді ми залишаємося на локальній сторінці.</p><code>{opened.url}</code><div className="pt-preview-modal-info"><span>Джерело: {opened.source === 'home' ? 'головна сторінка' : 'каталог'}</span><p>У статистиці враховується лише перше відкриття цього інструмента за 30 хвилин. Повторні натискання не додають переходів.</p></div><button type="button" className="pt-button" onClick={() => setOpened(null)}>Зрозуміло</button></div></div>}
  </div>
}
