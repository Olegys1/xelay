import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Gift, Loader2 } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../lib/supabase'
import { assertAdminBillingIdentity } from '../../lib/adminBillingTransactions'
import { offerBirthdayGift, type BirthdayGift } from '../../lib/birthdayGifts'

type ConfirmedProfile = { id: string; fullName: string | null; username: string | null; owner: string; input: string }
type PendingRequest = { controller: AbortController; timer: number }
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const uuid = new RegExp('^' + uuidPattern + '$', 'i')
const profileLink = new RegExp('^(?:https?://[^/?#]+)?/user/(' + uuidPattern + ')/?(?:[?#].*)?$', 'i')
const fieldClass = 'mt-1 min-h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15'
const verifyFailure = 'Не вдалося перевірити профіль. Перевірте ID, сесію адміністратора й повторіть спробу.'
const offerFailure = 'Не вдалося підтвердити надсилання. Перевірте профіль і спробуйте ще раз. Повторного подарунка за цей рік не буде.'

function targetId(value: string): string | null {
  const trimmed = value.trim()
  return (uuid.test(trimmed) ? trimmed : trimmed.match(profileLink)?.[1])?.toLowerCase() ?? null
}

export function BirthdayGiftAdminOffer() {
  const { authUser, xelayUser, isLoading } = useAuth()
  const adminId = !isLoading && authUser?.id && xelayUser?.id === authUser.id && xelayUser.isPlatformAdmin ? authUser.id : null
  const currentAdmin = useRef(adminId); currentAdmin.current = adminId
  const [input, setInput] = useState('')
  const currentInput = useRef(input); currentInput.current = input
  const [greetingName, setGreetingName] = useState('')
  const [profile, setProfile] = useState<ConfirmedProfile | null>(null)
  const [busy, setBusy] = useState<'verify' | 'offer' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<BirthdayGift | null>(null)
  const active = useRef(true)
  const lock = useRef(false)
  const sequence = useRef(0)
  const request = useRef<PendingRequest | null>(null)
  const confirmed = profile?.owner === adminId && profile.input === input.trim() ? profile : null

  const cancel = () => {
    ++sequence.current
    if (request.current) { window.clearTimeout(request.current.timer); request.current.controller.abort(); request.current = null }
    lock.current = false
  }
  const reset = () => { cancel(); setInput(''); currentInput.current = ''; setGreetingName(''); setProfile(null); setResult(null); setError(''); setBusy(null) }

  useEffect(() => {
    active.current = true
    return () => { active.current = false; cancel() }
  }, [])
  useEffect(() => { reset(); return cancel }, [adminId])
  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== 'SIGNED_OUT' && session?.user.id === currentAdmin.current) return
      reset()
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  const start = (owner: string, inputKey: string, operation: 'verify' | 'offer') => {
    cancel()
    const run = sequence.current, controller = new AbortController()
    const valid = () => active.current && currentAdmin.current === owner && sequence.current === run && currentInput.current.trim() === inputKey
    lock.current = true; setBusy(operation); setError(''); setResult(null)
    const timer = window.setTimeout(() => {
      controller.abort()
      if (valid()) { ++sequence.current; request.current = null; lock.current = false; setBusy(null); setError(operation === 'verify' ? verifyFailure : offerFailure) }
    }, 18000)
    request.current = { controller, timer }
    const finish = () => {
      window.clearTimeout(timer)
      if (valid()) { request.current = null; lock.current = false; setBusy(null) }
    }
    return { controller, valid, finish }
  }

  const verify = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current || !adminId) return
    setProfile(null); setResult(null); setError('')
    const id = targetId(input)
    if (!id) { setError('Вставте ID користувача або посилання на його профіль.'); return }
    const owner = adminId, inputKey = input.trim(), operation = start(owner, inputKey, 'verify')
    try {
      await assertAdminBillingIdentity(owner, operation.controller.signal)
      if (!operation.valid() || operation.controller.signal.aborted) return
      const { data: rows, error: lookupError } = await supabase.rpc('xelay_profiles_by_ids', { p_user_ids: [id] }).abortSignal(operation.controller.signal)
      if (!operation.valid() || operation.controller.signal.aborted) return
      if (lookupError) throw lookupError
      if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid profile response')
      const data = rows[0]
      if (!data) { setError('Профіль із цим ID не знайдено. Перевірте посилання.'); return }
      if (typeof data.id !== 'string' || data.id.toLowerCase() !== id
        || (data.full_name != null && (typeof data.full_name !== 'string' || data.full_name.length > 500))
        || (data.username != null && (typeof data.username !== 'string' || data.username.length > 500))) throw new Error('Invalid profile')
      await assertAdminBillingIdentity(owner, operation.controller.signal)
      if (operation.valid() && !operation.controller.signal.aborted) setProfile({ id, fullName: data.full_name?.trim() || null, username: data.username?.replace(/^@/, '').trim() || null, owner, input: inputKey })
    } catch { if (operation.valid()) setError(verifyFailure) }
    finally { operation.finish() }
  }

  const send = async () => {
    if (lock.current || !adminId || !confirmed || result) return
    const name = greetingName.trim()
    if (name.length > 80) { setError('Ім’я у привітанні має містити щонайбільше 80 символів.'); return }
    const selected = confirmed, owner = adminId, operation = start(owner, selected.input, 'offer')
    try {
      const gift = await offerBirthdayGift(owner, selected.id, operation.controller.signal, name)
      if (operation.valid() && !operation.controller.signal.aborted) setResult(gift)
    } catch { if (operation.valid()) setError(offerFailure) }
    finally { operation.finish() }
  }

  if (!adminId) return null
  return <details className="mx-5 mb-5 rounded-2xl border border-border p-4">
    <summary className="cursor-pointer text-sm font-semibold text-primary"><Gift size={15} className="mr-2 inline" aria-hidden="true" />Привітання з днем народження та подарунок</summary>
    <p className="mt-3 text-xs text-muted-foreground">Перевірте одержувача й надішліть привітання з місяцем «Учасника». Доступ почнеться після отримання подарунка користувачем. Один подарунок на рік за київським часом.</p>
    <form onSubmit={(event) => void verify(event)} className="mt-3 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">ID або посилання на профіль<input value={input} maxLength={250} required disabled={busy === 'offer'} onChange={(event) => {
        cancel(); currentInput.current = event.target.value; setInput(event.target.value); setGreetingName(''); setProfile(null); setResult(null); setError(''); setBusy(null)
      }} className={fieldClass} /></label>
      <button type="submit" disabled={Boolean(busy) || !input.trim()} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">{busy === 'verify' && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}Перевірити</button>
    </form>
    {confirmed && <div className="mt-3 rounded-xl bg-muted/50 p-3 text-sm">
      <p className="text-xs text-muted-foreground">Підтверджений одержувач</p>
      <p className="mt-1 break-words font-semibold">{confirmed.fullName || (confirmed.username ? '@' + confirmed.username : 'Користувач без імені')}</p>
      {confirmed.fullName && confirmed.username && <p className="mt-1 break-words text-xs text-muted-foreground">@{confirmed.username}</p>}
      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{confirmed.id}</p>
      <label className="mt-3 block text-xs text-muted-foreground">Ім’я у привітанні (необов’язково)<input value={greetingName} maxLength={80} autoComplete="off" disabled={Boolean(busy) || Boolean(result)} onChange={(event) => { setGreetingName(event.target.value); setError('') }} className={fieldClass} /></label>
      <p className="mt-1 text-xs text-muted-foreground">Залиште порожнім для привітання без імені.</p>
      <button type="button" onClick={() => void send()} disabled={Boolean(busy) || Boolean(result)} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy === 'offer' && <Loader2 size={15} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}Надіслати привітання з подарунком</button>
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {result && confirmed && <p role="status" className="mt-3 rounded-xl bg-accent p-3 text-sm text-primary">{result.claimed_at
      ? 'Цього року привітання вже надіслано, а подарунок отримано. Повторний місяць не надано.'
      : 'Привітання з подарунком надіслано. Місяць «Учасника» активується після натискання користувачем кнопки «Отримати подарунок».'}</p>}
  </details>
}
