import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, GraduationCap, Moon, RefreshCw, RotateCcw, Sun, UserRound } from 'lucide-react'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { teachingError, type TeachingGroupMaterial, type TeachingRepository } from '../../lib/teaching'
import { TeachingWorkspace } from './TeachingWorkspace'
import { TeachingButton, TeachingEmpty, TeachingModal } from './TeachingUI'
import { TeachingResources } from './TeachingPublications'
import { TeacherSourceBadge } from './TeacherSourceBadge'

export function LocalTeachingMaterialLibraryPreview() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher'), [revision, setRevision] = useState(0)
  const [resetting, setResetting] = useState(false), [dark, setDark] = useState(true)
  const repository = useMemo(() => createLocalTeachingRepository(role), [role, revision])
  const identity = LOCAL_TEACHING_IDENTITIES[role]
  useEffect(() => {
    const previous = document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', dark)
    return () => { document.documentElement.classList.toggle('dark', previous) }
  }, [dark])
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-4 px-5 py-4"><div className="flex items-center gap-4"><span className="font-serif text-3xl">Xelay</span><span className="text-xs text-muted-foreground">Локальний перегляд</span></div><div className="flex flex-wrap gap-2"><TeachingButton onClick={() => setDark(value => !value)}>{dark ? <Sun size={15} /> : <Moon size={15} />}{dark ? 'Світла тема' : 'Темна тема'}</TeachingButton><TeachingButton onClick={() => setResetting(true)}><RotateCcw size={15} />Скинути приклад</TeachingButton></div></div></header>
    <div className="mx-auto w-full max-w-[1180px] px-5 pt-6"><div className="flex flex-wrap items-center gap-2" role="group" aria-label="Роль у локальному прикладі">{([['teacher', 'Автор матеріалів'], ['colleague', 'Колега'], ['student', 'Студент · група 1']] as const).map(([value, label]) => <button key={value} type="button" className={`teaching-button ${role === value ? 'teaching-button-primary' : ''}`} aria-pressed={role === value} onClick={() => setRole(value)}>{value === 'student' ? <UserRound size={15} /> : <GraduationCap size={15} />}{label}</button>)}</div><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{role === 'teacher' ? 'Оновіть файл, змініть групи або надайте колезі окремі права. Потім перемкніться на студента чи колегу, щоб побачити результат.' : role === 'colleague' ? 'Колега працює лише зі своїми групами та отриманими правами. Авторство матеріалу зберігається.' : 'Так опубліковані матеріали відображаються студенту під потрібним предметом.'}</p></div>
    {role === 'student' ? <StudentMaterials key={`student:${revision}`} repository={repository} /> : <TeachingWorkspace key={`${role}:${revision}`} repository={repository} userId={identity.userId} fullName={identity.fullName} initialView="materials" />}
    <footer className="mx-auto max-w-[1180px] px-5 pb-8 text-center text-xs leading-relaxed text-muted-foreground">Вигадані дані зберігаються тільки в цьому браузері. Підключення до робочої бази вимкнено.</footer>
    {resetting && <TeachingModal title="Відновити приклад?" description="Ваші зміни у вигаданих матеріалах буде скинуто." onClose={() => setResetting(false)}><div className="teaching-form-actions"><TeachingButton onClick={() => setResetting(false)}>Залишити зміни</TeachingButton><TeachingButton primary onClick={() => { resetLocalTeachingPreview(); setRevision(value => value + 1); setResetting(false) }}>Відновити приклад</TeachingButton></div></TeachingModal>}
  </div>
}

function StudentMaterials({ repository }: { repository: TeachingRepository }) {
  const [materials, setMaterials] = useState<TeachingGroupMaterial[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try { const data = await repository.groupMaterials(LOCAL_TEACHING_IDENTITIES.student.groupId!); setMaterials(data.materials); setError('') }
    catch (failure) { setError(teachingError(failure)) }
    finally { setLoading(false) }
  }, [repository])
  useEffect(() => { void load() }, [load])
  return <main className="teaching-page"><header className="teaching-heading"><div><span className="teaching-eyebrow"><FolderOpen size={15} />Матеріали групи 1</span><h1>Матеріали до занять</h1><p>Тільки опубліковані матеріали, доступні вашій групі.</p></div><TeachingButton disabled={loading} onClick={() => void load()}><RefreshCw size={15} />Оновити</TeachingButton></header>{error && <p role="alert" className="teaching-error mb-4">{error}</p>}{loading ? <p role="status">Завантажуємо матеріали…</p> : !materials.length ? <TeachingEmpty icon={<FolderOpen size={24} />} title="Матеріалів поки немає" description="Викладач ще не відкрив матеріали вашій групі або вже завершив доступ." /> : <div className="material-library-grid">{materials.map(item => <article key={item.id} className="material-library-card"><TeacherSourceBadge /><p className="material-library-subject">{item.subject_name}</p><h3>{item.title}</h3><p className="material-library-author">{item.author_name}</p>{item.body && <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{item.body}</p>}<div className="mt-5"><TeachingResources publication={item} repository={repository} kind="material" /></div><p className="mt-4 text-xs text-muted-foreground">{item.allow_download === false ? 'Перегляд тільки у Xelay' : 'Можна переглядати та завантажувати'}</p></article>)}</div>}</main>
}
