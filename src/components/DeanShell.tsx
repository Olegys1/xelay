import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, BookOpen, CalendarDays, Check, CheckCheck, FolderOpen, HelpCircle, LogOut, Menu, Settings2, ShieldCheck, Users, X } from 'lucide-react'

export type DeanSection = 'schedule' | 'conditions' | 'variants' | 'people' | 'publication' | 'access' | 'help'
const sections = [
  { id: 'schedule', label: 'Розклад', icon: CalendarDays },
  { id: 'conditions', label: 'Умови', icon: Settings2 },
  { id: 'variants', label: 'Варіанти', icon: FolderOpen },
  { id: 'people', label: 'Студенти', icon: Users },
  { id: 'publication', label: 'Публікація', icon: CheckCheck },
  { id: 'access', label: 'Доступи', icon: ShieldCheck },
] as const

export function DeanShell({ section, onSection, admin, dirty, onSignOut, children }: {
  section: DeanSection; onSection: (section: DeanSection) => void; admin: boolean;
  dirty: boolean; onSignOut?: () => void; children: ReactNode
}) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 1100px)').matches)
  const trigger = useRef<HTMLButtonElement>(null), rail = useRef<HTMLElement>(null)
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }) }, [section])
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 800px)')
    const update = () => { setMobile(mq.matches); setOpen(false) }
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!mobile || !open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => rail.current?.querySelector<HTMLButtonElement>('.dean-mobile-close')?.focus())
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
      if (event.key !== 'Tab') return
      const elements = Array.from(rail.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []).filter(el => el.getClientRects().length)
      const first = elements[0], last = elements[elements.length - 1]
      if (!rail.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keys)
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keys) }
  }, [mobile, open])
  const close = () => { setOpen(false); trigger.current?.focus() }
  const navigate = (next: DeanSection) => { onSection(next); if (mobile) close() }
  return <div className={`dean-shell ${open ? 'is-menu-open' : 'is-menu-closed'}`}>
    {mobile && open && <button className="dean-menu-backdrop" aria-label="Закрити меню" tabIndex={-1} onClick={close} />}
    <aside ref={rail} id="dean-navigation" className="dean-sidebar" aria-label="Меню деканату" inert={mobile && !open}>
      <div className="dean-sidebar-brand"><a className="dean-brand" href="/" aria-label="На головну Xelay">{open ? 'Xelay' : 'X'}</a><button className="dean-icon-button dean-mobile-close" aria-label="Закрити меню" onClick={close}><X size={20} /></button></div>
      <span className="dean-sidebar-caption">Кабінет деканату</span>
      <nav aria-label="Розділи кабінету">{sections.filter(item => item.id !== 'access' || admin).map(({ id, label, icon: Icon }) => <button key={id} title={label} aria-label={label} aria-current={section === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
      <div className="dean-sidebar-bottom">
        <button title="Як користуватися" aria-label="Як користуватися" aria-current={section === 'help' ? 'page' : undefined} onClick={() => navigate('help')}><HelpCircle size={19} /><span>Як користуватися</span></button>
        <a href="/" title="До Xelay" aria-label="До Xelay"><ArrowLeft size={19} /><span>До Xelay</span></a>
        <div className="dean-sidebar-account"><span className="dean-account-mark">Д</span><span><strong>{admin ? 'Адміністратор' : 'Співробітник'}</strong><small>Деканат</small></span>{onSignOut && <button className="dean-icon-button" title="Вийти" aria-label="Вийти" onClick={onSignOut}><LogOut size={17} /></button>}</div>
      </div>
    </aside>
    <div className="dean-main" inert={mobile && open}>
      <header className="dean-header"><div className="dean-header-start"><button ref={trigger} className="dean-icon-button" aria-label={open ? 'Згорнути меню' : 'Відкрити меню'} aria-controls="dean-navigation" aria-expanded={open} onClick={() => setOpen(value => !value)}><Menu size={21} /></button><span>Кабінет деканату</span></div><span className="dean-save-state"><Check size={14} />{dirty ? 'Є незбережені зміни' : 'Збережено'}</span></header>
      <div className="dean-page-heading"><h1>{section === 'help' ? 'Як користуватися' : sections.find(item => item.id === section)?.label}</h1></div>
      {children}
    </div>
  </div>
}

export function DeanGuide() {
  return <section className="dean-panel dean-guide dean-view-enter"><BookOpen size={26} /><h2>Почніть зі збереженого розкладу</h2><p>Кабінет працює в браузері. Встановлювати програму на комп’ютер деканату не потрібно.</p><ol>
    <li><h3>Перегляньте заняття</h3><p>У розділі «Розклад» оберіть студента або викладача та навчальний тиждень. Лекції, практичні, семінари й лабораторні підписані на картках.</p></li>
    <li><h3>Задайте умови</h3><p>Оберіть навчальні дні, кількість пар і зайнятість викладачів. Окремо можна побажати менше вікон у викладачів або раніший початок занять.</p></li>
    <li><h3>Порівняйте варіанти</h3><p>Натисніть «Знайти варіанти». Система шукає інше розміщення тих самих занять і перевіряє накладки та обрані умови. Години, склад підгруп і викладачів цей перерахунок не змінює.</p></li>
    <li><h3>Перенесіть окрему пару</h3><p>Натисніть заняття в календарі й оберіть новий час. Якщо він зайнятий, система спробує підібрати пов’язані перенесення. Перегляньте список змін перед збереженням.</p></li>
    <li><h3>Збережіть окрему чернетку</h3><p>Кнопка «Відкрити як нову чернетку» зберігає обраний результат окремо. Початковий розклад можна знову відкрити у списку версій.</p></li>
    <li><h3>Підготуйте публікацію</h3><p>У розділі «Студенти» задайте початок семестру й оберіть акаунти. Далі потрібні перевірка, погодження адміністратором і окрема публікація. Для показу кабінету ці дії не потрібні.</p></li>
  </ol><details><summary>Що враховує розрахунок</summary><p>Алгоритм перебирає допустимі дні та пари, не допускає одночасних занять студента або викладача й перевіряє задані обмеження. Після пошуку окрема перевірка повторно звіряє результат із вихідними даними.</p><p>За один запуск він шукає до двох варіантів. Якщо час пошуку закінчився без результату, це ще не доводить, що рішення неможливе. Найкращий із усіх можливих розкладів не гарантується.</p><p>Аудиторії, зайнятість на інших курсах, повне річне навантаження викладачів і неповні години потрібно уточнити окремо. Зміна умов розрахунку сама по собі не змінює розклад.</p></details><details><summary>Як увійти співробітнику деканату</summary><p>Відкрийте www.xelay.ink/dean, введіть видані службовий логін і пароль та налаштуйте другий фактор за підказками на екрані. У кожного співробітника свій вхід і власні чернетки.</p></details></section>
}
