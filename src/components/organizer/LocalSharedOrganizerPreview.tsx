import { useState } from 'react'
import { Moon, Sun, RotateCcw } from 'lucide-react'
import { SharedOrganizer } from '../SharedOrganizer'
import { ToastProvider } from '../../context/ToastContext'
import { PREVIEW_ORGANIZER_USER, resetOrganizerPreview, type PreviewOrganizerScenario } from '../../lib/sharedOrganizerPreview'

export function LocalSharedOrganizerPreview() {
  const [scenario, setScenario] = useState<PreviewOrganizerScenario>('team')
  const [revision, setRevision] = useState(0)
  const [dark, setDark] = useState(false)
  function reset(value: PreviewOrganizerScenario) { resetOrganizerPreview(value); setScenario(value); setRevision(value => value + 1) }
  return <ToastProvider><div className="min-h-screen bg-background text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-5 py-3 text-xs">
      <p><strong>Локальний перегляд</strong> · Вигадана команда, без доступу до робочих даних</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">Приклад<select aria-label="Приклад команди" value={scenario} onChange={event => reset(event.target.value as PreviewOrganizerScenario)} className="rounded-lg border border-border bg-background p-2"><option value="team">Команда з 12 людей</option><option value="full">Повна команда · 35 людей</option><option value="empty">Без завдань</option></select></label>
        <button type="button" aria-label="Почати приклад заново" onClick={() => reset(scenario)} className="rounded-lg border border-border p-2"><RotateCcw size={16} /></button>
        <button type="button" aria-label={dark ? 'Світла тема' : 'Темна тема'} onClick={() => { document.documentElement.classList.toggle('dark', !dark); setDark(!dark) }} className="rounded-lg border border-border p-2">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
      </div>
    </div>
    <main className="mx-auto w-full max-w-[1440px] px-3 py-6 sm:px-7 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-3"><div><a href="#" className="font-serif text-3xl font-semibold tracking-tight">Xelay</a><p className="mt-1 text-xs text-muted-foreground">Спільний органайзер</p></div><span className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">Лише локально</span></header>
      <SharedOrganizer key={revision} userId={PREVIEW_ORGANIZER_USER} />
      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Можна створювати й редагувати завдання, перемикати простори та запрошувати за ніком. Для прикладу: <strong>@danylo.koval</strong> або <strong>@iryna.mazur</strong>. Усі зміни існують лише в цьому прикладі й скидаються після перезавантаження.</p>
    </main>
  </div></ToastProvider>
}
