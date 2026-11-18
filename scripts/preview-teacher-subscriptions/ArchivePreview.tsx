import { useEffect, useMemo, useRef, useState } from 'react'
import { TeachingTests } from '../../src/components/teaching/TeachingTests'
import type { TeachingRepository, TeachingSnapshot } from '../../src/lib/teaching'
import { createArchivePreviewFixture, PREVIEW_ARCHIVE_COURSE, PREVIEW_ARCHIVE_GROUP } from './archiveFixture'

export function ArchivePreview({ repository, userId, offline }: { repository: TeachingRepository; userId: string; offline: boolean }) {
  const expiredKey = `xelay:synthetic-preview:archive-expired:${userId}`
  const [expired, setExpired] = useState(() => sessionStorage.getItem(expiredKey) === 'true')
  const [snapshot, setSnapshot] = useState<TeachingSnapshot | null>(null), [error, setError] = useState('')
  const controls = useRef({ expired, offline }); controls.current = { expired, offline }
  const fixture = useMemo(() => createArchivePreviewFixture({ ownerId: userId, controls: () => controls.current }), [userId])
  const archiveRepository = useMemo(() => ({ ...fixture.archiveRepository }), [fixture, expired])
  useEffect(() => {
    let active = true; setSnapshot(null); setError('')
    repository.course(PREVIEW_ARCHIVE_COURSE).then(value => {
      if (active) setSnapshot({ ...value, course: { ...value.course, permissions: value.course.permissions.filter(permission => permission === 'assignments') }, groups: value.groups.map(group => ({ ...group, permissions: (group.permissions || value.course.permissions).filter(permission => permission === 'assignments') })) })
    }).catch(() => { if (active) setError('Не вдалося відкрити вигаданий навчальний предмет.') })
    return () => { active = false }
  }, [repository, userId])
  return <main className="teaching-page">
    <header className="teaching-heading"><div><span className="teaching-eyebrow">Локальна перевірка · вигадані тести</span><h1>Особистий архів тестів</h1><p>Тут можна лише переносити завершений приклад до архіву та повертати його. Оцінки й студентські спроби не створюються.</p></div><button type="button" className="teaching-button" aria-pressed={expired} onClick={() => setExpired(value => { sessionStorage.setItem(expiredKey, String(!value)); return !value })}>{expired ? 'Відновити тестовий тариф' : 'Імітувати завершення тарифу'}</button></header>
    <p className="teaching-note mb-5" role="status">{expired ? 'Тестовий тариф завершено: нове архівування вимкнене, свій збережений архів можна переглядати та відновлювати.' : 'Тестовий тариф активний: завершений приклад можна перенести до особистого архіву.'} Метадані зберігаються лише в цьому браузері й окремо для кожного вигаданого викладача.</p>
    {error ? <p role="alert" className="teaching-error">{error}</p> : !snapshot ? <p role="status" className="teaching-note">Відкриваємо вигаданий приклад…</p> : <TeachingTests key={userId} userId={userId} snapshot={snapshot} repository={fixture.repository} teachingRepository={repository} archiveRepository={archiveRepository} groupId={PREVIEW_ARCHIVE_GROUP} />}
  </main>
}
