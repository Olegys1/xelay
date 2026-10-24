import { useEffect, useState } from 'react'
import { GraduationCap, Mail, Phone, Send } from 'lucide-react'
import { loadTeacherContacts, type TeacherContactProjection } from '../lib/teacherAcademicProfile'

export function TeacherPublicContacts({ teacherId, load = loadTeacherContacts }: {
  teacherId: string
  load?: (teacherId: string) => Promise<TeacherContactProjection>
}) {
  const [result, setResult] = useState<{ owner: string; value: TeacherContactProjection } | null>(null)
  useEffect(() => {
    let active = true
    setResult(null)
    void load(teacherId).then(value => {
      if (active && value?.user_id === teacherId) setResult({ owner: teacherId, value })
    }).catch(() => { /* Optional public contacts must never block the profile. */ })
    return () => { active = false }
  }, [teacherId, load])
  const profile = result?.owner === teacherId ? result.value : null
  if (!profile?.verified) return null
  const email = profile.contact_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contact_email) ? profile.contact_email : null
  const phone = profile.contact_phone && /^\+?[\d\s().-]{6,40}$/.test(profile.contact_phone) ? profile.contact_phone : null
  const telegram = profile.contact_telegram?.replace(/^@/, '')
  const safeTelegram = telegram && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(telegram) ? telegram : null
  if (!profile.is_postgraduate && !profile.position && !email && !phone && !safeTelegram) return null
  return <section className="mt-5 border-t border-border pt-5" aria-label="Відомості та відкриті контакти викладача">
    {(profile.position || profile.is_postgraduate) && <p className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><GraduationCap size={16} aria-hidden="true" />{[profile.position, profile.is_postgraduate ? 'Аспірант' : ''].filter(Boolean).join(' · ')}</p>}
    {(email || phone || safeTelegram) && <>
      <h2 className="text-sm font-semibold">Зв’язок із викладачем</h2>
      <p className="mt-1 text-xs text-muted-foreground">Контакти, які викладач дозволив показувати у відкритому профілі.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {email && <a className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted" href={`mailto:${encodeURIComponent(email)}`}><Mail size={15} className="shrink-0" /><span className="break-all">{email}</span></a>}
        {phone && <a className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted" href={`tel:${phone.replace(/[^+\d]/g, '')}`}><Phone size={15} />{phone}</a>}
        {safeTelegram && <a className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted" href={`https://t.me/${safeTelegram}`} target="_blank" rel="noopener noreferrer"><Send size={15} />@{safeTelegram}</a>}
      </div>
    </>}
  </section>
}
