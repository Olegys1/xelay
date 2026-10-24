import { useRef, useState, type FormEvent } from 'react'
import { teachingError, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { calculateTeachingTotal, teachingRulesForGroup, validateTeachingGradingRules } from '../../lib/teachingGrading'
import { TeachingGradingRulesEditor, TeachingGradingRulesSummary } from './TeachingGradingRulesEditor'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function TeachingGroupGradingSettings({ snapshot, groupId, repository, userId, onRefresh, onClose }: { snapshot: TeachingSnapshot; groupId: string; repository: TeachingRepository; userId: string; onRefresh: () => Promise<void>; onClose: () => void }) {
  const [expectedUserId] = useState(userId)
  const group = snapshot.groups.find(group => group.group_id === groupId)!
  const current = teachingRulesForGroup(snapshot, groupId)
  const [override, setOverride] = useState(Boolean(group.grading_rules_override))
  const [rules, setRules] = useState(() => structuredClone(current))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const nextRules = override ? rules : snapshot.course.grading_rules
  const entries = snapshot.entries.filter(entry => entry.group_id === groupId && entry.active)
  const valueFor = (entryId: string) => snapshot.activities.filter(activity => activity.group_id === groupId).map(activity => ({ category: activity.category, score: snapshot.grades.find(grade => grade.activity_id === activity.id && grade.entry_id === entryId && grade.published_at)?.published_score }))
  const changes = entries.map(entry => ({ entry, before: calculateTeachingTotal(current, valueFor(entry.id)), after: calculateTeachingTotal(nextRules, valueFor(entry.id)) })).filter(row => row.before !== row.after)
  async function save(event: FormEvent) {
    event.preventDefault(); if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      validateTeachingGradingRules(nextRules)
      const used = snapshot.activities.filter(activity => activity.group_id === groupId).map(activity => activity.category).filter(Boolean)
      if (used.some(category => !nextRules.categories.some(rule => rule.id === category))) throw new Error('Збережіть категорії, у яких уже є роботи цієї групи. Їх можна перейменувати та налаштувати.')
      await repository.mutate('save_group_grading', { course_id: snapshot.course.id, group_id: groupId, expected_user_id: expectedUserId, version: group.grading_version || 0, course_version: snapshot.course.version, grading_rules: override ? rules : null })
      await onRefresh(); onClose()
    } catch (failure) { setError(teachingError(failure)) } finally { lock.current = false; setBusy(false) }
  }
  return <TeachingModal title="Правила оцінювання групи" description={`${snapshot.course.title} · ${group.group_name}`} onClose={onClose} busy={busy}><form className="teaching-form" onSubmit={event => void save(event)}>{error && <p role="alert" className="teaching-error">{error}</p>}<fieldset className="space-y-3" disabled={busy}><label className="teaching-check"><input type="radio" name="grading-scope" checked={!override} onChange={() => setOverride(false)} />Загальні правила предмета</label><label className="teaching-check"><input type="radio" name="grading-scope" checked={override} onChange={() => setOverride(true)} />Окремі правила тільки для цієї групи</label></fieldset>{override ? <TeachingGradingRulesEditor rules={rules} onChange={setRules} disabled={busy} categoryInUse={id => snapshot.activities.some(activity => activity.group_id === groupId && activity.category === id) || snapshot.assignments.some(item => item.category === id && item.targets.some(target => target.group_id === groupId))} /> : <TeachingGradingRulesSummary rules={snapshot.course.grading_rules} />}<div className="teaching-note"><p className="font-semibold">Оцінки за роботи та історія збережуться.</p><p className="mt-2 text-xs">Після збереження підсумок цієї групи та Excel враховуватимуть вибрані правила. Інші групи збережуть свої налаштування.</p>{changes.length > 0 && <div className="mt-3 space-y-1 text-xs"><p>Зміниться підсумок у {changes.length} студентів:</p>{changes.slice(0, 5).map(row => <p key={row.entry.id}>{row.entry.full_name}: {row.before} → {row.after}</p>)}</div>}</div><div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={onClose}>Скасувати</TeachingButton><TeachingButton primary type="submit" busy={busy}>Зберегти правила</TeachingButton></div></form></TeachingModal>
}
