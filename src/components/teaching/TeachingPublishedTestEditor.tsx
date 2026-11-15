import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, Pencil, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { kyivDeadline, teachingDate, type TeachingRepository, type TeachingSnapshot } from '../../lib/teaching'
import { teachingTestError, type TeachingTest, type TeachingTestDetail, type TeachingTestRepository, type TeachingTestResetPolicy } from '../../lib/teachingTests'
import { teachingPublicationCandidateMatches, teachingPublicationChanges, teachingPublicationSelectedAttempts, teachingTestPublicationDefinition } from '../../lib/teachingTestPublication'
import { TeachingTestBuilder } from './TeachingTestBuilder'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-test-publication.css'

export function TeachingPublishedTestEditor({ test, snapshot, repository, teachingRepository, userId, groupId, onClose, onSaved }: {
  test: TeachingTest; snapshot: TeachingSnapshot; repository: TeachingTestRepository; teachingRepository: TeachingRepository
  userId: string; groupId?: string; onClose: () => void; onSaved: (detail: TeachingTestDetail) => void
}) {
  const [detail, setDetail] = useState<TeachingTestDetail | null>(null)
  const [phase, setPhase] = useState<'loading' | 'edit' | 'review'>('loading')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [policy, setPolicy] = useState<TeachingTestResetPolicy>('keep')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState(''), [filterGroup, setFilterGroup] = useState('')
  const [startedBefore, setStartedBefore] = useState(''), [startedAfter, setStartedAfter] = useState('')
  const [extendActive, setExtendActive] = useState(false), [confirmed, setConfirmed] = useState(false)
  const [discardConfirmed, setDiscardConfirmed] = useState(false)
  const alive = useRef(true), lock = useRef(false)
  const scope = `${userId}:${snapshot.course.id}:${test.id}`
  const currentScope = useRef(scope); currentScope.current = scope
  const publicationRequest = useRef<{ fingerprint: string; id: string } | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    alive.current = true
    let cancelled = false
    void repository.detail(test.id).then(value => {
      if (cancelled || currentScope.current !== scope) return
      setDetail(value)
      setPhase(value.test.publication_draft ? 'review' : 'edit')
    }).catch(failure => {
      if (!cancelled && currentScope.current === scope) { setError(teachingTestError(failure)); setPhase('review') }
    })
    return () => { cancelled = true; alive.current = false }
  }, [repository, test.id, scope])

  const current = detail?.test || test
  const draft = current.publication_draft
  const definition = draft?.definition || current
  const candidates = detail?.republish_candidates || []
  const eligible = candidates.filter(candidate => candidate.eligible && candidate.status === 'submitted')
  const before = startedBefore ? kyivDeadline(startedBefore) : null
  const after = startedAfter ? kyivDeadline(startedAfter) : null
  const invalidFilter = policy === 'selected_completed' && Boolean(startedBefore && !before || startedAfter && !after || before && after && Date.parse(after) >= Date.parse(before))
  const visible = invalidFilter ? [] : candidates.filter(candidate => teachingPublicationCandidateMatches(candidate, {
    search, groupId: filterGroup, before, after,
  }))
  const visibleEligible = visible.filter(candidate => candidate.eligible && candidate.status === 'submitted')
  const groups = new Map(snapshot.groups.map(group => [group.group_id, group.group_name]))
  const recipientCount = policy === 'all_completed' ? eligible.length : policy === 'selected_completed' ? selected.size : 0
  const changes = teachingPublicationChanges(current, definition)
  const receive = (value: TeachingTestDetail) => {
    setDetail(value); setConfirmed(false); setDiscardConfirmed(false); setSelected(new Set())
    publicationRequest.current = null
  }
  const changedSelection = () => { setConfirmed(false); publicationRequest.current = null }
  function filterChanged(change: () => void) {
    change(); setSelected(new Set()); changedSelection()
  }
  async function refresh() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { const value = await repository.detail(current.id); if (alive.current && currentScope.current === scope) receive(value) }
    catch (failure) { if (alive.current && currentScope.current === scope) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current && currentScope.current === scope) setBusy(false) }
  }
  async function saveDefinition(value: TeachingTest) {
    const captured = scope
    const saved = await repository.mutate('save_published_draft', {
      id: current.id, version: current.version, expected_user_id: userId,
      draft_version: draft?.version || 0, definition: teachingTestPublicationDefinition(value),
    })
    if (!alive.current || currentScope.current !== captured) throw new Error('Акаунт або предмет змінився. Відкрийте тест знову.')
    return saved
  }
  async function discard() {
    if (!draft || !discardConfirmed || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const value = await repository.mutate('discard_published_draft', { id: current.id, version: current.version,
        expected_user_id: userId, draft_version: draft.version })
      if (alive.current && currentScope.current === scope) { receive(value); setPhase('edit') }
    } catch (failure) { if (alive.current && currentScope.current === scope) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current && currentScope.current === scope) setBusy(false) }
  }
  async function publish() {
    if (!detail || !draft || !confirmed || lock.current || current.can_republish !== true || invalidFilter) return
    let selectedIds: string[]
    try { selectedIds = policy === 'selected_completed' ? teachingPublicationSelectedAttempts(candidates, selected) : [] }
    catch (failure) { setError(failure instanceof Error ? failure.message : teachingTestError(failure)); return }
    if (policy !== 'keep' && recipientCount === 0) { setError('Оберіть хоча б одну завершену спробу або залиште поточні спроби.'); return }
    const extendCurrent = draft.change_kind === 'settings' && extendActive
    const fingerprint = JSON.stringify([current.id, current.version, draft.version, policy, selectedIds, extendCurrent])
    if (publicationRequest.current?.fingerprint !== fingerprint) publicationRequest.current = { fingerprint, id: crypto.randomUUID() }
    lock.current = true; setBusy(true); setError('')
    try {
      const value = await repository.mutate('republish_test', { id: current.id, version: current.version,
        expected_user_id: userId, draft_version: draft.version, request_id: publicationRequest.current.id,
        confirm_republish: true, reset_policy: policy, selected_attempt_ids: selectedIds,
        extend_active_attempts: extendCurrent })
      if (alive.current && currentScope.current === scope) onSaved(value)
    } catch (failure) { if (alive.current && currentScope.current === scope) setError(teachingTestError(failure)) }
    finally { lock.current = false; if (alive.current && currentScope.current === scope) setBusy(false) }
  }

  if (phase === 'edit' && detail && current.can_republish === true) return <TeachingTestBuilder
    key={`${scope}:${draft?.version || 0}`} initial={{ ...definition, has_attempts: false }} publicationDraft
    snapshot={snapshot} teachingRepository={teachingRepository} repository={repository} userId={userId} groupId={groupId}
    onSaveDefinition={saveDefinition} onClose={onClose} onSaved={value => { receive(value); setPhase('review') }} />

  return <TeachingModal wide title="Повторна публікація тесту" description={current.title} onClose={onClose} busy={busy}>
    <div className="teaching-form teaching-publication">
      {error && <p ref={errorRef} tabIndex={-1} className="teaching-error" role="alert">{error}</p>}
      {phase === 'loading' ? <p role="status">Завантажуємо опублікований тест і спроби…</p> : current.can_republish !== true ?
        <p className="teaching-note">Повторна публікація недоступна цьому акаунту. Оновіть дані або зверніться до власника предмета.</p> : !draft ? <>
          <p className="teaching-note">Збереженої чернетки змін немає. Студенти бачать поточну публікацію.</p>
          <TeachingButton onClick={() => setPhase('edit')}><Pencil size={15} />Редагувати тест</TeachingButton>
        </> : <>
        <section className="teaching-test-section"><h3><CheckCircle2 size={17} />Перевірте зміни</h3>
          <p>Чернетку збережено {teachingDate(draft.saved_at, true)}. До підтвердження студенти бачать попередню публікацію.</p>
          {changes.length ? <ul className="teaching-publication-changes">{changes.map(change => <li key={change}>{change}</li>)}</ul> : <p>Вміст тесту не змінюється. Можна окремо дозволити нові спроби.</p>}
          <div className="teaching-publication-window"><span><Clock3 size={16} />За Києвом: {teachingDate(definition.opens_at, true)} — {teachingDate(definition.closes_at, true)}</span><strong>{definition.duration_seconds / 60} хвилин на нову спробу</strong></div>
          {draft.change_kind === 'definition' && <p className="teaching-note">Нові спроби отримають оновлені запитання й правила. Уже розпочаті та завершені роботи збережуть свої запитання й оцінювання. За іншої шкали балів потрібна окрема колонка журналу.</p>}
          <TeachingButton disabled={busy} onClick={() => { setConfirmed(false); setPhase('edit') }}><Pencil size={15} />Повернутися до редагування</TeachingButton>
        </section>
        <fieldset disabled={busy} className="teaching-test-section"><legend>Що зробити зі спробами студентів?</legend>
          <label className="teaching-check"><input type="radio" name={`${scope}:attempt-policy`} checked={policy === 'keep'} onChange={() => { setPolicy('keep'); setSelected(new Set()); changedSelection() }} />Залишити всі поточні спроби</label>
          <label className="teaching-check"><input type="radio" name={`${scope}:attempt-policy`} checked={policy === 'all_completed'} onChange={() => { setPolicy('all_completed'); setSelected(new Set()); setSearch(''); setFilterGroup(''); setStartedBefore(''); setStartedAfter(''); changedSelection() }} />Дозволити нову спробу всім, хто завершив і може отримати повторний допуск ({eligible.length})</label>
          <label className="teaching-check"><input type="radio" name={`${scope}:attempt-policy`} checked={policy === 'selected_completed'} onChange={() => { setPolicy('selected_completed'); setSelected(new Set()); changedSelection() }} />Обрати, кому дозволити нову спробу</label>
          <p>Попередні роботи не видаляються. Відповіді та опубліковані оцінки залишаться в історії; новий результат перевіряється окремо.</p>
        </fieldset>
        {policy === 'selected_completed' && <section className="teaching-test-section" aria-label="Вибір студентів для повторної спроби">
          <div className="teaching-test-grid"><TeachingField label="Знайти студента"><span className="teaching-publication-search"><Search size={16} /><input className={teachingInput} value={search} onChange={event => filterChanged(() => setSearch(event.target.value))} /></span></TeachingField>
            <TeachingField label="Група"><select className={teachingInput} value={filterGroup} onChange={event => filterChanged(() => setFilterGroup(event.target.value))}><option value="">Усі групи тесту</option>{[...new Set(candidates.map(candidate => candidate.group_id))].map(id => <option value={id} key={id}>{groups.get(id) || 'Група тесту'}</option>)}</select></TeachingField>
            <TeachingField label="Почали до, за Києвом" hint="Строго раніше вказаного часу. Наприклад, до 13:25."><input className={teachingInput} type="datetime-local" value={startedBefore} onChange={event => filterChanged(() => setStartedBefore(event.target.value))} /></TeachingField>
            <TeachingField label="Почали від, за Києвом" hint="Включно з вказаним часом."><input className={teachingInput} type="datetime-local" value={startedAfter} onChange={event => filterChanged(() => setStartedAfter(event.target.value))} /></TeachingField></div>
          {invalidFilter && <p className="teaching-error" role="alert">Перевірте межі часу відбору.</p>}
          <div className="teaching-test-actions"><TeachingButton disabled={busy || !visibleEligible.length} onClick={() => { setSelected(new Set(visibleEligible.map(candidate => candidate.source_attempt_id))); changedSelection() }}>Обрати завершені за фільтром ({visibleEligible.length})</TeachingButton><TeachingButton disabled={busy || !selected.size} onClick={() => { setSelected(new Set()); changedSelection() }}>Зняти вибір</TeachingButton><span role="status">Обрано: {selected.size}</span></div>
          <p className="text-xs text-muted-foreground">Зміна фільтра знімає попередній вибір, щоб приховані студенти випадково не отримали нову спробу.</p>
          <div className="teaching-publication-candidates">{visible.map(candidate => <label key={candidate.source_attempt_id} className="teaching-publication-candidate"><input type="checkbox" checked={selected.has(candidate.source_attempt_id)} disabled={busy || !candidate.eligible || candidate.status !== 'submitted'} onChange={event => { setSelected(value => { const next = new Set(value); if (event.target.checked) next.add(candidate.source_attempt_id); else next.delete(candidate.source_attempt_id); return next }); changedSelection() }} /><span><strong>{candidate.student_name}</strong><small>{groups.get(candidate.group_id) || 'Група тесту'} · початок {teachingDate(candidate.started_at, true)}</small><small>{candidate.reason === 'active' ? 'Ще виконує роботу — нова спроба поки недоступна' : candidate.reason === 'pending_retake' ? 'Уже має відкритий повторний допуск' : candidate.reason === 'not_admitted' ? 'Зараз не допущений до цього тесту' : 'Роботу завершено'}</small></span></label>)}{!visible.length && <p className="teaching-note">Спроб за цим фільтром немає.</p>}</div>
        </section>}
        {draft.change_kind === 'settings' && <section className="teaching-test-section"><label className="teaching-check"><input type="checkbox" checked={extendActive} disabled={busy} onChange={event => { setExtendActive(event.target.checked); changedSelection() }} />Застосувати продовження часу до незавершених спроб</label><p>Збережені відповіді залишаться. Час спроб можна лише збільшити в межах нового вікна; уже використаний час окремих запитань не повертається. Без цієї позначки поточні таймери збережуться.</p></section>}
        <div className="teaching-test-confirm"><h4>Підтвердження публікації</h4><p>{policy === 'keep' ? 'Нові спроби раніше завершених робіт не відкриваються.' : `Буде відкрито нових особистих спроб: ${recipientCount}.`}</p><label className="teaching-check"><input type="checkbox" checked={confirmed} disabled={busy || invalidFilter} onChange={event => setConfirmed(event.target.checked)} />Перевірив зміни, час і отримувачів повторного допуску</label><TeachingButton primary busy={busy} disabled={!confirmed || invalidFilter || policy !== 'keep' && !recipientCount} onClick={() => void publish()}><RotateCcw size={15} />Опублікувати зміни</TeachingButton></div>
        <details className="teaching-test-section"><summary>Відхилити збережені зміни</summary><p>Опублікований тест і відповіді залишаться. Прибрано буде лише цю чернетку редагування.</p><label className="teaching-check"><input type="checkbox" checked={discardConfirmed} disabled={busy} onChange={event => setDiscardConfirmed(event.target.checked)} />Підтверджую відхилення чернетки</label><TeachingButton disabled={busy || !discardConfirmed} onClick={() => void discard()}>Відхилити чернетку змін</TeachingButton></details>
        </>}
      <div className="teaching-test-actions"><TeachingButton disabled={busy} onClick={onClose}>Закрити</TeachingButton><TeachingButton disabled={busy || phase === 'loading'} onClick={() => void refresh()}><RefreshCw size={15} />Оновити спроби й чернетку</TeachingButton></div>
    </div>
  </TeachingModal>
}
