import { useId, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { searchDeanPeople, type DeanPersonOption } from '../lib/deanPeopleSearch'

export function DeanPersonPicker({ options, value, onChange, label }: {
  options: readonly DeanPersonOption[]
  value: string
  onChange: (id: string) => void
  label: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => searchDeanPeople(options, query), [options, query])
  const visible = matches.slice(0, 40)
  const selected = options.find(option => option.id === value)
  const activeIndex = Math.min(active, visible.length - 1)
  const choose = (option: DeanPersonOption) => { onChange(option.id); setOpen(false) }
  const begin = () => { setQuery(''); setActive(0); setOpen(true) }

  return <div className="dean-person-picker" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <Search size={16} aria-hidden="true" />
    <input role="combobox" aria-label={label} aria-expanded={open}
      aria-autocomplete="list" aria-controls={open ? `${id}-list` : undefined}
      aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
      autoComplete="off" placeholder="Введіть кілька літер…"
      value={open ? query : selected?.name ?? ''}
      onFocus={begin} onClick={() => { if (!open) begin() }}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) { begin(); return }
          const next = Math.max(0, Math.min(visible.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)))
          setActive(next)
          event.currentTarget.parentElement?.querySelector(`[data-option-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
        }
        if (event.key === 'Enter' && open) {
          event.preventDefault()
          if (visible[activeIndex]) choose(visible[activeIndex])
        }
      }} />
    {open && <div className="dean-person-results">
      <div className="dean-person-count" role="status">{matches.length ? `Знайдено: ${matches.length}` : 'Нічого не знайдено. Спробуйте інші літери.'}</div>
      <div id={`${id}-list`} role="listbox" aria-label={label} className="dean-person-options">
        {visible.map((option, index) => <button type="button" role="option" id={`${id}-${index}`} key={option.id}
          data-option-index={index} aria-selected={option.id === value} tabIndex={-1}
          className={index === activeIndex ? 'is-active' : ''}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
          <span>{option.name}</span>{option.group && <small>{option.group}</small>}
        </button>)}
      </div>
      {matches.length > visible.length && <div className="dean-person-count">Перші 40 результатів. Додайте літери, щоб звузити пошук.</div>}
    </div>}
  </div>
}
