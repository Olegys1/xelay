import { useMemo, useState } from 'react'
import { ArrowRight, GraduationCap, LockKeyhole, MailCheck, RotateCcw } from 'lucide-react'
import { AuthModal } from '../AuthModal'
import { KnuEmailVerification } from './KnuEmailVerification'
import { KnuAffiliationError, type KnuAffiliationClient, type KnuAffiliationStatus } from '../../lib/knuAffiliation'
import { normalizeKnuEmail } from '../../lib/knuEmailPolicy'

const userId = '20000000-0000-4000-8000-000000000001'
const empty = (): KnuAffiliationStatus => ({ verifiedEmail: null, verifiedAt: null, authEmailVerified: false })
function demoClient(): KnuAffiliationClient {
  let current = empty(), failures = 0
  return {
    async status() { return structuredClone(current) },
    async request(_userId, value) {
      const email = normalizeKnuEmail(value)
      if (!email) throw new KnuAffiliationError('KNU_EMAIL_INVALID')
      if (current.challenge && Date.parse(current.challenge.resendAt) > Date.now()) throw new KnuAffiliationError('KNU_EMAIL_RATE_LIMIT', 429, 60)
      failures = 0
      current = { ...empty(), challenge: { id: crypto.randomUUID(), email, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), resendAt: new Date(Date.now() + 60_000).toISOString() } }
      return structuredClone(current)
    },
    async verify(_userId, challengeId, code) {
      if (!current.challenge || current.challenge.id !== challengeId || Date.parse(current.challenge.expiresAt) <= Date.now() || failures >= 5) throw new KnuAffiliationError('KNU_EMAIL_CODE_EXPIRED')
      if (code !== '123456') { failures++; throw new KnuAffiliationError('KNU_EMAIL_CODE_INVALID') }
      current = { verifiedEmail: current.challenge.email, verifiedAt: new Date().toISOString(), authEmailVerified: false }
      return structuredClone(current)
    },
  }
}

export function LocalKnuEmailPreview() {
  const [auth, setAuth] = useState<'register' | 'login' | null>(null)
  const [revision, setRevision] = useState(0)
  const client = useMemo(demoClient, [revision])
  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-8"><span className="xelay-wordmark text-3xl">Xelay</span><span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">Локальний перегляд</span></div></header>
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
      <div className="max-w-2xl"><p className="text-xs font-semibold uppercase tracking-widest text-primary">Університетська спільнота</p><h1 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">Один профіль.<br />Підтверджена пошта КНУ.</h1><p className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base">Нові користувачі реєструються з @knu.ua. Ті, хто вже з нами, підтверджують університетську пошту у своєму профілі та продовжують користуватися звичним входом.</p></div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
        <section className="xelay-card self-start rounded-2xl border border-border p-5 sm:p-6"><GraduationCap className="text-primary" size={28} /><h2 className="mt-4 text-xl font-semibold">Новий акаунт</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Корпоративна пошта, лист для підтвердження та звичний профіль Xelay.</p><button className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground" onClick={() => setAuth('register')}>Переглянути реєстрацію <ArrowRight size={16} /></button><button className="mt-3 block min-h-10 text-sm font-medium text-primary" onClick={() => setAuth('login')}>Вхід у наявний акаунт</button><div className="mt-5 flex gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="shrink-0 text-primary" size={16} />Підтвердження пошти саме по собі не надає прав викладача або старости.</div></section>
        <div><div className="mb-3 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><MailCheck size={18} className="text-primary" />Уже маєте акаунт</h2><button className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs text-primary" onClick={() => setRevision(value => value + 1)}><RotateCcw size={13} />Скинути приклад</button></div><KnuEmailVerification key={revision} userId={userId} currentLoginEmail="student@example.test" client={client} initialStatus={empty()} /><p className="rounded-xl border border-dashed border-primary/25 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">Це приклад на вигаданих даних. Спробуйте name@knu.ua та код <strong className="text-primary">123456</strong>. Листи не надсилаються, робоча база не підключена.</p></div>
      </div>
    </div>
    {auth && <AuthModal initialTab={auth} onClose={() => setAuth(null)} />}
  </main>
}
