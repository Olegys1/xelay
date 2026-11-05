import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import { teachingDate, teachingError, type TeachingRepository } from '../../lib/teaching'
import type { TeachingAnnouncement, TeachingAnnouncementReceipts as Receipts } from '../../lib/teachingAudience'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function TeachingAnnouncementReceipts({ announcement, repository, userId, onClose }: { announcement: TeachingAnnouncement; repository: TeachingRepository; userId: string; onClose: () => void }) {
  const [result, setResult] = useState<{ scope: string; source: typeof repository.audiences; data: Receipts } | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [reload, setReload] = useState(0)
  const source = repository.audiences, scope = `${userId}:${announcement.id}:${announcement.version}`
  const data = result?.scope === scope && result.source === source ? result.data : null
  const current = useRef({ source, scope }); current.current = { source, scope }
  useEffect(() => {
    const captured = current.current; let active = true
    setResult(null); setError(''); setLoading(true)
    if (!source?.receipts) { setError('Підтвердження ще не підключені.'); setLoading(false); return }
    void source.receipts(announcement.id, userId).then(data => { if (active && current.current.source === captured.source && current.current.scope === captured.scope) setResult({ scope, source, data }) }).catch(failure => { if (active && current.current.source === captured.source && current.current.scope === captured.scope) setError(teachingError(failure)) }).finally(() => { if (active && current.current.source === captured.source && current.current.scope === captured.scope) setLoading(false) })
    return () => { active = false }
  }, [source, scope, userId, announcement.id, reload])
  return <TeachingModal title="Хто ознайомився з повідомленням" description={announcement.title} onClose={onClose}>
    <div className="teaching-form" data-teaching-guide="messages-required"><p className="teaching-note">Підтвердження означає натискання «Ознайомився» у Xelay. Надсилання або відкриття листа не є підтвердженням. Показано поточних одержувачів у доступних вам групах.</p><TeachingButton disabled={loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />Оновити підтвердження</TeachingButton>{loading && <p role="status">Перевіряємо ознайомлення…</p>}{error && <p role="alert" className="teaching-error">{error}</p>}{data && <><p className="teaching-announcement-count"><strong>{data.acknowledged} із {data.total}</strong> підтвердили ознайомлення</p>{!data.total ? <p>Зараз немає одержувачів із чинним доступом.</p> : <div className="teaching-announcement-receipts">{data.recipients.map(row => <div key={`${row.user_id}:${row.group_id}`} className="teaching-announcement-receipt"><span>{row.full_name}</span>{row.acknowledged_at ? <span className="text-primary"><CheckCircle2 size={15} />Ознайомився · {teachingDate(row.acknowledged_at, true)}</span> : <span className="text-muted-foreground"><Clock3 size={15} />Ще не підтвердив</span>}</div>)}</div>}</>}</div>
  </TeachingModal>
}
