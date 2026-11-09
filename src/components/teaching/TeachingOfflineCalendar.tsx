import { useEffect, useRef, useState } from 'react'
import { CloudDownload } from 'lucide-react'
import { getOfflineOwner, loadOfflineTeacherCalendar, OFFLINE_STUDY_CHANGED, OFFLINE_STUDY_DAYS } from '../../lib/offlineStudy'
import { captureOfflineTeacherCalendar, offlineTeacherCaptureError } from '../../lib/offlineTeacherCapture'
import { teachingDate } from '../../lib/teaching'
import { TeachingButton } from './TeachingUI'

export function TeachingOfflineCalendar({ userId }: { userId: string }) {
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const activeSave = useRef<AbortController | null>(null)

  useEffect(() => {
    let generation = 0
    const read = async () => {
      const current = ++generation
      setSavedAt(null)
      try {
        const snapshot = await loadOfflineTeacherCalendar(userId)
        if (current === generation) setSavedAt(snapshot?.savedAt ?? null)
      } catch { /* The live timetable remains available if local storage is blocked. */ }
    }
    void read()
    window.addEventListener(OFFLINE_STUDY_CHANGED, read)
    return () => {
      ++generation
      activeSave.current?.abort()
      activeSave.current = null
      window.removeEventListener(OFFLINE_STUDY_CHANGED, read)
    }
  }, [userId])

  async function save() {
    if (!confirmSave || activeSave.current) return
    const controller = new AbortController()
    activeSave.current = controller
    setSaving(true)
    setFeedback(null)
    try {
      const owner = await getOfflineOwner()
      controller.signal.throwIfAborted()
      if (!owner || owner.id !== userId) throw new Error('OFFLINE_OWNER_CHANGED')
      const saved = await captureOfflineTeacherCalendar({ userId, sessionId: owner.sessionId, signal: controller.signal })
      const currentOwner = await getOfflineOwner()
      controller.signal.throwIfAborted()
      if (currentOwner?.id !== userId || currentOwner.sessionId !== owner.sessionId) throw new Error('OFFLINE_OWNER_CHANGED')
      setSavedAt(saved.savedAt)
      setConfirmSave(false)
      setFeedback({ message: 'Офлайн-копію розкладу збережено.', error: false })
    } catch (error) {
      if (!controller.signal.aborted) setFeedback({ message: offlineTeacherCaptureError(error), error: true })
    } finally {
      if (activeSave.current === controller) {
        activeSave.current = null
        setSaving(false)
      }
    }
  }

  return <section aria-label="Офлайн-копія мого розкладу" className="mb-4 rounded-2xl border border-border bg-muted/30 px-4 py-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><CloudDownload size={16} aria-hidden="true" />Мій розклад офлайн</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Збережіть пари, які ведете, на {OFFLINE_STUDY_DAYS} днів від сьогодні. До копії потраплять час, група, місце, назви та строки завдань.</p>
        {savedAt && <p className="mt-1 text-xs text-muted-foreground">Збережено {teachingDate(savedAt, true)}.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!confirmSave && <TeachingButton onClick={() => { setConfirmSave(true); setFeedback(null) }}>{savedAt ? 'Оновити офлайн-копію' : 'Зберегти офлайн'}</TeachingButton>}
        {savedAt && <a className="teaching-button" href="/offline?view=teaching">Відкрити копію</a>}
      </div>
    </div>
    {confirmSave && <div className="mt-3 space-y-2 rounded-xl border border-border bg-background p-3">
      <p className="text-sm">Зберігайте копію лише на своєму пристрої. Дані будуть доступні в цьому браузері до {OFFLINE_STUDY_DAYS} днів або до виходу з акаунта.</p>
      <div className="flex flex-wrap gap-2">
        <TeachingButton busy={saving} disabled={saving} onClick={() => void save()}>Зберегти на цьому пристрої</TeachingButton>
        <TeachingButton disabled={saving} onClick={() => { setConfirmSave(false); setFeedback(null) }}>Скасувати</TeachingButton>
      </div>
    </div>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'teaching-error mt-3' : 'teaching-note mt-3'}>{feedback.message}</p>}
  </section>
}
