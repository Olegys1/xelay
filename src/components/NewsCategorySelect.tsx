import { useEffect, useRef, useState } from 'react'
import { listNewsCategories, type NewsCategory } from '../lib/newsCategories'

export function NewsCategorySelect({ universityId, academicUnitId, value, onChange, disabled = false, revision = '', retainedCategoryId }: {
  universityId: string | null
  academicUnitId: string | null
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  revision?: string | number
  retainedCategoryId?: string | null
}) {
  const scopeKey = `${universityId || 'platform'}:${academicUnitId || 'all'}`
  const [snapshot, setSnapshot] = useState<{ scope: string; categories: NewsCategory[]; error: boolean }>({ scope: '', categories: [], error: false })
  const sequence = useRef(0)
  useEffect(() => {
    const request = ++sequence.current
    void listNewsCategories(universityId, academicUnitId).then(({ data, error }) => {
      if (request === sequence.current) setSnapshot({ scope: scopeKey, categories: data || [], error: Boolean(error) })
    }).catch(() => {
      if (request === sequence.current) setSnapshot({ scope: scopeKey, categories: [], error: true })
    })
    return () => { sequence.current += 1 }
  }, [scopeKey, universityId, academicUnitId, revision])
  const current = snapshot.scope === scopeKey
  const categories = current ? snapshot.categories : []
  const currentCategory = categories.find((category) => category.id === value)
  const missing = Boolean(value) && current && !snapshot.error && !currentCategory
  return <label className="block text-sm font-medium">Категорія <span className="font-normal text-muted-foreground">· необов’язково</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled || !current}
      className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal disabled:opacity-60">
      <option value="">{current ? 'Без категорії' : 'Завантажуємо категорії…'}</option>
      {value && !categories.some((category) => category.id === value) && <option value={value}>{current && !snapshot.error ? 'Категорія більше недоступна' : 'Поточна категорія'}</option>}
      {currentCategory?.archived_at && <option value={currentCategory.id} disabled={currentCategory.id !== retainedCategoryId}>{currentCategory.name} · прибрана категорія</option>}
      {categories.filter((category) => !category.archived_at).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select>
    {current && snapshot.error && <span role="status" className="mt-1.5 block text-xs font-normal text-destructive">Не вдалося завантажити категорії. Оновіть сторінку, щоб обрати іншу.</span>}
    {missing && <span role="status" className="mt-1.5 block text-xs font-normal text-muted-foreground">Оберіть іншу категорію або «Без категорії».</span>}
    {currentCategory?.archived_at && <span className="mt-1.5 block text-xs font-normal text-muted-foreground">{currentCategory.id === retainedCategoryId ? 'Категорію прибрано зі списку. Її можна зберегти для цієї публікації або обрати іншу.' : 'Цю категорію вже прибрано. Оберіть іншу категорію або «Без категорії».'}</span>}
  </label>
}
