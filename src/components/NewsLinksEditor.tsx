import { useId } from 'react'
import { Link2, Plus, X } from 'lucide-react'
import { MAX_NEWS_LINKS, NewsLink } from '../lib/news'

export function NewsLinksEditor({ links, onChange, disabled = false }: { links: NewsLink[]; onChange: (links: NewsLink[]) => void; disabled?: boolean }) {
  const id = useId()
  const update = (index: number, key: keyof NewsLink, value: string) => onChange(links.map((link, item) => item === index ? { ...link, [key]: value } : link))
  return <div className="min-w-0 space-y-2">
    <p id={`${id}-label`} className="text-sm font-medium">Посилання <span className="font-normal text-muted-foreground">(необов’язково)</span></p>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">Додайте до 10 посилань на відео, реєстрацію чи матеріали. Назву можна залишити порожньою.</p>
    {links.map((link, index) => <div key={index} className="flex min-w-0 items-start gap-2 rounded-xl border border-border p-3">
      <Link2 size={17} className="mt-3 hidden shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
      <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
        <label className="min-w-0"><span className="sr-only">Назва посилання {index + 1}</span><input value={link.label} onChange={(event) => update(index, 'label', event.target.value)} maxLength={120} placeholder="Назва (необов’язково)" disabled={disabled} className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base sm:text-sm" /></label>
        <label className="min-w-0"><span className="sr-only">Адреса посилання {index + 1}</span><input name="linkUrl" type="url" value={link.url} onChange={(event) => update(index, 'url', event.target.value)} maxLength={2048} placeholder="https://…" disabled={disabled} aria-describedby={`${id}-hint`} className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-base sm:text-sm" /></label>
      </div>
      <button type="button" onClick={() => onChange(links.filter((_, item) => item !== index))} disabled={disabled} aria-label={`Видалити посилання ${index + 1}`} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50"><X size={17} /></button>
    </div>)}
    <button type="button" disabled={disabled || links.length >= MAX_NEWS_LINKS} onClick={() => onChange([...links, { label: '', url: '' }])} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><Plus size={17} aria-hidden="true" /> Додати посилання</button>
  </div>
}
