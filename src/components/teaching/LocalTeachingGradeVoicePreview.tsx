import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import { GraduationCap, Headphones, Mic, RotateCcw, UserRound } from 'lucide-react'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES, resetLocalTeachingPreview, type LocalTeachingRole } from '../../lib/localTeachingRepository'
import { TeachingGradeRequests } from './TeachingGradeRequests'
import { TeachingVoiceRecorder } from './TeachingVoiceRecorder'

export function LocalTeachingGradeVoicePreview() {
  const [role, setRole] = useState<LocalTeachingRole>('teacher'), [version, setVersion] = useState(0)
  useState(() => { resetLocalTeachingPreview(); return true })
  const repository = useMemo(() => createLocalTeachingRepository(role), [role, version])
  const identity = LOCAL_TEACHING_IDENTITIES[role]
  useEffect(() => { document.documentElement.classList.add('dark') }, [])
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card px-5 py-6"><div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4"><span className="font-serif text-3xl">Xelay</span><span className="text-xs text-muted-foreground">Локальний приклад · вигадані дані</span></div>
      <p className="mt-7 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.18em] text-sky-400"><Mic size={16} />Ближче до студента</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Іноді простіше пояснити голосом</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">Приватна відповідь на запит про бали. Записує викладач, а студент слухає у своєму запиті.</p>
      <nav className="mt-6 flex flex-wrap gap-2" aria-label="Роль у локальному прикладі">
        {([['teacher', 'Викладач', GraduationCap], ['student', 'Студент', Headphones], ['head', 'Староста', UserRound]] as const).map(([id, label, Icon]) => <button key={id} type="button" onClick={() => setRole(id)} aria-pressed={role === id} className={`teaching-button ${role === id ? 'teaching-button-primary' : ''}`}><Icon size={16} />{label}</button>)}
        <button type="button" className="teaching-button sm:ml-auto" onClick={() => { resetLocalTeachingPreview(); setVersion(value => value + 1) }}><RotateCcw size={15} />Почати приклад заново</button>
      </nav>
    </div></header>
    <main className="mx-auto max-w-5xl px-5 py-8">
      <div className="teaching-note mb-6">{role === 'teacher' ? 'Натисніть «Відповісти». Є запис із мікрофона і окрема кнопка демонстрації без мікрофона.' : 'Кнопки запису тут немає. Після відповіді викладача оберіть стан «Із відповіддю», щоб прослухати її.'}</div>
      <TeachingGradeRequests key={`${role}:${version}`} repository={repository} userId={identity.userId} mode={role === 'teacher' || role === 'colleague' ? 'teacher' : 'student'} groupId={identity.groupId} />
    </main>
    <footer className="mx-auto max-w-5xl px-5 pb-7 text-center text-xs text-muted-foreground">Робочу базу відключено. Записи цього прикладу залишаються в пам’яті браузера.</footer>
  </div>
}

/** Preview-only test control; the normal application always uses the real recorder. */
export function LocalTeachingVoiceRecorder(props: ComponentProps<typeof TeachingVoiceRecorder>) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  return <>
    <TeachingVoiceRecorder {...props} onRecordingChange={value => { setRecording(value); props.onRecordingChange?.(value) }} />
    <div className="mt-3 border-t border-dashed border-border pt-3">
      <button type="button" className="text-xs text-muted-foreground underline underline-offset-4 disabled:opacity-50" disabled={props.disabled || recording || busy} onClick={async () => {
        setBusy(true); setError('')
        try {
          const response = await fetch('/scripts/fixtures/grade-voice-demo.ogg')
          if (!response.ok) throw Error('Не вдалося відкрити демозапис.')
          props.onChange({ file: new File([await response.arrayBuffer()], 'voice-demo.ogg', { type: 'audio/ogg' }), durationSeconds: 2 })
        } catch { setError('Не вдалося підготувати локальний демозапис.') }
        finally { setBusy(false) }
      }}>{busy ? 'Готуємо…' : 'Перевірити на демозаписі без мікрофона'}</button>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  </>
}
