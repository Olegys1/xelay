import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import { teachingDate, teachingError, type TeachingOwnedMaterial, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingEmpty } from './TeachingUI'
import { TeachingResources } from './TeachingPublications'
import { TeachingMaterialWithdrawal } from './TeachingMaterialWithdrawal'

export function TeachingMyMaterials({ repository }: { repository: TeachingRepository }) {
  const [items, setItems] = useState<TeachingOwnedMaterial[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try { const data = await repository.myMaterials(); if (current === generation.current) { setItems(data.materials); setError('') } }
    catch (failure) { if (current === generation.current) setError(teachingError(failure)) }
    finally { if (current === generation.current) setLoading(false) }
  }, [repository])
  useEffect(() => { void load(); return () => { ++generation.current } }, [load])
  return <section className="space-y-4" aria-label="Мої матеріали">
    <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-xl text-sm leading-relaxed text-muted-foreground">Усі матеріали, які ви додали. Відкликання доступне також після завершення семестру чи відключення від предмета.</p><TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={15} />Оновити</TeachingButton></div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Завантажуємо ваші матеріали…</p>}
    {!loading && !error && !items.length && <TeachingEmpty icon={<FileText size={24} />} title="Ви ще не додавали матеріалів" description="Додайте матеріал у потрібному предметі та групі. Тут можна буде відкликати його в будь-який момент." />}
    <div className="teaching-list">{items.map(item => <article className="teaching-card" key={item.id}>
      <div className="flex flex-wrap gap-2"><span className="teaching-badge">{item.withdrawn_at ? 'Відкликано' : item.status === 'published' ? 'Опубліковано' : 'Чернетка'}</span>{item.course_archived_at && <span className="teaching-badge">Семестр завершено</span>}</div>
      <h3 className="mt-3 break-words font-semibold">{item.title}</h3><p className="mt-1 break-words text-xs text-muted-foreground">{item.course_title} · {item.author_name}{item.published_at ? ` · ${teachingDate(item.published_at)}` : ''}</p>
      {item.body && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>}
      {!item.withdrawn_at && <TeachingResources publication={item} repository={repository} />}
      {!item.withdrawn_at && item.can_withdraw && <div className="mt-4"><TeachingMaterialWithdrawal material={item} repository={repository} onWithdrawn={load} /></div>}
    </article>)}</div>
  </section>
}
