import { ArrowUpRight, Send, X } from 'lucide-react'
import { teachingDate, type TeachingSentGroupRequest, type TeachingWorkspaceData } from '../../lib/teaching'
import { useState } from 'react'
import { TeachingButton, TeachingEmpty, TeachingField, teachingInput } from './TeachingUI'

const labels: Record<TeachingSentGroupRequest['status'], string> = { pending_group: 'Очікує відповіді старости', pending_teacher: 'Потрібна відповідь викладача', accepted: 'Прийнято · групу підключено', rejected: 'Відхилено', removed: 'Скасовано або відключено' }
export function TeachingSentGroupRequests({ workspace, busy, onCancel, onOpen }: { workspace: TeachingWorkspaceData; busy: boolean; onCancel: (request: TeachingSentGroupRequest) => void; onOpen: (courseId: string) => void }) {
  const [status, setStatus] = useState('')
  const requests = workspace.sent_group_requests || []
  const visible = requests.filter(item => !status || item.status === status)
  return <section aria-label="Надіслані запити до груп" className="space-y-5">
    <div><h2 className="flex items-center gap-2 text-xl font-semibold"><Send size={20} />Надіслані запити</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Ваші запрошення навчальним групам: предмет, дата та відповідь старости. Прийняті й відхилені запити залишаються в цьому списку.</p></div>
    <TeachingField label="Стан запиту"><select name="sent-group-request-status" className={teachingInput} value={status} onChange={event => setStatus(event.target.value)}><option value="">Усі запити · {requests.length}</option><option value="pending_group">Очікують відповіді</option><option value="accepted">Прийняті</option><option value="rejected">Відхилені</option><option value="removed">Скасовані або відключені</option></select></TeachingField>
    {workspace.sent_group_requests === undefined ? <p role="status" className="teaching-note">Історія надісланих запитів ще підключається. Поточні запрошення можна переглянути в налаштуваннях предмета.</p> : !visible.length ? <TeachingEmpty icon={<Send size={25} />} title={requests.length ? 'Запитів у цьому стані немає' : 'Ви ще не надсилали запитів'} description="Відкрийте свій предмет і натисніть «Підключити групу». Після надсилання запит з’явиться тут." /> : <div className="teaching-list">{visible.map(item => <article className="teaching-card" key={item.id}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><span className={`teaching-badge ${item.status === 'accepted' ? 'teaching-badge-blue' : ''}`}>{labels[item.status]}</span><h3 className="mt-3 text-lg font-semibold">{item.group_name}</h3><p className="mt-1 text-sm text-muted-foreground">{item.course_title} · {item.semester}</p>{item.representative_name && <p className="mt-1 text-xs text-muted-foreground">Староста: {item.representative_name}</p>}<p className="mt-3 text-xs text-muted-foreground">Запит створено {item.created_at ? teachingDate(item.created_at, true) : 'раніше'}{item.updated_at && item.updated_at !== item.created_at ? ` · Оновлено ${teachingDate(item.updated_at, true)}` : ''}</p></div></div>
      <div className="mt-4 flex flex-wrap gap-2"><TeachingButton disabled={busy} onClick={() => onOpen(item.course_id)}><ArrowUpRight size={15} />Відкрити предмет</TeachingButton>{item.status === 'pending_group' && item.can_cancel && <TeachingButton disabled={busy} onClick={() => onCancel(item)}><X size={15} />Скасувати запит</TeachingButton>}</div>
    </article>)}</div>}
  </section>
}
