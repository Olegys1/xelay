import { useId, useState } from 'react'
import { Cake, ChevronDown, RefreshCw, Sparkles } from 'lucide-react'
import './birthdayProfile.css'

export interface GroupBirthdayMember { userId: string; name: string; avatarUrl?: string | null; day: number; month: number; isToday: boolean; daysUntil: number }
export interface GroupBirthdayListProps { members: GroupBirthdayMember[]; loading?: boolean; error?: string; onRetry?: () => void }
const readableDate = (day: number, month: number) => new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, month - 1, day)))
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] || '').join('')

/** The caller supplies only birthdays shared with the authorized current group. */
export function GroupBirthdayList({ members, loading = false, error, onRetry }: GroupBirthdayListProps) {
  const heading = useId()
  const [expanded, setExpanded] = useState(false)
  const sorted = [...members].sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, 'uk'))
  const visible = expanded ? sorted : sorted.slice(0, 3)
  return <section className="bp-group-card" aria-labelledby={heading} aria-busy={loading}>
    <header className="bp-group-heading"><span className="bp-group-icon"><Cake size={19} strokeWidth={1.7} aria-hidden="true" /></span><div><h3 id={heading}>Є привід усміхнутися</h3><p>Дні народження у вашій групі</p></div>{!loading && !error && sorted.some(member => member.isToday) && <span className="bp-today-dot" aria-label="Сьогодні є іменинники" />}</header>
    {loading ? <div className="bp-group-skeleton" role="status" aria-label="Завантажуємо дні народження"><i /><i /></div> : error ? <div className="bp-group-error"><p role="alert">{error}</p>{onRetry && <button type="button" onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />Спробувати ще раз</button>}</div> : !sorted.length ? <p className="bp-group-empty">Тут з’являться дні народження одногрупників, які дозволили їх показувати.</p> : <>
      <ul className="bp-birthday-members">{visible.map(member => <li key={member.userId} className={member.isToday ? 'bp-birthday-today' : undefined}><span className="bp-avatar" aria-hidden="true">{member.avatarUrl ? <img src={member.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initials(member.name)}{member.isToday && <span className="bp-avatar-spark">✦</span>}</span><div className="bp-member-copy"><strong>{member.name}</strong><span>{member.isToday ? <><Sparkles size={12} aria-hidden="true" />Сьогодні день народження</> : <>{readableDate(member.day, member.month)}{member.daysUntil === 1 && <b>Завтра</b>}</>}</span></div>{member.isToday && <span className="bp-wish" aria-hidden="true">🎉</span>}</li>)}</ul>
      {sorted.length > 3 && <button type="button" className="bp-show-birthdays" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Згорнути' : `Ще ${sorted.length - 3}`}<ChevronDown size={14} className={expanded ? 'bp-chevron-up' : undefined} aria-hidden="true" /></button>}
    </>}
    <p className="bp-group-privacy">Тільки ті, хто сам дозволив показувати дату.</p>
  </section>
}
