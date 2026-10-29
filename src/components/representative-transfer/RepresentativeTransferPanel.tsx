import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowRightLeft, Check, CheckCheck, ChevronRight, Info, LoaderCircle, Search, ShieldCheck, Users, X } from 'lucide-react'
import './representativeTransfer.css'

export interface RepresentativeTransferMember {
  id: string
  groupId: string
  name: string
  username?: string
  avatarUrl?: string | null
  status: 'accepted' | 'pending' | 'invited' | 'rejected'
}
export interface RepresentativeTransferPanelProps {
  groupId: string
  groupName: string
  currentUserId: string
  representativeId: string
  members: RepresentativeTransferMember[]
  loading?: boolean
  disabled?: boolean
  /** The authenticated caller must map failures to user-safe Error messages. */
  onTransfer: (targetUserId: string) => Promise<void>
}
type Stage = 'closed' | 'choose' | 'review' | 'success'
type State = { scope: string; stage: Stage; query: string; selected: string; confirmed: boolean; busy: boolean; error: string; successName: string }
const initial = (scope: string): State => ({ scope, stage: 'closed', query: '', selected: '', confirmed: false, busy: false, error: '', successName: '' })
const displayName = (member: RepresentativeTransferMember) => member.name.trim() || (member.username ? `@${member.username}` : 'Учасник Xelay')
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase('uk-UA')

/** Pure interaction panel. Its caller owns authenticated transfer and refresh. */
export function RepresentativeTransferPanel({ groupId, groupName, currentUserId, representativeId, members, loading = false, disabled = false, onTransfer }: RepresentativeTransferPanelProps) {
  const id = useId(), scope = `${groupId}:${currentUserId}:${representativeId}`
  const [state, setState] = useState<State>(() => initial(scope))
  const view = state.scope === scope ? state : initial(scope)
  const current = useRef(scope); current.current = scope
  const alive = useRef(false), request = useRef<symbol | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), opener = useRef<HTMLButtonElement>(null)
  const previousStage = useRef<Stage>('closed')
  const update = (next: Partial<State>) => setState(previous => ({ ...(previous.scope === scope ? previous : initial(scope)), ...next }))
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { request.current = null; setState(initial(scope)) }, [scope])
  useEffect(() => {
    if (previousStage.current === view.stage) return
    const previous = previousStage.current; previousStage.current = view.stage
    if (view.stage === 'closed' && previous !== 'closed') opener.current?.focus({ preventScroll: true })
    else heading.current?.focus({ preventScroll: true })
  }, [view.stage])

  const accepted = useMemo(() => [...new Map(members.filter(member => member.groupId === groupId && member.status === 'accepted').map(member => [member.id, member])).values()]
    .sort((a, b) => displayName(a).localeCompare(displayName(b), 'uk-UA')), [groupId, members])
  const target = accepted.find(member => member.id === view.selected && member.id !== currentUserId)
  const search = view.query.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
  const filtered = accepted.filter(member => !search || [member.name, member.username].some(value => value?.toLocaleLowerCase('uk-UA').includes(search)))
  const eligibleCount = accepted.filter(member => member.id !== currentUserId).length
  const unavailable = disabled || loading || view.busy
  useEffect(() => {
    if (!loading && !view.busy && view.selected && !target) update({ selected: '', confirmed: false, stage: 'choose', error: 'Цей учасник уже недоступний для передачі. Оберіть когось із поточного списку.' })
  }, [loading, view.busy, view.selected, target?.id])

  const cancel = () => { if (!request.current) setState(initial(scope)) }
  async function confirm() {
    if (request.current || unavailable || view.stage !== 'review' || !view.confirmed || !target || currentUserId !== representativeId) return
    const sequence = Symbol('transfer'), actor = scope, nextName = displayName(target)
    request.current = sequence
    update({ busy: true, error: '' })
    try {
      await onTransfer(target.id)
      if (alive.current && current.current === actor && request.current === sequence) update({ stage: 'success', successName: nextName, confirmed: false })
    } catch (error) {
      if (alive.current && current.current === actor && request.current === sequence) update({ error: error instanceof Error && error.message.trim() ? error.message : 'Не вдалося завершити передачу. Перевірте поточного старосту в групі та спробуйте ще раз.' })
    } finally {
      if (request.current === sequence) {
        request.current = null
        if (alive.current && current.current === actor) update({ busy: false })
      }
    }
  }

  if (!groupId || !currentUserId || currentUserId !== representativeId) return null
  return <section className={`rt-panel rt-panel--${view.stage}`} aria-labelledby={`${id}-title`} aria-busy={view.busy} onKeyDown={event => { if (event.key === 'Escape' && view.stage !== 'closed' && !view.busy) { event.preventDefault(); cancel() } }}>
    <header className="rt-panel-header"><span className="rt-panel-icon"><ArrowRightLeft size={20} strokeWidth={1.6} aria-hidden="true" /></span><div><h3 id={`${id}-title`}>Передати права старости</h3><p>Група залишається зі своїми. Змінюється лише староста.</p></div>{view.stage === 'closed' ? <button ref={opener} type="button" className="rt-button rt-button-outline rt-entry" disabled={disabled || loading} onClick={() => update({ stage: 'choose', confirmed: false, error: '' })}>Передати права<ChevronRight size={15} aria-hidden="true" /></button> : view.stage !== 'success' ? <button type="button" className="rt-close" disabled={view.busy} aria-label="Закрити передачу прав" onClick={cancel}><X size={17} aria-hidden="true" /></button> : null}</header>
    {view.stage === 'choose' && <div className="rt-panel-body"><div className="rt-step-kicker"><span>1</span>Оберіть нового старосту</div><h4 ref={heading} tabIndex={-1} className="rt-step-heading">Кому передаємо групу «{groupName}»?</h4><p className="rt-step-description">Обрати можна лише учасника, який уже прийняв запрошення до цієї групи.</p><label className="rt-search"><Search size={16} aria-hidden="true" /><span className="rt-sr-only">Ім’я або нік нового старости</span><input type="search" value={view.query} maxLength={120} disabled={unavailable} onChange={event => update({ query: event.target.value })} placeholder="Знайти за ім’ям або @ніком" /></label>
      <fieldset className="rt-member-options" disabled={unavailable}><legend className="rt-sr-only">Прийняті учасники групи</legend>{loading ? <p className="rt-list-status" role="status"><LoaderCircle size={16} className="rt-spinner" aria-hidden="true" />Завантажуємо учасників…</p> : !eligibleCount ? <p className="rt-list-status">Поки немає інших прийнятих учасників. Спочатку додайте одногрупників до групи.</p> : !filtered.length ? <p className="rt-list-status">Нікого не знайдено. Спробуйте інше ім’я або нік.</p> : filtered.map(member => {
        const self = member.id === currentUserId, name = displayName(member)
        return <label key={member.id} className={`rt-member ${view.selected === member.id ? 'rt-member--selected' : ''} ${self ? 'rt-member--self' : ''}`}><input type="radio" name={`${id}-member`} value={member.id} checked={view.selected === member.id} disabled={self} onChange={() => update({ selected: member.id, confirmed: false, error: '' })} /><span className="rt-avatar" aria-hidden="true">{member.avatarUrl ? <img src={member.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initials(name)}</span><span className="rt-member-copy"><strong>{name}</strong><span>{member.username ? `@${member.username}` : 'Учасник групи'}{self && <b>Це ви</b>}</span></span>{self ? <span className="rt-current-role">Староста</span> : <span className="rt-radio-mark" aria-hidden="true">{view.selected === member.id && <Check size={13} strokeWidth={2.4} />}</span>}</label>
      })}</fieldset>{view.error && <p className="rt-error" role="alert">{view.error}</p>}<div className="rt-panel-actions"><button type="button" className="rt-button rt-button-quiet" onClick={cancel}>Скасувати</button><button type="button" className="rt-button rt-button-primary" disabled={unavailable || !target} onClick={() => { if (target && !unavailable) update({ stage: 'review', confirmed: false, error: '' }) }}>Продовжити<ArrowRight size={15} aria-hidden="true" /></button></div></div>}
    {view.stage === 'review' && target && <div className="rt-panel-body"><div className="rt-step-kicker"><span>2</span>Остання перевірка</div><h4 ref={heading} tabIndex={-1} className="rt-step-heading">Підтвердьте нового старосту</h4><div className="rt-transfer-person"><span className="rt-avatar" aria-hidden="true">{target.avatarUrl ? <img src={target.avatarUrl} alt="" referrerPolicy="no-referrer" /> : initials(displayName(target))}</span><div><strong>{displayName(target)}</strong><span>{target.username ? `@${target.username}` : 'Прийнятий учасник групи'}</span></div><span className="rt-new-role"><ShieldCheck size={13} aria-hidden="true" />Новий староста</span></div><ul className="rt-consequences"><li><ShieldCheck size={16} aria-hidden="true" /><span>Новий староста одразу отримає керування групою «{groupName}».</span></li><li><Users size={16} aria-hidden="true" /><span>Ви залишитеся у групі як <strong>звичайний учасник</strong>.</span></li><li><CheckCheck size={16} aria-hidden="true" /><span>Розклад, ДЗ, матеріали та склад групи збережуться.</span></li></ul><label className="rt-confirm-choice"><input type="checkbox" checked={view.confirmed} disabled={view.busy || disabled} onChange={event => update({ confirmed: event.target.checked })} /><span>Розумію, що після передачі більше не матиму прав старости в цій групі.</span></label>{view.error && <p className="rt-error" role="alert">{view.error}</p>}{view.busy && <p className="rt-busy-note" role="status"><LoaderCircle size={14} className="rt-spinner" aria-hidden="true" />Передаємо права. Зачекайте, будь ласка.</p>}<div className="rt-panel-actions"><button type="button" className="rt-button rt-button-quiet" disabled={view.busy} onClick={() => update({ stage: 'choose', confirmed: false, error: '' })}><ArrowLeft size={14} aria-hidden="true" />Назад</button><button type="button" className="rt-button rt-button-primary" disabled={unavailable || !view.confirmed} onClick={() => { void confirm() }}>{view.busy ? <LoaderCircle size={15} className="rt-spinner" aria-hidden="true" /> : <ArrowRightLeft size={15} aria-hidden="true" />}Передати права зараз</button></div></div>}
    {view.stage === 'success' && <div className="rt-panel-body rt-success" role="status" aria-live="polite"><span className="rt-success-mark"><Check size={25} strokeWidth={1.6} aria-hidden="true" /></span><h4 ref={heading} tabIndex={-1}>У групи новий староста</h4><p><strong>{view.successName}</strong> вже може керувати групою «{groupName}».</p><div><Users size={15} aria-hidden="true" />Ви залишаєтеся учасником. Навчальні матеріали на місці.</div></div>}
    {view.stage === 'closed' && <p className="rt-closed-note"><Info size={12} aria-hidden="true" />Передача відбудеться лише після вибору учасника та вашого підтвердження.</p>}
  </section>
}
