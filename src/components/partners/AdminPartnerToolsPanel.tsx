import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { BarChart3, Eye, EyeOff, ImagePlus, Loader2, Pencil, Plus, RefreshCw, Wrench } from 'lucide-react'
import { ChatDialog, ChatField, chatButton, chatInput, chatPrimary } from '../CommunityChatPrimitives'
import {
  partnerToolCategories, partnerToolDateDaysAgo, partnerToolsApi, partnerToolsError, partnerToolStatuses,
  partnerToolToday, validPartnerStatsRange, type PartnerTool, type PartnerToolInput, type PartnerToolsAdminData, type PartnerToolsApi,
} from '../../lib/partnerTools'

const newTool = (): PartnerToolInput => ({ name: '', description: '', category: 'study', logoUrl: '', destinationUrl: '', status: 'draft', featured: false, sortOrder: 100 })
const number = (value: number) => new Intl.NumberFormat('uk-UA').format(value)

export function AdminPartnerToolsPanel({ actorId, api = partnerToolsApi, onChanged }: { actorId: string; api?: PartnerToolsApi; onChanged?: () => void }) {
  const [range, setRange] = useState(() => ({ from: partnerToolDateDaysAgo(29), to: partnerToolToday() }))
  const [from, setFrom] = useState(range.from), [to, setTo] = useState(range.to)
  const [data, setData] = useState<PartnerToolsAdminData | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<PartnerToolInput | null>(null), [formError, setFormError] = useState('')
  const [detailTool, setDetailTool] = useState('all')
  const owner = useRef(actorId); owner.current = actorId
  const mounted = useRef(false), generation = useRef(0), mutation = useRef(false)
  const changed = useRef(onChanged); changed.current = onChanged
  const current = useCallback(() => mounted.current && owner.current === actorId, [actorId])
  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await api.listAdmin(range.from, range.to)
      if (current() && request === generation.current) setData(next)
    } catch (failure) {
      if (current() && request === generation.current) { setError(partnerToolsError(failure)); setData(null) }
    } finally { if (current() && request === generation.current) setLoading(false) }
  }, [api, current, range])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current } }, [])
  useEffect(() => { void load() }, [load])

  const edit = (tool?: PartnerTool) => { setFormError(''); setNotice(''); setDraft(tool ? { ...tool } : newTool()) }
  const save = async (input: PartnerToolInput, modal = false) => {
    if (mutation.current || !current()) return
    mutation.current = true; setBusy(true); setFormError(''); setError(''); setNotice('')
    try {
      await api.save(input, actorId)
      if (!current()) return
      if (modal) setDraft(null)
      setNotice(input.status === 'published' ? 'Картку збережено. Вона доступна у каталозі всім відвідувачам.' : input.status === 'hidden' ? 'Картку приховано. Історія переходів збережена.' : 'Чернетку збережено. Відвідувачі її ще не бачать.')
      changed.current?.(); await load()
    } catch (failure) {
      if (current()) (modal ? setFormError : setError)(partnerToolsError(failure))
    } finally { mutation.current = false; if (current()) setBusy(false) }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); if (draft) void save(draft, true) }
  const upload = async (file?: File) => {
    if (!file || !draft || mutation.current) return
    mutation.current = true; setBusy(true); setFormError('')
    try {
      const logoUrl = await api.uploadLogo(file, actorId)
      if (current()) setDraft(value => value ? { ...value, logoUrl } : value)
    } catch (failure) { if (current()) setFormError(partnerToolsError(failure)) }
    finally { mutation.current = false; if (current()) setBusy(false) }
  }
  const update = <K extends keyof PartnerToolInput>(field: K, value: PartnerToolInput[K]) => setDraft(previous => previous ? { ...previous, [field]: value } : previous)
  const applyRange = (event: FormEvent) => {
    event.preventDefault()
    if (!validPartnerStatsRange(from, to)) { setError('Оберіть період до 366 днів, де початок не пізніше за кінець.'); return }
    setRange({ from, to }); setNotice('')
  }
  const preset = (days: number) => {
    const next = { from: partnerToolDateDaysAgo(days - 1), to: partnerToolToday() }
    setFrom(next.from); setTo(next.to); setRange(next); setNotice('')
  }
  const items = [...(data?.items || [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'uk'))
  const daily = (data?.daily || []).filter(day => detailTool === 'all' || day.toolId === detailTool)
  const total = (data?.daily || []).reduce((sum, day) => sum + day.clicks, 0)
  const home = (data?.daily || []).filter(day => day.source === 'home').reduce((sum, day) => sum + day.clicks, 0)
  const dailyRows = new Map<string, { home: number; catalog: number }>()
  for (const day of daily) {
    const row = dailyRows.get(day.date) || { home: 0, catalog: 0 }
    row[day.source] += day.clicks; dailyRows.set(day.date, row)
  }

  return <section id="admin-partner-tools" aria-labelledby="partner-admin-title" className="xelay-card mb-6 overflow-hidden">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
      <div><p className="mb-1 text-[11px] font-semibold uppercase tracking-[.15em] text-primary">Каталог Xelay</p><h2 id="partner-admin-title" className="flex items-center gap-2 text-lg font-semibold"><Wrench size={20} aria-hidden="true" />Корисні інструменти</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">Картки партнерів, розміщення на головній та статистика переходів.</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" className={chatButton} onClick={() => void load()} disabled={loading || busy}><RefreshCw size={15} aria-hidden="true" />Оновити</button><button type="button" className={chatPrimary} onClick={() => edit()} disabled={busy}><Plus size={16} aria-hidden="true" />Додати інструмент</button></div>
    </header>
    <div className="space-y-5 p-5 sm:p-6">
      {notice && <p role="status" className="rounded-xl border border-emerald-600/20 bg-emerald-500/5 px-4 py-3 text-sm">{notice}</p>}
      {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p>}
      <form onSubmit={applyRange} className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1.5"><button type="button" className={chatButton} disabled={busy} onClick={() => preset(7)}>7 днів</button><button type="button" className={chatButton} disabled={busy} onClick={() => preset(30)}>30 днів</button></div>
        <label className="min-w-0 text-xs text-muted-foreground">Від<input type="date" className={`${chatInput} mt-1 block`} value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} required disabled={busy} /></label>
        <label className="min-w-0 text-xs text-muted-foreground">До<input type="date" className={`${chatInput} mt-1 block`} value={to} min={from || undefined} onChange={event => setTo(event.target.value)} required disabled={busy} /></label>
        <button type="submit" className={chatButton} disabled={busy || loading}>Застосувати</button>
      </form>
      <div className="grid gap-3 sm:grid-cols-3" aria-label="Статистика переходів за обраний період">
        {[[total, 'Зараховані переходи'], [home, 'Із головної'], [total - home, 'Із каталогу']].map(([value, label]) => <div className="rounded-2xl border border-border p-4" key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{loading ? '—' : number(Number(value))}</p></div>)}
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">Переходи рахуються за київським часом. Повторні натискання на один інструмент у цьому браузері протягом 30 хвилин дають один перехід, навіть із різних розділів. Відомі боти й попередні завантаження не зараховуються. Це статистика переходів, а не кількість людей або рахунок до сплати.</p>
      {loading ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 size={18} className="animate-spin" />Завантаження карток і статистики…</div> : <>
        {!items.length && !error ? <div className="rounded-2xl border border-dashed border-border px-5 py-10 text-center"><h3 className="font-semibold">Почніть із першого партнера</h3><p className="mt-2 text-sm text-muted-foreground">Додайте назву, логотип, короткий опис і посилання. Спершу можна зберегти чернетку.</p><button type="button" className={`${chatPrimary} mt-5`} onClick={() => edit()}><Plus size={16} />Додати інструмент</button></div> : null}
        <div className="space-y-3">
          {items.map(tool => <article className="rounded-2xl border border-border p-4 sm:p-5" key={tool.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-semibold">{tool.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${tool.status === 'published' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>{partnerToolStatuses[tool.status]}</span>{tool.featured && <span className="rounded-full bg-primary/5 px-2.5 py-1 text-[11px] text-primary">На головній</span>}</div><p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{tool.description}</p><p className="mt-2 break-all text-xs text-muted-foreground">{tool.destinationUrl}</p></div>
              <div className="text-right"><p className="text-2xl font-semibold tabular-nums">{number(tool.clicks)}</p><p className="text-[11px] text-muted-foreground">переходів за період</p></div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">{partnerToolCategories[tool.category]} · Позиція {tool.sortOrder}</span>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className={chatButton} disabled={busy} onClick={() => edit(tool)}><Pencil size={14} />Редагувати</button>
                {tool.status === 'published' && <button type="button" className={chatButton} disabled={busy} onClick={() => void save({ ...tool, status: 'hidden' })}><EyeOff size={15} />Приховати</button>}
                {tool.status === 'hidden' && <button type="button" className={chatButton} disabled={busy} onClick={() => void save({ ...tool, status: 'published' })}><Eye size={15} />Показати</button>}
              </div>
            </div>
          </article>)}
        </div>
        <details className="rounded-2xl border border-border p-4">
          <summary className="cursor-pointer text-sm font-medium"><BarChart3 className="mr-2 inline" size={17} aria-hidden="true" />Переходи за днями</summary>
          <label className="mt-4 block max-w-sm text-xs text-muted-foreground">Інструмент<select className={`${chatInput} mt-1`} value={detailTool} onChange={event => setDetailTool(event.target.value)}><option value="all">Усі інструменти</option>{items.map(tool => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label>
          <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[330px] text-left text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="pb-2 font-medium">Дата</th><th className="pb-2 font-medium">Головна</th><th className="pb-2 font-medium">Каталог</th><th className="pb-2 font-medium">Разом</th></tr></thead><tbody>{[...dailyRows.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, counts]) => <tr className="border-b border-border/60" key={date}><td className="py-2">{date.split('-').reverse().join('.')}</td><td className="py-2 tabular-nums">{number(counts.home)}</td><td className="py-2 tabular-nums">{number(counts.catalog)}</td><td className="py-2 tabular-nums">{number(counts.home + counts.catalog)}</td></tr>)}</tbody></table>{!dailyRows.size && <p className="py-5 text-sm text-muted-foreground">За цей період переходів ще немає.</p>}</div>
        </details>
      </>}
    </div>
    {draft && <ChatDialog title={draft.id ? 'Редагувати інструмент' : 'Новий інструмент'} busy={busy} onClose={() => setDraft(null)} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">Назва й опис з’являться в каталозі. Публікуйте лише погоджені з партнером дані та посилання.</p>
        {formError && <p role="alert" className="rounded-xl bg-destructive/5 px-4 py-3 text-sm text-destructive">{formError}</p>}
        <div className="grid gap-4 sm:grid-cols-2"><ChatField label="Назва"><input className={chatInput} autoComplete="off" value={draft.name} onChange={event => update('name', event.target.value)} maxLength={80} minLength={2} required disabled={busy} /></ChatField><ChatField label="Категорія"><select className={chatInput} value={draft.category} onChange={event => update('category', event.target.value as PartnerTool['category'])} disabled={busy}>{Object.entries(partnerToolCategories).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></ChatField></div>
        <ChatField label="Чим стане у пригоді"><textarea className={chatInput} rows={3} value={draft.description} onChange={event => update('description', event.target.value)} maxLength={240} required disabled={busy} /></ChatField>
        <ChatField label="Посилання на продукт"><input type="url" className={chatInput} placeholder="https://…" value={draft.destinationUrl} onChange={event => update('destinationUrl', event.target.value)} maxLength={2048} required disabled={busy} /></ChatField>
        <div className="rounded-2xl border border-border p-4"><h3 className="text-sm font-semibold">Логотип</h3><p className="mt-1 text-xs text-muted-foreground">PNG, JPG або WebP до 2 МБ. Без логотипа картка матиме ініціали назви.</p><label className={`${chatButton} relative mt-3 cursor-pointer overflow-hidden focus-within:ring-2 focus-within:ring-primary`}><ImagePlus size={16} />Завантажити логотип<input className="absolute inset-0 h-full w-full cursor-pointer opacity-0" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file) }} /></label><label className="mt-3 block text-xs text-muted-foreground">Або HTTPS-посилання на зображення<input type="url" className={`${chatInput} mt-1`} value={draft.logoUrl.startsWith('data:') || draft.logoUrl.startsWith('blob:') ? '' : draft.logoUrl} onChange={event => update('logoUrl', event.target.value)} maxLength={2048} placeholder="https://…" disabled={busy} /></label>{draft.logoUrl && <div className="mt-3 flex items-center gap-3"><span className="text-xs text-primary">Логотип додано</span><button type="button" className="text-xs underline" disabled={busy} onClick={() => update('logoUrl', '')}>Прибрати логотип із картки</button></div>}</div>
        <div className="grid gap-4 sm:grid-cols-2"><ChatField label="Видимість"><select className={chatInput} value={draft.status} onChange={event => update('status', event.target.value as PartnerTool['status'])} disabled={busy}>{Object.entries(partnerToolStatuses).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></ChatField><ChatField label="Позиція в каталозі"><input type="number" className={chatInput} value={draft.sortOrder} min={0} max={9999} step={1} required onChange={event => update('sortOrder', Number(event.target.value))} disabled={busy} /></ChatField></div>
        <label className="flex items-start gap-3 rounded-xl bg-muted/50 p-3 text-sm"><input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={draft.featured} onChange={event => update('featured', event.target.checked)} disabled={busy} /><span>Показувати в невеликому блоці на головній<span className="mt-1 block text-xs text-muted-foreground">На головній відображаються до трьох опублікованих карток із цією позначкою.</span></span></label>
        <p className="text-xs text-muted-foreground">{draft.status === 'published' ? 'Після збереження картку бачитимуть гості, студенти, старости й викладачі.' : 'Відвідувачі не бачитимуть цю картку, доки ви не оберете «Опубліковано».'}</p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button type="button" className={chatButton} disabled={busy} onClick={() => setDraft(null)}>Скасувати</button><button type="submit" className={chatPrimary} disabled={busy}>{busy && <Loader2 size={15} className="animate-spin" />}{draft.status === 'published' ? 'Зберегти та опублікувати' : 'Зберегти картку'}</button></div>
      </form>
    </ChatDialog>}
  </section>
}
