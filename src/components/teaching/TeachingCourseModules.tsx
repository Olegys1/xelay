import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, BookOpen, Check, Layers3, Plus, RefreshCw, Save, Send, Trash2, Users } from 'lucide-react'
import {
  courseCompletionLabels, courseModuleError, courseResourceLabels,
  type CourseCompletionRule, type CourseModule, type CourseModuleItem, type CourseModuleSave,
  type CourseModulesData, type TeachingCourseModuleRepository,
} from '../../lib/teachingCourseModules'
import { useTeachingVisibilityRefresh } from '../../lib/useTeachingVisibilityRefresh'
import { TeachingButton, TeachingField, TeachingModal, teachingInput } from './TeachingUI'
import './teaching-course-modules.css'

type Props = {
  repository: TeachingCourseModuleRepository; courseId: string; groupId?: string; userId: string
  readonly?: boolean; onChanged?: () => void | Promise<void>
}
const copy = (module: CourseModule): CourseModule => ({ ...module, group_ids: [...module.group_ids], prerequisite_item_ids: [...module.prerequisite_item_ids], items: module.items.map(item => ({ ...item, prerequisite_item_ids: [...item.prerequisite_item_ids] })) })
const move = <T,>(items: T[], index: number, offset: number): T[] => {
  const target = index + offset
  if (target < 0 || target >= items.length) return items
  const next = [...items]; [next[index], next[target]] = [next[target], next[index]]; return next
}
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
const statusLabel = (status: CourseModule['status']) => status === 'published' ? 'Опубліковано' : status === 'archived' ? 'В архіві' : 'Чернетка'
const choices: CourseCompletionRule[] = ['submitted', 'graded', 'passed']

/** Course structure is saved separately from the existing resources it references. */
export function TeachingCourseModules({ repository, courseId, groupId, userId, readonly = false, onChanged }: Props) {
  const scope = useMemo(() => ({}), [repository, courseId, groupId, userId])
  const live = useRef(scope); live.current = scope
  const reads = useRef(0)
  const lock = useRef<object | null>(null)
  const [snapshot, setSnapshot] = useState<{ scope: object; data: CourseModulesData } | null>(null)
  const [editor, setEditor] = useState<{ scope: object; draft: CourseModule; baseline: CourseModule | null } | null>(null)
  const [ordering, setOrdering] = useState<{ scope: object; ids: string[] } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [busyScope, setBusyScope] = useState<object | null>(null)
  const [confirmation, setConfirmation] = useState<'publish' | 'archive' | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [discard, setDiscard] = useState<{ module?: CourseModule; refresh?: boolean } | null>(null)
  const [resourceKey, setResourceKey] = useState('')
  const [expandedItem, setExpandedItem] = useState('')
  const [progressGroup, setProgressGroup] = useState(groupId || '')
  const data = snapshot?.scope === scope ? snapshot.data : null
  const current = editor?.scope === scope ? editor : null
  const draft = current?.draft || null
  const busy = busyScope === scope || loading
  const canManage = Boolean(data?.can_manage && !readonly)
  const dirty = Boolean(current && (!current.baseline || changed(current.draft, current.baseline)))
  const modules = (data?.modules || []).filter(module => module.status !== 'archived').sort((a, b) => a.position - b.position)
  const ids = ordering?.scope === scope ? ordering.ids : modules.map(module => module.id)
  const orderDirty = changed(ids, modules.map(module => module.id))
  const sorted = ids.map(id => modules.find(module => module.id === id)).filter((module): module is CourseModule => Boolean(module))

  function active() { return live.current === scope }
  function selectModule(module: CourseModule | null) {
    setEditor(module ? { scope, draft: copy(module), baseline: module.version ? copy(module) : null } : null)
    setExpandedItem(''); setResourceKey(''); setConfirmation(null); setConfirmed(false); setError(''); setNotice('')
  }
  async function refresh() {
    if (!active() || lock.current === scope) return
    const request = ++reads.current
    setLoading(true); setError('')
    try {
      const next = await repository.teacher(courseId)
      if (!active() || request !== reads.current) return
      setSnapshot({ scope, data: next }); setOrdering(null)
      const chosen = next.modules.find(module => module.id === draft?.id && module.status !== 'archived') || next.modules.filter(module => module.status !== 'archived').sort((a, b) => a.position - b.position)[0]
      selectModule(chosen || null)
    } catch (failure) { if (active() && request === reads.current) setError(courseModuleError(failure)) }
    finally { if (active() && request === reads.current) setLoading(false) }
  }
  useEffect(() => {
    live.current = scope
    setSnapshot(null); setEditor(null); setOrdering(null); setError(''); setNotice(''); setConfirmation(null); setDiscard(null); setConfirmed(false); setExpandedItem(''); setResourceKey(''); setProgressGroup(groupId || '')
    void refresh()
    return () => { reads.current++; if (live.current === scope) live.current = {}; if (lock.current === scope) lock.current = null }
    // The scope captures the exact actor, repository, course and optional group.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  useTeachingVisibilityRefresh(refresh, { enabled: Boolean(data), blocked: busy || loading || dirty || orderDirty || Boolean(confirmation || discard) })

  function edit(patch: Partial<CourseModule>) {
    if (!active() || !canManage || busy || !current) return
    setEditor({ ...current, draft: { ...current.draft, ...patch } }); setError(''); setNotice(''); setConfirmation(null); setConfirmed(false)
  }
  function editItem(id: string, patch: Partial<CourseModuleItem>) {
    if (draft) edit({ items: draft.items.map(item => item.id === id ? { ...item, ...patch } : item) })
  }
  function choose(module: CourseModule) {
    if (!active() || busy) return
    if (dirty) { setDiscard({ module }); return }
    selectModule(module)
  }
  function create() {
    if (!active() || !canManage || busy || orderDirty) return
    const module: CourseModule = { id: crypto.randomUUID(), course_id: courseId, title: '', description: '', status: 'draft', group_ids: groupId && data?.groups.some(group => group.id === groupId) ? [groupId] : [], prerequisite_item_ids: [], items: [], position: modules.length, version: 0 }
    if (dirty) { setDiscard({ module }); return }
    selectModule(module)
  }
  function addResource() {
    if (!draft || !data || busy || !canManage) return
    const resource = data.resources.find(item => `${item.resource_type}:${item.id}` === resourceKey)
    if (!resource || draft.items.some(item => item.resource_id === resource.id && item.resource_type === resource.resource_type)) return
    const item: CourseModuleItem = { id: crypto.randomUUID(), resource_id: resource.id, resource_type: resource.resource_type, title: resource.title, required: true, completion: resource.resource_type === 'material' ? 'acknowledged' : 'submitted', pass_percent: null, prerequisite_item_ids: [], position: draft.items.length }
    edit({ items: [...draft.items, item] }); setResourceKey(''); setExpandedItem(item.id)
  }
  function payload(module: CourseModule, status: CourseModule['status']): CourseModuleSave {
    return { ...module, status, title: module.title.trim(), description: module.description.trim(), expected_user_id: userId, items: module.items.map(({ title: _title, ...item }, index) => ({ ...item, position: index })) }
  }
  async function mutate(action: () => Promise<CourseModulesData>, message: string, selectedId = draft?.id) {
    if (!active() || !canManage || lock.current === scope) return
    lock.current = scope; ++reads.current; setBusyScope(scope); setLoading(false); setError(''); setNotice('')
    try {
      const next = await action()
      if (!active()) return
      setSnapshot({ scope, data: next }); setOrdering(null)
      const chosen = next.modules.find(module => module.id === selectedId && module.status !== 'archived') || next.modules.filter(module => module.status !== 'archived').sort((a, b) => a.position - b.position)[0]
      selectModule(chosen || null); setNotice(message)
      if (onChanged) { try { await onChanged() } catch { if (active()) setNotice(`${message} Оновіть інші розділи, щоб побачити зміни.`) } }
    } catch (failure) { if (active()) setError(courseModuleError(failure)) }
    finally { if (lock.current === scope) lock.current = null; if (active()) setBusyScope(null) }
  }
  function save(status: CourseModule['status']) {
    if (!draft || !draft.title.trim() || !draft.group_ids.length || !canManage || busy) return
    if (status === 'published' && (confirmation !== 'publish' || !confirmed || !draft.items.length)) return
    if (status === 'archived' && (confirmation !== 'archive' || !confirmed || !draft.version)) return
    const captured = payload(copy(draft), status)
    void mutate(() => repository.save(captured), status === 'published' ? 'Модуль опубліковано. Студенти бачать його відповідно до умов відкриття.' : status === 'archived' ? 'Модуль переміщено в архів. Початкові матеріали, роботи й оцінки збережено.' : 'Чернетку модуля збережено. Студентам її не опубліковано.')
  }
  function saveOrder() {
    if (!data || dirty || !orderDirty || busy) return
    const versions = Object.fromEntries(modules.map(module => [module.id, module.version]))
    void mutate(() => repository.reorder(courseId, [...ids], versions, userId), 'Порядок модулів збережено.')
  }
  const allItems = [...modules.filter(module => module.id !== draft?.id), ...(draft ? [draft] : [])].flatMap(module => module.items.map(item => ({ ...item, moduleTitle: module.title || 'Новий модуль', moduleId: module.id })))
  const usedElsewhere = new Set(modules.filter(module => module.id !== draft?.id).flatMap(module => module.items.map(item => `${item.resource_type}:${item.resource_id}`)))
  const availableResources = (data?.resources || []).filter(resource => !usedElsewhere.has(`${resource.resource_type}:${resource.id}`) && !draft?.items.some(item => item.resource_id === resource.id && item.resource_type === resource.resource_type))
  const savedItemNames = new Map(modules.flatMap(module => module.items.map(item => [item.id, item.title] as const)))
  const progress = (data?.progress || []).filter(student => !progressGroup || student.group_id === progressGroup)
  const checkboxList = (selected: string[], options: typeof allItems, update: (next: string[]) => void, title: string) => <details className="tcm-prerequisites"><summary>{title} · {selected.length ? `обрано ${selected.length}` : 'без умов'}</summary><div className="tcm-prerequisite-list">{options.length ? options.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || !canManage} onChange={event => update(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.title}<small>{item.moduleTitle} · {courseCompletionLabels[item.completion]}</small></span></label>) : <p className="tcm-muted">Спочатку додайте кроки до інших модулів.</p>}</div></details>

  return <section className="tcm-workspace" aria-label="Модулі курсу">
    <header className="tcm-heading"><div><span className="tcm-eyebrow"><Layers3 size={14} aria-hidden="true" />Навчальний маршрут</span><h2>Модулі курсу</h2><p>Поєднайте наявні матеріали, завдання й тести у зрозумілу послідовність. Умови відкриття та прогрес перевіряються для кожного студента.</p></div><div className="tcm-actions"><TeachingButton busy={loading} disabled={busy} onClick={() => { if (dirty || orderDirty) setDiscard({ refresh: true }); else void refresh() }}><RefreshCw size={15} />Оновити модулі</TeachingButton>{canManage && <TeachingButton primary disabled={busy || orderDirty} onClick={create}><Plus size={16} />Додати модуль</TeachingButton>}</div></header>
    {error && <p className="teaching-error" role="alert">{error}</p>}{data && notice && <p className="teaching-note" role="status">{notice}</p>}
    {!data ? <p className="tcm-empty" role="status">{loading ? 'Завантажуємо структуру курсу…' : 'Структуру курсу поки не отримано. Спробуйте оновити дані.'}</p> : <>
      <div className="tcm-stats"><div className="tcm-stat"><Layers3 size={21} aria-hidden="true" /><div><strong>{modules.length}</strong><small>модулів у структурі</small></div></div><div className="tcm-stat"><BookOpen size={21} aria-hidden="true" /><div><strong>{modules.reduce((sum, module) => sum + module.items.length, 0)}</strong><small>кроків з наявних ресурсів</small></div></div><div className="tcm-stat"><Users size={21} aria-hidden="true" /><div><strong>{data.progress.length}</strong><small>студентів у доступних групах</small></div></div></div>
      {!canManage && <p className="teaching-note">Структуру змінює власник курсу. Персональний прогрес доступний з правом роботи з журналом.</p>}
      <div className="tcm-builder"><nav className="tcm-modules" aria-label="Послідовність модулів"><h3>Структура курсу</h3>{sorted.map((module, index) => <div key={module.id} className="tcm-module-nav" data-selected={draft?.id === module.id}><button type="button" className="tcm-module-select" disabled={busy} aria-current={draft?.id === module.id ? 'step' : undefined} onClick={() => choose(module)}><span className="tcm-module-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{module.title}</strong><small>{statusLabel(module.status)} · {module.items.length} кроків</small></span></button>{canManage && <div className="tcm-nav-move"><button type="button" aria-label={`Підняти модуль «${module.title}»`} disabled={busy || dirty || index === 0} onClick={() => setOrdering({ scope, ids: move(ids, index, -1) })}><ArrowUp size={14} /></button><button type="button" aria-label={`Опустити модуль «${module.title}»`} disabled={busy || dirty || index === sorted.length - 1} onClick={() => setOrdering({ scope, ids: move(ids, index, 1) })}><ArrowDown size={14} /></button></div>}</div>)}{!modules.length && <p className="tcm-muted">Поки немає модулів. Почніть із першої теми.</p>}{orderDirty && <><TeachingButton primary busy={busy} disabled={dirty} onClick={saveOrder}><Save size={14} />Зберегти порядок</TeachingButton><TeachingButton disabled={busy} onClick={() => setOrdering(null)}>Скасувати порядок</TeachingButton></>}</nav>
        {!draft ? <div className="tcm-empty">{canManage ? 'Додайте модуль, оберіть групи та приєднайте вже створені ресурси курсу.' : 'Власник ще не створив структуру курсу.'}</div> : <div className="tcm-editor"><div className="tcm-editor-top"><h3>{draft.version ? 'Налаштування модуля' : 'Новий модуль'}</h3><span className="tcm-chip">{statusLabel(draft.status)}</span></div><TeachingField label="Назва модуля"><input className={teachingInput} maxLength={180} value={draft.title} disabled={busy || !canManage || orderDirty} onChange={event => edit({ title: event.target.value })} placeholder="Наприклад, Попит і пропозиція" /></TeachingField><TeachingField label="Короткий опис"><textarea className={teachingInput} rows={3} maxLength={4000} value={draft.description} disabled={busy || !canManage || orderDirty} onChange={event => edit({ description: event.target.value })} placeholder="Що опрацюємо та до якого результату йдемо" /></TeachingField>
          <fieldset disabled={busy || !canManage || orderDirty} className="tcm-group-picks"><legend>Для яких груп</legend>{data.groups.map(group => <label key={group.id}><input type="checkbox" checked={draft.group_ids.includes(group.id)} onChange={event => edit({ group_ids: event.target.checked ? [...draft.group_ids, group.id] : draft.group_ids.filter(id => id !== group.id) })} />{group.name}</label>)}</fieldset>
          {checkboxList(draft.prerequisite_item_ids, allItems.filter(item => item.moduleId !== draft.id), next => edit({ prerequisite_item_ids: next }), 'Відкрити модуль після всіх обраних кроків')}
          <p className="tcm-muted">Умови модуля діють на всі його кроки. Бали враховуються тільки після публікації викладачем. Необов’язкові кроки не збільшують обов’язковий прогрес, але можуть бути умовою наступного кроку.</p>
          <div className="tcm-item-list">{draft.items.map((item, index) => { const resource = data.resources.find(source => source.id === item.resource_id && source.resource_type === item.resource_type); return <article key={item.id} className="tcm-item"><div className="tcm-item-top"><div className="tcm-item-title"><span className="tcm-chip">{courseResourceLabels[item.resource_type]}</span><strong>{item.title}</strong><small>Крок {index + 1} · {item.required ? 'Обов’язковий' : 'Додатковий'}</small></div><div className="tcm-item-controls">{canManage && <><button type="button" aria-label={`Підняти крок «${item.title}»`} disabled={busy || orderDirty || index === 0} onClick={() => edit({ items: move(draft.items, index, -1).map((entry, position) => ({ ...entry, position })) })}><ArrowUp size={15} /></button><button type="button" aria-label={`Опустити крок «${item.title}»`} disabled={busy || orderDirty || index === draft.items.length - 1} onClick={() => edit({ items: move(draft.items, index, 1).map((entry, position) => ({ ...entry, position })) })}><ArrowDown size={15} /></button><button type="button" aria-label={`Вилучити крок «${item.title}» з модуля`} disabled={busy || orderDirty} onClick={() => edit({ items: draft.items.filter(entry => entry.id !== item.id).map((entry, position) => ({ ...entry, position })) })}><Trash2 size={15} /></button></>}<button type="button" aria-label={`Умови кроку «${item.title}»`} aria-expanded={expandedItem === item.id} onClick={() => setExpandedItem(expandedItem === item.id ? '' : item.id)}><Layers3 size={15} /></button></div></div><div className="tcm-item-meta"><span>{courseCompletionLabels[item.completion]}{item.completion === 'passed' ? ` · від ${item.pass_percent ?? 60}%` : ''}</span>{resource?.status !== 'published' && <span>Ресурс готується. Додавання до модуля не публікує його автоматично.</span>}{item.prerequisite_item_ids.length > 0 && <span>Попередніх умов: {item.prerequisite_item_ids.length}</span>}</div>
            {expandedItem === item.id && <div className="tcm-item-editor">
              <h4>Коли крок виконано</h4>
              <label className="tcm-check"><input type="checkbox" disabled={busy || !canManage || orderDirty} checked={item.required} onChange={event => editItem(item.id, { required: event.target.checked })} />Обов’язковий для завершення модуля</label>
              <TeachingField label="Умова виконання"><select className={teachingInput} value={item.completion} disabled={busy || !canManage || orderDirty} onChange={event => {
                const completion = event.target.value as CourseCompletionRule
                if ((completion === 'graded' || completion === 'passed') && !(resource?.max_points && resource.max_points > 0)) return
                editItem(item.id, { completion, pass_percent: completion === 'passed' ? item.pass_percent ?? 60 : null })
              }}>{(item.resource_type === 'material' ? ['acknowledged'] as CourseCompletionRule[] : choices).map(rule => <option key={rule} value={rule} disabled={(rule === 'graded' || rule === 'passed') && !(resource?.max_points && resource.max_points > 0)}>{courseCompletionLabels[rule]}</option>)}</select></TeachingField>
              {item.resource_type !== 'material' && !(resource?.max_points && resource.max_points > 0) && <p className="tcm-muted">Для умови за балами спочатку задайте максимальний бал у початковому завданні або тесті. Зараз можна обрати здачу роботи.</p>}
              {item.completion === 'passed' && <TeachingField label="Мінімальний результат, %" hint="Результат має бути опублікований у журналі."><input type="number" className={teachingInput} min={0} max={100} step={1} disabled={busy || !canManage || orderDirty} value={item.pass_percent ?? ''} onChange={event => editItem(item.id, { pass_percent: event.target.value === '' ? null : Number(event.target.value) })} /></TeachingField>}
              {checkboxList(item.prerequisite_item_ids, allItems.filter(entry => entry.id !== item.id), next => editItem(item.id, { prerequisite_item_ids: next }), 'Відкрити крок після всіх обраних умов')}
            </div>}
          </article> })}{!draft.items.length && <p className="tcm-empty">Додайте матеріал, завдання або тест. Початкові файли та роботи залишаться на своїх місцях.</p>}</div>
          {canManage && <div className="tcm-item-editor"><h4>Додати наявний ресурс</h4><TeachingField label="Матеріал, завдання або тест"><select className={teachingInput} value={resourceKey} disabled={busy || orderDirty} onChange={event => setResourceKey(event.target.value)}><option value="">Оберіть ресурс цього курсу</option>{availableResources.map(resource => <option key={`${resource.resource_type}:${resource.id}`} value={`${resource.resource_type}:${resource.id}`}>{courseResourceLabels[resource.resource_type]} · {resource.title}{resource.status !== 'published' ? ' · готується' : ''}</option>)}</select></TeachingField><div className="tcm-actions"><TeachingButton disabled={!resourceKey || busy || orderDirty} onClick={addResource}><Plus size={15} />Додати крок</TeachingButton></div><p className="tcm-muted">Модуль посилається на ресурс і не створює копію. Один ресурс можна використати лише в одному активному модулі.</p></div>}
          {canManage && <div className="tcm-savebar"><p>{dirty ? 'Є незбережені зміни.' : 'Усі зміни цього модуля збережено.'} Публікація модуля й публікація початкових ресурсів виконуються окремо.</p><div className="tcm-actions">{draft.status !== 'published' && <TeachingButton primary busy={busy} disabled={!dirty || !draft.title.trim() || !draft.group_ids.length || orderDirty} onClick={() => save('draft')}><Save size={15} />Зберегти чернетку</TeachingButton>}<TeachingButton primary disabled={busy || !draft.title.trim() || !draft.group_ids.length || !draft.items.length || orderDirty || draft.status === 'published' && !dirty} onClick={() => { setConfirmation('publish'); setConfirmed(false); setError('') }}><Send size={15} />{draft.status === 'published' ? 'Перевірити зміни' : 'Опублікувати модуль'}</TeachingButton>{draft.version > 0 && <TeachingButton disabled={busy || orderDirty} onClick={() => { setConfirmation('archive'); setConfirmed(false); setError('') }}>В архів</TeachingButton>}</div></div>}
        </div>}
      </div>
      <section className="tcm-progress" aria-label="Прогрес студентів"><h3>Прогрес студентів</h3><p>Показано лише доступні вам групи. Нездані роботи та неопубліковані оцінки не зараховуються як опублікований результат.</p><TeachingField label="Група для перегляду прогресу"><select className={teachingInput} value={progressGroup} onChange={event => setProgressGroup(event.target.value)}><option value="">Усі доступні групи</option>{data.groups.map(group => <option value={group.id} key={group.id}>{group.name}</option>)}</select></TeachingField>{!progress.length ? <p className="tcm-muted">Для обраних груп поки немає прогресу.</p> : progress.map(student => <details key={`${student.group_id}:${student.user_id}`}><summary>{student.full_name} · {student.group_name} · {student.completed} із {student.total} · {student.percent}%</summary><progress className="tcm-progress-bar" aria-label={`Прогрес ${student.full_name}`} max={100} value={student.percent} />{student.items.map(item => <div className="tcm-progress-item" key={item.item_id}><span>{savedItemNames.get(item.item_id) || 'Крок курсу'}{item.locked && <small className="tcm-muted"> · {item.reason || 'Ще закрито'}</small>}</span><span>{item.completed ? 'Виконано' : 'Ще не виконано'}{item.score !== null && <strong> · {item.score}{item.max_points !== null ? ` / ${item.max_points}` : ''}</strong>}</span></div>)}</details>)}</section>
    </>}
    {data && draft && confirmation && <TeachingModal title={confirmation === 'publish' ? 'Перевірте модуль перед публікацією' : 'Перемістити модуль в архів?'} busy={busy} onClose={() => { if (!busy) { setConfirmation(null); setConfirmed(false) } }}><div className="tcm-confirm"><h3>{draft.title}</h3><p>{confirmation === 'publish' ? 'Студенти обраних груп отримають модуль. Кожен крок відкриється після виконання його умов. Чернетки початкових ресурсів залишаться недоступними до їх окремої публікації.' : 'Модуль зникне з навчального маршруту. Матеріали, завдання, тести, спроби й оцінки не видаляються. Якщо від його кроків залежать інші модулі, спочатку змініть їхні умови.'}</p><ul><li>Групи: {data.groups.filter(group => draft.group_ids.includes(group.id)).map(group => group.name).join(', ')}</li><li>Кроків: {draft.items.length}, обов’язкових: {draft.items.filter(item => item.required).length}</li><li>Умов відкриття модуля: {draft.prerequisite_item_ids.length}</li></ul><label className="tcm-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{confirmation === 'publish' ? 'Я перевірив групи, ресурси та умови відкриття' : 'Підтверджую переміщення модуля в архів'}</label>{error && <p role="alert" className="teaching-error">{error}</p>}<div className="tcm-actions"><TeachingButton primary busy={busy} disabled={!confirmed} onClick={() => save(confirmation === 'publish' ? 'published' : 'archived')}><Check size={15} />{confirmation === 'publish' ? 'Підтвердити публікацію' : 'Підтвердити архівування'}</TeachingButton><TeachingButton disabled={busy} onClick={() => { setConfirmation(null); setConfirmed(false) }}>Повернутися до редагування</TeachingButton></div></div></TeachingModal>}
    {data && discard && <TeachingModal title="Залишилися незбережені зміни" onClose={() => setDiscard(null)}><div className="tcm-confirm"><p>Збережіть поточний модуль або відкиньте свої правки. Уже збережені ресурси та роботи не зміняться.</p><div className="tcm-actions"><TeachingButton primary onClick={() => { const next = discard; setDiscard(null); if (next.refresh) void refresh(); else if (next.module) selectModule(next.module) }}>Відкинути правки й продовжити</TeachingButton><TeachingButton onClick={() => setDiscard(null)}>Залишитися</TeachingButton></div></div></TeachingModal>}
  </section>
}
