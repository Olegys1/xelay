import { useEffect, useState } from 'react'
import type { TeachingRepository } from '../../lib/teaching'
import { teachingError } from '../../lib/teaching'
import { EMPTY_TEACHING_AUDIENCE, type TeachingAudienceContext, type TeachingAudienceTarget } from '../../lib/teachingAudience'
import { TeachingButton, TeachingField, teachingInput } from './TeachingUI'

export function TeachingAudienceFields({ repository, courseId, groupId, itemId, allowTeams = true, subgroupsOnly = false, value, onChange, disabled = false }: { repository: TeachingRepository; courseId: string; groupId: string; itemId?: string; allowTeams?: boolean; subgroupsOnly?: boolean; value: TeachingAudienceTarget; onChange: (value: TeachingAudienceTarget) => void; disabled?: boolean }) {
  const [result, setResult] = useState<{ repository: TeachingRepository; courseId: string; data: TeachingAudienceContext; loading: boolean; error: string }>({ repository, courseId: '', data: EMPTY_TEACHING_AUDIENCE, loading: true, error: '' })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    if (value.audience_mode === 'all') { setResult({ repository, courseId, data: EMPTY_TEACHING_AUDIENCE, loading: false, error: '' }); return }
    setResult({ repository, courseId, data: EMPTY_TEACHING_AUDIENCE, loading: true, error: '' })
    if (!repository.audiences) { setResult({ repository, courseId, data: EMPTY_TEACHING_AUDIENCE, loading: false, error: '' }); return }
    void repository.audiences.context(courseId).then(data => { if (active) setResult({ repository, courseId, data, loading: false, error: '' }) }).catch(error => { if (active) setResult({ repository, courseId, data: EMPTY_TEACHING_AUDIENCE, loading: false, error: teachingError(error) }) })
    return () => { active = false }
  }, [repository, courseId, retry, value.audience_mode])
  if (!repository.audiences) return null
  const data = result.courseId === courseId && result.repository === repository ? result.data : EMPTY_TEACHING_AUDIENCE
  const options = value.audience_mode === 'teams' ? data.teams.filter(team => team.group_id === groupId && (!itemId || team.item_id === itemId)) : data.subgroups.filter(group => group.group_id === groupId)
  const selected = value.audience_mode === 'teams' ? value.team_ids || [] : value.subgroup_ids || []
  const toggle = (id: string) => onChange({ ...value, group_id: groupId, [value.audience_mode === 'teams' ? 'team_ids' : 'subgroup_ids']: selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id] })
  return <fieldset className="teaching-audience-fields" disabled={disabled}>
    {subgroupsOnly ? <legend>Підгрупи для перездачі</legend> : <TeachingField label="Кому показати" hint="Інші студенти не отримають цю публікацію чи її вкладення."><select className={teachingInput} value={value.audience_mode || 'all'} onChange={event => onChange({ group_id: groupId, audience_mode: event.target.value as TeachingAudienceTarget['audience_mode'], subgroup_ids: [], team_ids: [] })}><option value="all">Усій групі</option><option value="subgroups">Вибраним підгрупам</option>{allowTeams && <option value="teams">{itemId ? 'Командам цієї роботи' : 'Командам лабораторних'}</option>}</select></TeachingField>}
    {value.audience_mode !== 'all' && <>{result.loading ? <p role="status">Завантажуємо одержувачів…</p> : result.error ? <div role="alert"><p>{result.error}</p><TeachingButton onClick={() => setRetry(value => value + 1)}>Повторити</TeachingButton></div> : options.length ? <div className="teaching-audience-options">{options.map(option => <label key={option.id}><input type="checkbox" checked={selected.includes(option.id)} onChange={() => toggle(option.id)} /><span>{option.name}<small>{option.user_ids.length} учасників</small></span></label>)}</div> : <p className="teaching-audience-hint">{value.audience_mode === 'teams' ? 'Спершу збережіть чернетку роботи й додайте її команди у вкладці «Підгрупи й команди».' : 'Створіть підгрупи у вкладці «Підгрупи й команди» цього предмета.'}</p>}{!selected.length && !result.loading && <p className="teaching-error">Оберіть хоча б одну {value.audience_mode === 'teams' ? 'команду' : 'підгрупу'}.</p>}</>}
  </fieldset>
}
