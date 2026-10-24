import { useState } from 'react'
import { ArrowRight, Check, Link2, Pencil, RotateCcw } from 'lucide-react'
import { getStudyGroupLessonLinks, type StudyGroupLessonLinkSource } from '../../lib/studyGroupLinks'

type Kind = 'lecture' | 'seminar'
const kinds: Kind[] = ['lecture', 'seminar']
const labels = { lecture: 'Лекція', seminar: 'Семінар' }
const times = { lecture: '08:00–09:20', seminar: '11:20–12:40' }
const initial: Record<Kind, StudyGroupLessonLinkSource> = {
  lecture: { online_url: 'https://example.invalid/lecture', online_url_label: 'Лекція', online_url_secondary: 'https://example.invalid/lecture-notes', online_url_secondary_label: 'Матеріали лекції' },
  seminar: { online_url: 'https://example.invalid/seminar', online_url_label: 'Семінар', online_url_secondary: 'https://example.invalid/seminar-tasks', online_url_secondary_label: 'Завдання семінару' },
}

/** Isolated fictional illustration; never contacts Supabase or saves real data. */
export function LocalScheduleCopyLinksPreview() {
  const [source, setSource] = useState(initial)
  const [custom, setCustom] = useState(initial)
  const [inherit, setInherit] = useState<Record<Kind, boolean>>({ lecture: true, seminar: true })
  const [editing, setEditing] = useState<Kind | null>(null)
  const [revision, setRevision] = useState<Record<Kind, number>>({ lecture: 1, seminar: 1 })
  const [message, setMessage] = useState('')
  const resolved = (kind: Kind) => inherit[kind] ? source[kind] : custom[kind]
  const reset = () => { setSource(initial); setCustom(initial); setInherit({ lecture: true, seminar: true }); setRevision({ lecture: 1, seminar: 1 }); setEditing(null); setMessage('Приклад скинуто.') }
  function changeSource(kind: Kind) {
    const next = revision[kind] + 1
    setRevision(value => ({ ...value, [kind]: next }))
    setSource(value => ({ ...value, [kind]: { ...value[kind], online_url: `https://example.invalid/${kind}-v${next}`, online_url_label: `${labels[kind]} · нове посилання` } }))
    setMessage(inherit[kind] ? `${labels[kind]}: суботня копія отримала нове посилання автоматично.` : `${labels[kind]}: у суботи власне посилання, тому воно залишилося незмінним.`)
  }
  function setInheritance(kind: Kind, checked: boolean) {
    if (!checked) setCustom(value => ({ ...value, [kind]: { ...resolved(kind) } }))
    setInherit(value => ({ ...value, [kind]: checked }))
    setMessage(checked ? 'Автоматичне оновлення посилань увімкнено.' : 'Для цієї суботньої пари можна вказати власні посилання.')
  }
  return <main className="min-h-screen px-4 py-6 sm:px-8" style={{ background: '#151121', color: '#f5edde' }}>
    <div className="mx-auto max-w-6xl">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#ffaf69' }}>Xelay · локальний приклад</p><h1 className="mt-2 text-3xl font-semibold">Посилання для суботніх пар</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed opacity-75">Змініть посилання вихідної лекції або семінару. Суботня копія оновиться автоматично. Для окремої пари можна вимкнути цей зв’язок.</p></div><button className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm" onClick={reset}><RotateCcw size={16} />Скинути приклад</button></header>
      <div role="status" className="mb-6 min-h-12 rounded-2xl border px-4 py-3 text-sm" style={{ borderColor: '#ff9c4b55', background: '#ff9c4b10' }}>{message || 'У цьому прикладі лекційні та семінарські посилання залишаються окремими.'}</div>
      <div className="grid gap-6 lg:grid-cols-2">{(['source', 'copy'] as const).map(column => <section key={column} className="min-w-0"><h2 className="mb-4 flex items-center gap-3 text-xl font-semibold">{column === 'source' ? 'Середа, 28 жовтня' : <><ArrowRight size={20} />Субота, 31 жовтня</>}</h2><p className="mb-4 text-xs opacity-65">{column === 'source' ? 'Вихідні пари · повторюються щотижня' : 'Скопійовані пари · лише на цю дату'}</p><div className="space-y-4">{kinds.map(kind => {
        const links = column === 'source' ? source[kind] : resolved(kind)
        return <article key={kind} className="rounded-3xl border p-5" style={{ borderColor: kind === 'lecture' ? '#5868cf66' : '#aa775866', background: '#241d34' }}>
          <div className="flex items-center justify-between gap-3"><span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: '#ff9c4b18', color: '#ffc28b' }}>{labels[kind]}</span><span className="text-xs opacity-70">{times[kind]}</span></div>
          <h3 className="mt-3 text-xl font-semibold">ВДУС</h3><p className="mt-1 text-sm opacity-65">{kind === 'lecture' ? '225/2' : '909'}</p>
          <div className="mt-4 flex flex-wrap gap-2">{getStudyGroupLessonLinks(links).map(link => <span key={link.slot} title={link.url} className="inline-flex max-w-full items-center gap-2 rounded-full border border-orange-300/25 px-3 py-2 text-xs" style={{ color: '#ffc28b' }}><Link2 size={13} />{link.label}</span>)}</div>
          {column === 'source' ? <><p className="mt-3 break-all text-xs opacity-60">{links.online_url}</p><button onClick={() => changeSource(kind)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold" style={{ background: '#ff9c4b', color: '#211625' }}><Pencil size={14} />Змінити посилання {kind === 'lecture' ? 'лекції' : 'семінару'}</button></> : <>
            <p className="mt-3 flex items-center gap-2 text-xs" style={{ color: inherit[kind] ? '#9bddbc' : '#ffcc8f' }}>{inherit[kind] && <Check size={14} />}{inherit[kind] ? 'Посилання оновлюються з вихідної пари' : 'Для цієї пари вказані власні посилання'}</p><p className="mt-2 break-all text-xs opacity-60">{links.online_url}</p>
            <button onClick={() => setEditing(editing === kind ? null : kind)} aria-expanded={editing === kind} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm"><Pencil size={14} />Налаштувати посилання</button>
            {editing === kind && <div className="mt-4 space-y-3 border-t border-white/10 pt-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 accent-orange-400" checked={inherit[kind]} onChange={event => setInheritance(kind, event.target.checked)} />Оновлювати посилання разом із вихідною парою</label><p className="text-xs leading-relaxed opacity-65">Вимкніть позначку, щоб зберегти окремі посилання лише для цієї суботи.</p>{([1, 2] as const).map(slot => {
              const urlKey = slot === 1 ? 'online_url' : 'online_url_secondary'
              const labelKey = slot === 1 ? 'online_url_label' : 'online_url_secondary_label'
              return <fieldset key={slot} disabled={inherit[kind]} className="space-y-2 rounded-xl border border-white/10 p-3 disabled:opacity-50"><legend className="px-1 text-xs">Посилання {slot}</legend><input aria-label={`${labels[kind]} · посилання ${slot}`} value={links[urlKey] || ''} onChange={event => { const value = event.target.value; setCustom(rows => ({ ...rows, [kind]: { ...rows[kind], [urlKey]: value } })) }} className="w-full rounded-xl border border-white/20 bg-transparent p-2 text-sm" /><input aria-label={`${labels[kind]} · назва ${slot}`} value={links[labelKey] || ''} onChange={event => { const value = event.target.value; setCustom(rows => ({ ...rows, [kind]: { ...rows[kind], [labelKey]: value } })) }} className="w-full rounded-xl border border-white/20 bg-transparent p-2 text-sm" /></fieldset>
            })}</div>}
          </>}
        </article>
      })}</div></section>)}</div>
      <p className="mt-7 text-xs leading-relaxed opacity-60">Вигадані дані та адреси example.invalid. Зміни існують лише на цій сторінці: акаунти, робочі розклади й посилання користувачів не змінюються.</p>
    </div>
  </main>
}
