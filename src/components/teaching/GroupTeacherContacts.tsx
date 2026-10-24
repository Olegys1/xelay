import { useCallback, useEffect, useRef, useState } from 'react'
import { GraduationCap, Mail, MessageCircle, Phone, Send } from 'lucide-react'
import { academicContactError, academicContactHref, supabaseAcademicContactRepository, type AcademicContactRepository, type AcademicConversationContext, type AcademicTeacherContact } from '../../lib/academicContacts'
import { TeachingButton, TeachingEmpty, TeachingModal } from './TeachingUI'

export function AcademicStudentIdentity({ context }: { context: AcademicConversationContext['contexts'][number] }) {
  const level = ({ bachelor: 'Бакалаврат', master: 'Магістратура', postgraduate: 'Аспірантура' } as Record<string, string>)[context.study_level || '']
  return <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-3 text-sm">
    <p className="font-semibold">{context.student_name}</p>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{[context.group_name, context.specialty, context.study_year ? `${context.study_year} курс` : null, level, context.academic_unit_name].filter(Boolean).join(' · ')}</p>
    <p className="mt-2 text-xs"><span className="text-muted-foreground">Звернення щодо предмета: </span>{context.course_title}</p>
    <p className="mt-1 text-[11px] text-muted-foreground">Групу й предмет підтверджено через Xelay.</p>
  </div>
}

export function GroupTeacherContacts({ groupId, userId, repository = supabaseAcademicContactRepository, onOpenConversation }: { groupId: string; userId: string; repository?: AcademicContactRepository; onOpenConversation?: (conversationId: string, context: AcademicConversationContext) => void | Promise<void> }) {
  const [teachers, setTeachers] = useState<AcademicTeacherContact[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [localContext, setLocalContext] = useState<AcademicConversationContext | null>(null)
  const [selectedCourses, setSelectedCourses] = useState<Record<string, string>>({})
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const version = ++sequence.current
    setLoading(true); setError('')
    try {
      const data = await repository.loadGroup(groupId)
      if (sequence.current === version) setTeachers(data.teachers)
    } catch (failure) { if (sequence.current === version) setError(academicContactError(failure)) }
    finally { if (sequence.current === version) setLoading(false) }
  }, [groupId, repository])
  useEffect(() => { setTeachers([]); setSelectedCourses({}); setBusy(''); setLocalContext(null); void load(); return () => { sequence.current++ } }, [load, userId])

  async function open(teacher: AcademicTeacherContact) {
    if (busy) return
    const version = sequence.current
    const courseId = selectedCourses[teacher.user_id] || teacher.courses[0]?.id
    if (!courseId) return
    setBusy(teacher.user_id); setError('')
    try {
      const result = await repository.openConversation(teacher.user_id, groupId, courseId, userId)
      if (sequence.current !== version) return
      if (onOpenConversation || repository.mode === 'local') {
        const context = await repository.conversationContext(result.conversation_id)
        if (sequence.current !== version) return
        if (onOpenConversation) await onOpenConversation(result.conversation_id, context)
        else setLocalContext(context)
      } else window.location.assign(`/messages?kind=personal&conversation=${encodeURIComponent(result.conversation_id)}`)
    } catch (failure) { if (sequence.current === version) setError(academicContactError(failure)) }
    finally { if (sequence.current === version) setBusy('') }
  }

  return <section aria-label="Зв’язок із викладачами" className="rounded-2xl border border-border p-4 sm:p-5">
    <div className="mb-4 flex items-start gap-3"><span className="rounded-xl bg-sky-500/10 p-2 text-sky-500"><GraduationCap size={22} /></span><div><h3 className="font-semibold">Зв’язок із викладачами</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Викладачі, підключені до вашої групи. Напишіть у Xelay або скористайтеся відкритими ними контактами.</p></div></div>
    {error && <div role="alert" className="teaching-error mb-3">{error}<button type="button" className="ml-2 underline" onClick={() => void load()}>Оновити</button></div>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">Завантажуємо викладачів…</p> : !teachers.length ? <TeachingEmpty title="Викладачі ще не підключені" description="Коли викладач прийме запрошення до предмета вашої групи, тут з’являться його картка та способи зв’язку." /> : <div className="grid gap-3 sm:grid-cols-2">{teachers.map(teacher => {
      const external = ([['email', teacher.contact_email, Mail, 'Пошта'], ['phone', teacher.contact_phone, Phone, 'Телефон'], ['telegram', teacher.contact_telegram, Send, 'Telegram']] as const).filter(([, value]) => value)
      return <article className="flex flex-col rounded-xl border border-border bg-muted/20 p-4" key={teacher.user_id}>
        <h4 className="text-sm font-semibold">{teacher.full_name}</h4><p className="mt-1 text-xs text-muted-foreground">{[teacher.position || 'Викладач', teacher.is_postgraduate ? 'Аспірант' : null].filter(Boolean).join(' · ')}</p>
        <p className="mb-3 mt-2 text-sm">{teacher.courses.map(course => course.title).join(' · ')}</p>
        {teacher.courses.length > 1 && <label className="mb-3 text-xs text-muted-foreground">Предмет звернення<select className="teaching-input mt-1" aria-label={`Предмет звернення до ${teacher.full_name}`} value={selectedCourses[teacher.user_id] || teacher.courses[0]?.id} onChange={event => setSelectedCourses(current => ({ ...current, [teacher.user_id]: event.target.value }))}>{teacher.courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>}
        <div className="mt-auto"><TeachingButton primary busy={busy === teacher.user_id} disabled={Boolean(busy)} onClick={() => void open(teacher)}><MessageCircle size={15} />Написати у Xelay</TeachingButton></div>
        {!!external.length ? <div className="mt-3 flex flex-wrap gap-2">{external.map(([kind, value, Icon, label]) => {
          const href = academicContactHref(kind, value!)
          return href ? <a key={kind} href={href} target={kind === 'telegram' ? '_blank' : undefined} rel={kind === 'telegram' ? 'noopener noreferrer' : undefined} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-xs hover:bg-muted" title={value!}><Icon size={13} />{label}</a> : null
        })}</div> : <p className="mt-3 text-xs text-muted-foreground">Зовнішні контакти викладач не відкрив.</p>}
      </article>
    })}</div>}
    <p className="mt-4 text-xs leading-relaxed text-muted-foreground">У переписці викладач бачить ваше ім’я, групу, освітню програму та курс. Відкриття чату не надсилає повідомлення.</p>
    {localContext && <TeachingModal title="Переписка з викладачем" description="Локальний приклад. Жодне повідомлення не надсилається." onClose={() => setLocalContext(null)}>{localContext.contexts[0] && <AcademicStudentIdentity context={localContext.contexts[0]} />}<div className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Чат відкрито. Тут буде ваше повідомлення викладачеві.</div></TeachingModal>}
  </section>
}
