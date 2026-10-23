import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import { NEWS_TYPE_LABELS, type NewsPostType } from '../lib/news'
import { listNewsCategorySettings, NewsCategoryMutationError, setNewsCategoryVisibility, type NewsCategorySettings, type NewsCategoryTarget } from '../lib/newsCategories'

type CategoryRow = { key: string; name: string; standard: boolean; hidden: boolean; target: NewsCategoryTarget }

export function NewsCategoryManager({ universityId, academicUnitId, scopeLabel, onChanged, onClose }: {
  universityId: string | null
  academicUnitId: string | null
  scopeLabel: string
  onChanged: (settings: NewsCategorySettings) => void
  onClose: () => void
}) {
  const [settings, setSettings] = useState<NewsCategorySettings | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)
  const [confirm, setConfirm] = useState<CategoryRow | null>(null)
  const [notice, setNotice] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const sequence = useRef(0), actionLock = useRef(false)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const load = useCallback(async (preserveError = false) => {
    const request = ++sequence.current
    setLoading(true)
    if (!preserveError) setError('')
    try {
      const data = await listNewsCategorySettings(universityId, academicUnitId)
      if (request !== sequence.current) return
      setSettings(data); changed.current(data)
    } catch (failure) { if (request === sequence.current) setError(failure instanceof Error ? failure.message : 'Не вдалося завантажити категорії.') }
    finally { if (request === sequence.current) setLoading(false) }
  }, [universityId, academicUnitId])

  useEffect(() => {
    const node = dialog.current!
    const focus = document.activeElement as HTMLElement | null
    node.showModal()
    void load()
    return () => { sequence.current += 1; node.close(); focus?.focus() }
  }, [load])

  async function change(row: CategoryRow, hidden: boolean) {
    if (actionLock.current || !settings || loading) return
    actionLock.current = true
    const request = ++sequence.current
    setBusy(row.key); setError(''); setNotice('')
    try {
      const next = await setNewsCategoryVisibility(row.target, hidden, settings.version, universityId, academicUnitId)
      if (request !== sequence.current) return
      setSettings(next); changed.current(next); setConfirm(null)
      setNotice(hidden ? `Категорію «${row.name}» прибрано. Її можна повернути у вкладці «Прибрані».` : `Категорію «${row.name}» відновлено.`)
    } catch (failure) {
      if (request !== sequence.current) return
      setError(failure instanceof Error ? failure.message : 'Не вдалося змінити категорію.')
      setConfirm(null)
      if (failure instanceof NewsCategoryMutationError && failure.code === 'NEWS_CATEGORY_CONFLICT') await load(true)
    } finally {
      actionLock.current = false
      setBusy('')
    }
  }

  const rows: CategoryRow[] = settings ? [
    ...Object.entries(NEWS_TYPE_LABELS).map(([postType, name]) => ({ key: `type:${postType}`, name, standard: true, hidden: settings.hidden_types.includes(postType as NewsPostType), target: { postType: postType as NewsPostType } })),
    ...settings.categories.map(category => ({ key: category.id, name: category.name, standard: false, hidden: Boolean(category.archived_at), target: { categoryId: category.id } })),
  ] : []
  const activeCount = rows.filter(row => !row.hidden).length, removedCount = rows.filter(row => row.hidden).length
  return <dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby="news-manage-categories-title" aria-describedby="news-manage-categories-description"
    onCancel={event => { event.preventDefault(); if (!actionLock.current) onClose() }}
    className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl overflow-y-auto rounded-2xl border border-border bg-background p-5 text-foreground shadow-2xl backdrop:bg-foreground/45 backdrop:backdrop-blur-sm sm:p-6">
    <header className="flex items-start justify-between gap-3"><div><h2 id="news-manage-categories-title" className="text-lg font-bold">Керування категоріями</h2><p className="mt-1 text-xs font-medium text-primary">{scopeLabel}</p></div><button type="button" disabled={Boolean(busy)} onClick={onClose} aria-label="Закрити керування категоріями" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><X size={19} /></button></header>
    <p id="news-manage-categories-description" className="mt-4 text-sm leading-relaxed text-muted-foreground">Прибрана категорія зникне зі списку фільтрів цієї вкладки. Усі її публікації залишаться в «Усі», а категорію можна буде відновити.</p>
    <div className="mt-5 flex gap-2" role="tablist" aria-label="Стан категорій"><button type="button" role="tab" aria-selected={!showRemoved} disabled={Boolean(busy)} onClick={() => { setShowRemoved(false); setConfirm(null) }} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium ${!showRemoved ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>Активні{settings ? ` · ${activeCount}` : ''}</button><button type="button" role="tab" aria-selected={showRemoved} disabled={Boolean(busy)} onClick={() => { setShowRemoved(true); setConfirm(null) }} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-medium ${showRemoved ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'}`}>Прибрані{settings ? ` · ${removedCount}` : ''}</button></div>
    {error && <div role="alert" className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><p>{error}</p>{!busy && <button type="button" onClick={() => void load()} className="mt-2 font-semibold underline">Оновити список</button>}</div>}
    {notice && <p role="status" className="mt-4 rounded-xl bg-muted p-3 text-sm">{notice}</p>}
    {loading ? <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={17} className="animate-spin" />Завантажуємо категорії…</p> : settings && <ul className="mt-4 space-y-2">{rows.filter(row => row.hidden === showRemoved).map(row => <li key={row.key} className="rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-semibold">{row.name}</p><p className="mt-1 text-xs text-muted-foreground">{row.standard ? 'Стандартна категорія' : 'Власна категорія'}</p></div>{row.hidden ? <button type="button" disabled={Boolean(busy)} onClick={() => void change(row, false)} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-2 text-xs font-semibold hover:bg-muted disabled:opacity-50">{busy === row.key ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}Відновити</button> : <button type="button" disabled={Boolean(busy)} onClick={() => { setConfirm(row); setError(''); setNotice('') }} className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border border-destructive/20 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50"><Trash2 size={14} />Прибрати</button>}</div>
      {confirm?.key === row.key && <div role="alert" className="mt-3 border-t border-border pt-3"><p className="text-sm">Прибрати «{row.name}» лише з цього розділу? Публікації збережуться.</p><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm(null)} className="min-h-10 rounded-full border border-border px-4 py-2 text-xs font-semibold disabled:opacity-50">Залишити</button><button type="button" disabled={Boolean(busy)} onClick={() => void change(row, true)} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">{busy === row.key && <Loader2 size={14} className="animate-spin" />}Так, прибрати</button></div></div>}
    </li>)}{!rows.some(row => row.hidden === showRemoved) && <li className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{showRemoved ? 'Прибраних категорій поки немає.' : 'Категорії прибрано. Усі публікації доступні у вкладці «Усі».'}</li>}</ul>}
    <footer className="mt-5 flex justify-end border-t border-border pt-4"><button type="button" disabled={Boolean(busy)} onClick={onClose} className="min-h-11 rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50">Готово</button></footer>
  </dialog>
}
