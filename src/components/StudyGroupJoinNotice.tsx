import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, Check, Copy, UsersRound, X } from 'lucide-react'
import './studyGroupJoinNotice.css'

export type StudyGroupJoinNoticeProps = {
  username: string
  pendingInvites: boolean
  onDisplayed: () => void
  onClose: () => void
  onOpenGroups: () => void
  onOpenProfile: () => void
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

export function StudyGroupJoinNotice({ username, pendingInvites, onDisplayed, onClose, onOpenGroups, onOpenProfile }: StudyGroupJoinNoticeProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const nicknameRef = useRef<HTMLInputElement>(null)
  const callbacks = useRef({ onClose, onDisplayed })
  callbacks.current = { onClose, onDisplayed }
  const displayed = useRef(false)
  const mounted = useRef(false)
  const copyBusy = useRef(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const titleId = useId()
  const descriptionId = useId()
  const copyHelpId = useId()
  const normalizedUsername = username.trim().replace(/^@+/, '').trim()
  const nickname = normalizedUsername ? `@${normalizedUsername}` : ''
  const currentNickname = useRef(nickname)
  currentNickname.current = nickname

  useEffect(() => { setCopyState('idle') }, [nickname])

  useEffect(() => {
    mounted.current = true
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus({ preventScroll: true })
    let firstFrame = 0
    let paintedFrame = 0

    const recordVisibleDisplay = () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(paintedFrame)
      if (displayed.current || document.visibilityState !== 'visible') return
      firstFrame = requestAnimationFrame(() => {
        paintedFrame = requestAnimationFrame(() => {
          const dialog = dialogRef.current
          if (displayed.current || document.visibilityState !== 'visible' || !dialog?.isConnected
            || !dialog.getClientRects().length || getComputedStyle(dialog).visibility === 'hidden') return
          displayed.current = true
          callbacks.current.onDisplayed()
        })
      })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        callbacks.current.onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') || [])
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const outside = !focusable.includes(document.activeElement as HTMLElement)
      if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); return }
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first.focus() }
    }
    const keepFocusInside = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) dialogRef.current?.focus({ preventScroll: true })
    }
    recordVisibleDisplay()
    document.addEventListener('visibilitychange', recordVisibleDisplay)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', keepFocusInside)
    return () => {
      mounted.current = false
      document.body.style.overflow = previousOverflow
      document.removeEventListener('visibilitychange', recordVisibleDisplay)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', keepFocusInside)
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(paintedFrame)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  const copyNickname = async () => {
    if (!nickname || copyBusy.current) return
    copyBusy.current = true
    try {
      await navigator.clipboard.writeText(nickname)
      if (mounted.current && currentNickname.current === nickname) setCopyState('copied')
    } catch {
      if (mounted.current && currentNickname.current === nickname) {
        setCopyState('failed')
        nicknameRef.current?.focus()
        nicknameRef.current?.select()
      }
    } finally { copyBusy.current = false }
  }

  return createPortal(
    <div className="xelay-group-join-overlay fixed inset-0 z-[105] flex items-center justify-center overflow-y-auto overscroll-contain bg-black/40 px-4 py-5 backdrop-blur-sm"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        className="xelay-group-join-card relative my-auto w-full min-w-0 max-w-md rounded-[28px] border border-primary/15 bg-card p-5 text-foreground shadow-2xl outline-none sm:p-7">
        <button type="button" onClick={onClose} aria-label="Закрити повідомлення"
          className={`absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none ${focusRing}`}><X size={18} aria-hidden="true" /></button>
        <div className="mx-auto mb-4 mt-2 flex h-16 w-16 items-center justify-center rounded-[22px] border border-primary/10 bg-primary/[0.07] text-primary"><UsersRound size={29} strokeWidth={1.5} aria-hidden="true" /></div>
        <p className="text-center text-xs font-medium tracking-wide text-primary">Навчання разом у Xelay</p>
        <h2 id={titleId} className="mt-2 text-center text-2xl font-semibold leading-tight tracking-tight sm:text-[27px]">{pendingInvites ? 'Вас уже запросили до навчальної групи' : 'Приєднайтеся до своєї навчальної групи'}</h2>
        <p id={descriptionId} className="mt-3 text-center text-sm leading-6 text-muted-foreground">{pendingInvites
          ? 'У вас є запрошення, яке ще не прийнято. Відкрийте «Мої групи» та прийміть запрошення від старости, щоб долучитися до своєї групи.'
          : 'Ви ще не приєдналися до навчальної групи. Надішліть свій нік у Xelay старості — він або вона зможе запросити вас. Після цього прийміть запрошення в розділі «Мої групи».'}</p>
        <p className="mt-4 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-center text-sm leading-6 text-muted-foreground">Розклад, домашні завдання, семінари й матеріали вашої групи — безкоштовно для всіх учасників.</p>
        {!pendingInvites && <div className="mt-4">
          {nickname ? <>
            <label htmlFor={`${titleId}-nickname`} className="mb-2 block text-xs font-medium text-muted-foreground">Ваш нік для старости</label>
            <div className="rounded-2xl border border-border bg-background/60 p-2">
              <input ref={nicknameRef} id={`${titleId}-nickname`} type="text" readOnly value={nickname} spellCheck={false} autoComplete="off"
                onFocus={(event) => event.currentTarget.select()} aria-describedby={copyState === 'failed' ? copyHelpId : undefined}
                className={`block min-h-11 w-full min-w-0 rounded-xl bg-transparent px-2 text-center text-base font-semibold text-foreground selection:bg-primary/20 ${focusRing}`} />
              <button type="button" onClick={() => { void copyNickname() }}
                className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/10 motion-reduce:transition-none ${focusRing}`}>
                {copyState === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copyState === 'copied' ? 'Нік скопійовано' : 'Скопіювати нік'}
              </button>
            </div>
            <p id={copyHelpId} role="status" aria-live="polite" className={`mt-2 text-xs leading-5 text-muted-foreground ${copyState === 'idle' ? 'sr-only' : ''}`}>
              {copyState === 'failed' ? 'Не вдалося скопіювати автоматично. Виділіть нік вище та натисніть Ctrl+C або ⌘C. На телефоні затисніть нік і виберіть «Копіювати».' : copyState === 'copied' ? 'Готово! Тепер надішліть нік своєму старості.' : ''}
            </p>
          </> : <div className="rounded-2xl border border-border bg-background/60 px-4 py-3 text-center">
            <p className="text-sm font-semibold">Додайте нік у профілі</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">За ніком староста зможе знайти вас і надіслати запрошення.</p>
            <button type="button" onClick={onOpenProfile} className={`mt-2 min-h-11 rounded-xl px-3 py-2 text-sm font-medium text-primary hover:bg-primary/5 ${focusRing}`}>Відкрити профіль<ArrowRight size={15} className="ml-2 inline-block" aria-hidden="true" /></button>
          </div>}
        </div>}
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" onClick={onOpenGroups} className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 motion-reduce:transition-none ${focusRing}`}>Відкрити «Мої групи»<ArrowRight size={17} aria-hidden="true" /></button>
          <button type="button" onClick={onClose} className={`min-h-11 w-full rounded-2xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground motion-reduce:transition-none ${focusRing}`}>Зрозуміло</button>
        </div>
      </div>
    </div>, document.body,
  )
}
