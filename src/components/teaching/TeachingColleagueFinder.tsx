import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { TeachingRepository } from '../../lib/teaching'
import { normalizeTeachingNickname, type TeachingColleague } from '../../lib/teachingColleagues'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

export function TeachingColleagueFinder({ courseId, repository, disabled, onSelect }: {
  courseId: string; repository: TeachingRepository; disabled: boolean; onSelect(value: TeachingColleague | null): void
}) {
  const [query, setQuery] = useState(''), [found, setFound] = useState<TeachingColleague | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null), generation = useRef(0)
  const current = useRef({ courseId, repository, query }); current.current = { courseId, repository, query }
  useEffect(() => () => { ++generation.current; request.current?.abort() }, [courseId, repository])
  async function find() {
    if (busy || disabled) return
    let name: string
    try { name = normalizeTeachingNickname(query) } catch (failure) { setError((failure as Error).message); return }
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    const run = ++generation.current, input = query
    const valid = () => !controller.signal.aborted && generation.current === run && current.current.courseId === courseId && current.current.repository === repository && current.current.query === input
    const timer = window.setTimeout(() => { controller.abort(); if (generation.current === run) { setBusy(false); setError('Перевірка затримується. Спробуйте ще раз.') } }, 12000)
    setBusy(true); setFound(null); setError(''); onSelect(null)
    try {
      const value = await repository.findColleague(courseId, name, controller.signal)
      if (!valid()) return
      if (!value) { setError('Підтвердженого викладача з таким нікнеймом у вашому університеті не знайдено.'); return }
      setFound(value)
      if (['pending', 'accepted'].includes(value.status)) setError(value.status === 'pending' ? 'Цей колега вже має запрошення до предмета.' : 'Цей колега вже викладає предмет. Його групи й дозволи можна змінити у списку викладачів.')
      else onSelect(value)
    } catch { if (valid()) setError('Не вдалося перевірити викладача. Повторіть спробу.') }
    finally { window.clearTimeout(timer); if (request.current === controller && generation.current === run) { request.current = null; setBusy(false) } }
  }
  return <div className="space-y-3"><TeachingField label="Нікнейм колеги" hint="Введіть точний @нікнейм. Перевірка покаже підтвердженого викладача перед запрошенням."><div className="flex flex-wrap gap-2"><input name="colleague-nickname" className={`${teachingInput} min-w-0 flex-1 basis-48`} value={query} disabled={disabled} autoComplete="off" maxLength={31} placeholder="@nickname" onChange={event => { ++generation.current; request.current?.abort(); setQuery(event.target.value); setFound(null); setError(''); setBusy(false); onSelect(null) }} /><TeachingButton busy={busy} disabled={disabled || !query.trim()} onClick={() => void find()}><Search size={15} />Перевірити</TeachingButton></div></TeachingField>
    {found && <div role="status" className="rounded-xl border border-border p-3"><p className="text-sm font-semibold">{found.full_name}</p><p className="mt-1 text-xs text-muted-foreground">@{found.username} · {found.department}{found.position ? ` · ${found.position}` : ''}</p><p className="mt-2 text-xs font-medium text-primary">Підтверджений викладач · колега зі спільного викладання</p></div>}
    {error && <p role="alert" className="teaching-error">{error}</p>}
  </div>
}
