import { ArrowRight, Sparkles, X } from 'lucide-react'
import { useState } from 'react'

type Audience = 'teacher' | 'student'
type ReleaseCopy = { title: string; detail: string; action: string }
type AcademicRelease = { id: string } & Partial<Record<Audience, ReleaseCopy>>

// New entries go first. Include copy only for the audiences the release affects.
const releases: readonly AcademicRelease[] = [{
  id: '20261106-lecture-courses',
  teacher: {
    title: 'Лекції, тести й прогрес у курсі',
    detail: 'Додайте відеолекцію та тест під нею. У статистиці видно, хто завершив перегляд, хто здав тест і які запитання були найскладнішими.',
    action: 'Відкрити модулі',
  },
  student: {
    title: 'У групі з’явився розділ «Курс»',
    detail: 'Лекції та тести тепер поруч. Коли викладач опублікує курс, відкрийте відео, пройдіть тест під ним і переходьте до наступної теми.',
    action: 'Відкрити курс',
  },
}]
const dismissed = new Set<string>()

export function AcademicReleaseNotice({ userId, audience, onOpen }: {
  userId: string
  audience: Audience
  onOpen?: () => void
}) {
  const release = releases.find(entry => entry[audience])
  const update = release?.[audience]
  if (!release || !update) return null
  const key = `xelay:academic-release:${release.id}:${audience}:${encodeURIComponent(userId)}`
  return <ReleaseCard key={key} receiptKey={key} update={update} onOpen={onOpen} />
}

function ReleaseCard({ receiptKey, update, onOpen }: {
  receiptKey: string
  update: ReleaseCopy
  onOpen?: () => void
}) {
  const [hidden, setHidden] = useState(() => {
    if (dismissed.has(receiptKey)) return true
    try { return localStorage.getItem(receiptKey) === '1' } catch { return false }
  })
  if (hidden) return null
  function close() {
    dismissed.add(receiptKey)
    try { localStorage.setItem(receiptKey, '1') } catch { /* Keep the dismissal for this session. */ }
    setHidden(true)
  }
  return <aside aria-label="Що нового в Xelay" className="mb-4 flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Sparkles size={18} aria-hidden="true" /></span>
    <div className="min-w-0 flex-1">
      <p className="text-xs font-semibold text-primary">Що нового</p>
      <h2 className="mt-0.5 text-sm font-semibold">{update.title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{update.detail}</p>
      {onOpen && <button type="button" className="mt-1 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-primary hover:underline" onClick={onOpen}>{update.action}<ArrowRight size={14} aria-hidden="true" /></button>}
    </div>
    <button type="button" aria-label="Приховати новину про оновлення" className="-mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-background hover:text-foreground" onClick={close}><X size={17} aria-hidden="true" /></button>
  </aside>
}
