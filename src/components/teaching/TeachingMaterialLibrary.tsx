import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Clock3, FileText, FolderOpen, LockKeyhole, PencilLine, Plus, RefreshCw, Search, ShieldCheck, UsersRound } from 'lucide-react'
import { teachingDate, teachingError, type TeachingRepository } from '../../lib/teaching'
import { teachingMaterialLibraryStatus, type TeachingLibraryMaterial, type TeachingMaterialLibraryData } from '../../lib/teachingMaterialLibrary'
import { TeachingButton, TeachingEmpty, teachingInput } from './TeachingUI'
import { TeachingResources } from './TeachingPublications'
import { TeachingMaterialWithdrawal } from './TeachingMaterialWithdrawal'
import { TeachingMaterialCollaboratorsDialog, TeachingMaterialLibraryEditor } from './TeachingMaterialLibraryEditor'
import './teaching-material-library.css'

const STATUS_LABELS = { published: 'Опубліковано', scheduled: 'Заплановано', draft: 'Чернетка', expired: 'Доступ завершено', withdrawn: 'Відкликано' } as const
export function TeachingMaterialLibrary({ repository, userId }: { repository: TeachingRepository; userId: string }) {
  return <LibraryContents key={`${repository.mode}:${userId}`} repository={repository} userId={userId} />
}
function LibraryContents({ repository, userId }: { repository: TeachingRepository; userId: string }) {
  const [data, setData] = useState<TeachingMaterialLibraryData | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [query, setQuery] = useState(''), [course, setCourse] = useState(''), [status, setStatus] = useState(''), [ownership, setOwnership] = useState('')
  const [editor, setEditor] = useState<{ material: TeachingLibraryMaterial | null; section?: 'content' | 'groups' } | null>(null)
  const [collaborators, setCollaborators] = useState<TeachingLibraryMaterial | null>(null)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const sequence = ++generation.current
    setLoading(true)
    try { const next = await repository.materialLibrary(); if (sequence === generation.current) { setData(next); setError('') } }
    catch (failure) { if (sequence === generation.current) { setError(teachingError(failure)); throw failure } }
    finally { if (sequence === generation.current) setLoading(false) }
  }, [repository, userId])
  useEffect(() => { void load().catch(() => {}); return () => { ++generation.current } }, [load])
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !editor && !collaborators) void load().catch(() => {}) }
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [load, editor, collaborators])
  const materials = data?.materials || []
  const courses = [...new Map([...(data?.courses || []).map(item => [item.course.id, item.course.title] as const), ...materials.map(item => [item.course_id, item.course_title] as const)]).entries()]
  const search = query.trim().toLocaleLowerCase('uk-UA')
  const visible = materials.filter(item => (!course || item.course_id === course) && (!status || teachingMaterialLibraryStatus(item) === status)
    && (!ownership || (ownership === 'own' ? item.is_owner : !item.is_owner))
    && (!search || [item.title, item.body, item.course_title, item.author_name, ...item.attachments.map(file => file.name), ...item.target_group_names.map(group => group.group_name)].join(' ').toLocaleLowerCase('uk-UA').includes(search)))
  const canCreate = data?.courses.some(item => !item.course.archived_at && item.course.permissions.includes('materials'))
  return <section className="material-library" aria-label="Мої матеріали">
    <div className="material-library-intro"><div><span className="material-library-kicker"><FolderOpen size={15} />Особиста бібліотека</span><h2>Усе для ваших занять.<br /><span>В одному місці.</span></h2><p>Додайте матеріал один раз. Оберіть групи, оновлюйте файли й керуйте доступом із цього кабінету.</p></div><div className="material-library-intro-actions"><TeachingButton primary disabled={loading || !canCreate} onClick={() => setEditor({ material: null })}><Plus size={17} />Додати матеріал</TeachingButton><TeachingButton disabled={loading} onClick={() => void load().catch(() => {})}><RefreshCw size={15} />Оновити список</TeachingButton></div></div>
    <div className="material-library-stats" aria-label="Стан бібліотеки"><div><span><BookOpen size={16} />У бібліотеці</span><strong>{materials.length}</strong></div><div><span><ShieldCheck size={16} />Опубліковано</span><strong>{materials.filter(item => teachingMaterialLibraryStatus(item) === 'published').length}</strong></div><div><span><UsersRound size={16} />З колегами</span><strong>{materials.filter(item => !item.withdrawn_at && item.collaborators.length > 0).length}</strong></div></div>
    <div className="material-library-toolbar"><label className="material-library-search"><Search size={18} aria-hidden="true" /><input type="search" aria-label="Пошук матеріалів" placeholder="Назва, предмет або файл…" value={query} onChange={event => setQuery(event.target.value)} /></label><label className="sr-only" htmlFor="material-library-course">Фільтр предмета</label><select id="material-library-course" className={teachingInput} value={course} onChange={event => setCourse(event.target.value)}><option value="">Усі предмети</option>{courses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><label className="sr-only" htmlFor="material-library-status">Фільтр стану</label><select id="material-library-status" className={teachingInput} value={status} onChange={event => setStatus(event.target.value)}><option value="">Усі стани</option>{Object.entries(STATUS_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><label className="sr-only" htmlFor="material-library-owner">Фільтр авторства</label><select id="material-library-owner" className={teachingInput} value={ownership} onChange={event => setOwnership(event.target.value)}><option value="">Мої та спільні</option><option value="own">Я автор</option><option value="shared">Мені надали доступ</option></select></div>
    {error && <p role="alert" className="teaching-error">{error}</p>}
    {loading && !data && <p role="status" className="material-library-loading">Завантажуємо бібліотеку…</p>}
    {!loading && data && !canCreate && <p className="teaching-note">Для нового матеріалу потрібен активний предмет із дозволом на матеріали. Власні опубліковані матеріали можна відкликати з цієї бібліотеки.</p>}
    {!loading && data && !visible.length && <TeachingEmpty icon={<FolderOpen size={25} />} title={materials.length ? 'За цими умовами нічого не знайдено' : 'Тут буде ваша бібліотека'} description={materials.length ? 'Змініть пошук або фільтри, щоб побачити інші матеріали.' : 'Лекції, презентації, посилання й конспекти можна зберігати тут та відкривати потрібним групам.'}>{materials.length > 0 && <TeachingButton onClick={() => { setQuery(''); setCourse(''); setStatus(''); setOwnership('') }}>Скинути фільтри</TeachingButton>}</TeachingEmpty>}
    <div className="material-library-grid" aria-busy={loading}>{visible.map(item => {
      const state = teachingMaterialLibraryStatus(item), inactive = state === 'withdrawn'
      return <article key={item.id} className={`material-library-card material-library-card-${state}`}>
        <div className="material-library-card-top"><span className="material-library-file-icon"><FileText size={23} /></span><div className="material-library-card-badges"><span className={`material-library-status material-library-status-${state}`}>{state === 'scheduled' && <Clock3 size={12} />}{STATUS_LABELS[state]}</span><span className="material-library-author-chip">{item.is_owner ? 'Ви автор' : 'Спільний доступ'}</span></div></div>
        <p className="material-library-subject">{item.course_title}</p><h3>{item.title}</h3><p className="material-library-author">{item.author_name}{item.updated_at ? ` · Оновлено ${teachingDate(item.updated_at)}` : ''}</p>
        {item.body && <p className="material-library-description">{item.body}</p>}
        <div className="material-library-groups"><span><UsersRound size={14} />{!item.target_group_names.length && !item.hidden_target_count ? 'Поки тільки в бібліотеці' : 'Групи'}</span><div>{item.target_group_names.map(group => <span className="material-library-group-chip" key={group.group_id}>{group.group_name}</span>)}{item.hidden_target_count > 0 && <span className="material-library-group-chip">Ще {item.hidden_target_count} поза вашим доступом</span>}</div></div>
        <div className="material-library-access"><span><LockKeyhole size={13} />{item.allow_download === false ? 'Перегляд у Xelay' : 'Перегляд і завантаження'}</span>{item.access_until && <span>Доступ до {teachingDate(item.access_until, true)}</span>}{state === 'scheduled' && <span>Публікація {teachingDate(item.publish_at, true)}</span>}</div>
        {!inactive && <div className="material-library-resources"><TeachingResources publication={item} repository={repository} kind="material" /></div>}
        {!item.is_owner && !inactive && <p className="material-library-permissions">Ваші права: {[item.can_edit && 'оновлення', item.can_manage_groups && 'вибір груп', item.can_delete && 'видалення'].filter(Boolean).join(', ') || 'перегляд матеріалу'}.{item.hidden_target_count > 0 && ' Змінити або відкликати спільний матеріал можна лише з доступом до всіх його груп.'}</p>}
        {item.collaborators.length > 0 && <div className="material-library-collaborators"><span className="material-library-avatar-stack">{item.collaborators.slice(0, 3).map(person => <span key={person.user_id} title={person.full_name || 'Колега'}>{(person.full_name || 'К').split(' ').map(part => part[0]).slice(0, 2).join('')}</span>)}</span><span>{item.collaborators.length === 1 ? item.collaborators[0].full_name || 'Колега з доступом' : `Колег із доступом: ${item.collaborators.length}`}</span></div>}
        {!inactive && <div className="material-library-actions">{item.can_edit && <TeachingButton primary disabled={loading} onClick={() => setEditor({ material: item, section: 'content' })}><PencilLine size={15} />Оновити матеріал</TeachingButton>}{item.can_manage_groups && <TeachingButton disabled={loading} onClick={() => setEditor({ material: item, section: 'groups' })}><UsersRound size={15} />Групи</TeachingButton>}{item.can_manage_collaborators && <TeachingButton disabled={loading} onClick={() => setCollaborators(item)}><ShieldCheck size={15} />Колеги й права</TeachingButton>}{item.can_delete && <TeachingMaterialWithdrawal material={item} repository={repository} onWithdrawn={load} />}</div>}
      </article>
    })}</div>
    <p className="material-library-footnote"><ShieldCheck size={15} />Авторство зберігається. Заміна файлу оновлює один матеріал у всіх вибраних групах.</p>
    {editor && data && <TeachingMaterialLibraryEditor key={editor.material?.id || 'new'} material={editor.material} data={data} repository={repository} userId={userId} initialSection={editor.section} onClose={() => setEditor(null)} onSaved={load} />}
    {collaborators && data && <TeachingMaterialCollaboratorsDialog key={collaborators.id} material={collaborators} data={data} repository={repository} userId={userId} onClose={() => setCollaborators(null)} onSaved={load} />}
  </section>
}
