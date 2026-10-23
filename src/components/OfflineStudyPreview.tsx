import { useEffect, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { OfflineStudyReader } from './OfflineStudyReader'
import { establishOfflineOwner, getOfflineOwner, listOfflineGroups, saveOfflineGroupSnapshot, type OfflineGroupSnapshotInput } from '../lib/offlineStudy'
import { getOfflineShellStatus, prepareOfflineShellPreview, subscribeOfflineShell } from '../lib/offlineShell'

const DEMO_OWNER = 'a7000000-0000-4000-8000-000000000001'
const DEMO_GROUP = 'a7000000-0000-4000-8000-000000000002'
function dayAfter(date: string, days: number) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) }
function samplePhoto(): string {
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 330
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fffaf3'; context.fillRect(0, 0, 960, 330)
  context.fillStyle = '#321d46'; context.font = 'bold 28px system-ui'; context.fillText('Приклад розкладу · вигадані дані', 28, 46)
  const rows = [['Час', 'Предмет', 'Аудиторія'], ['08:00–09:20', 'Вища математика', '203'], ['09:40–11:00', 'Економічна теорія', 'Онлайн'], ['11:20–12:40', 'Іноземна мова', '405']]
  rows.forEach((row, index) => {
    context.fillStyle = index === 0 ? '#f5d9ae' : index % 2 ? '#fff' : '#f8f0e7'; context.fillRect(24, 72 + index * 58, 912, 58)
    context.fillStyle = '#321d46'; context.font = index === 0 ? 'bold 21px system-ui' : '21px system-ui'
    row.forEach((text, column) => context.fillText(text, [40, 290, 770][column], 108 + index * 58))
  })
  return canvas.toDataURL('image/png')
}
function example(): OfflineGroupSnapshotInput {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date())
  const tomorrow = dayAfter(today, 1); const next = dayAfter(today, 2)
  return {
    groupId: DEMO_GROUP, groupName: 'Приклад · ЕУБ-1', rangeStart: today, rangeEnd: dayAfter(today, 13),
    lessons: [
      { id: 'demo-math', date: tomorrow, subject: 'Вища математика', startsAt: '08:00', endsAt: '09:20', lessonType: 'practical', teacherName: 'Викладачка з прикладу', location: '203' },
      { id: 'demo-economics', date: tomorrow, subject: 'Економічна теорія', startsAt: '09:40', endsAt: '11:00', lessonType: 'seminar', location: 'Онлайн' },
      { id: 'demo-language', date: next, subject: 'Іноземна мова', startsAt: '11:20', endsAt: '12:40', lessonType: 'practical', location: '405' },
    ],
    homework: [
      { id: 'demo-hw-math', date: tomorrow, scheduleItemId: 'demo-math', subject: 'Вища математика', title: 'Похідні та їх застосування', body: 'Розв’язати задачі № 1–6 з теми «Похідна».\n\nДля кожної задачі записати формулу, хід розв’язання та відповідь. Повторити правила диференціювання.\n\nЦе вигадане завдання для демонстрації офлайн-режиму.', fileNames: ['Задачі до практичного заняття.pdf'] },
      { id: 'demo-hw-economics', date: tomorrow, scheduleItemId: 'demo-economics', subject: 'Економічна теорія', title: 'Попит і пропозиція', body: 'Підготувати відповіді:\n1. Що впливає на попит?\n2. Як визначити рівноважну ціну?\n3. Навести приклад зміни пропозиції.\n\nЦе приклад. Він не належить справжній навчальній групі.', links: [{ label: 'Додаткове читання', url: 'https://www.xelay.ink/' }] },
    ],
    assignments: [{ id: 'demo-teacher-hw', date: next, scheduleItemId: 'demo-language', subject: 'Іноземна мова', title: 'Короткий текст про навчання', body: 'Напишіть 8–10 речень про свій навчальний тиждень. Використайте слова з останньої теми.\n\nДемонстраційне завдання від викладача.', teacherName: 'Викладач із прикладу', dueAt: `${next}T18:00:00+03:00` }],
    timetablePhoto: { dataUrl: samplePhoto(), updatedAt: new Date().toISOString() },
  }
}

export function OfflineStudyPreview() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [shell, setShell] = useState(getOfflineShellStatus)
  const [preparing, setPreparing] = useState(false)
  useEffect(() => subscribeOfflineShell(() => setShell(getOfflineShellStatus())), [])
  useEffect(() => {
    let alive = true
    const start = async () => {
      if (!import.meta.env.DEV || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw new Error('Це лише локальний приклад.')
      const previous = await getOfflineOwner()
      if (previous && previous.id !== DEMO_OWNER) throw new Error('На цій локальній адресі вже є збережені дані іншого акаунта. Приклад їх не замінює.')
      const owner = await establishOfflineOwner(DEMO_OWNER, 'Демонстраційний користувач')
      const groups = await listOfflineGroups(owner.id)
      if (!groups.some(group => group.groupId === DEMO_GROUP)) {
        if (!navigator.onLine) throw new Error('Спочатку відкрийте приклад з інтернетом, щоб зберегти вигадані дані.')
        await saveOfflineGroupSnapshot(owner.id, example(), owner.sessionId)
      }
      sessionStorage.setItem('xelay-offline-local-preview', '1')
      if (alive) setReady(true)
    }
    void start().catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Не вдалося відкрити приклад.') })
    return () => { alive = false }
  }, [])
  const prepare = async () => {
    setPreparing(true); setError('')
    try { await prepareOfflineShellPreview() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не вдалося підготувати перегляд.') }
    finally { setPreparing(false) }
  }
  return <div className="min-h-screen bg-background text-foreground">
    <div className="border-b border-amber-400/40 bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-950">Локальний приклад · усі навчальні дані вигадані · на робочому сайті змін немає</div>
    <section className="mx-auto max-w-5xl px-4 pt-5 sm:px-6">
      <div className="rounded-2xl border border-primary/25 bg-primary/5 p-4 sm:p-5">
        <h1 className="text-xl font-semibold">Розклад і ДЗ залишаються з вами</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Цей приклад зберігає дані на вашому пристрої. Підготуйте перегляд, а потім відкрийте збережену копію. Після підготовки її можна повторно відкрити, навіть якщо локальний сервер вимкнено.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={!ready || preparing} onClick={() => void prepare()} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{preparing ? <Loader2 size={16} className="animate-spin" /> : shell.ready ? <CheckCircle2 size={16} /> : <Download size={16} />}{preparing ? 'Зберігаємо перегляд…' : shell.ready ? 'Підготувати ще раз' : 'Підготувати офлайн-перегляд'}</button>
          <a href="/offline" className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold ${shell.ready ? '' : 'pointer-events-none opacity-50'}`} aria-disabled={!shell.ready}><WifiOff size={16} />Відкрити збережене</a>
          {shell.ready && <span role="status" className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={16} />Локальний перегляд готовий</span>}
        </div>
        {(error || shell.error) && <p role="alert" className="mt-3 text-sm text-destructive">{error || shell.error}</p>}
      </div>
    </section>
    {ready ? <OfflineStudyReader ownerId={DEMO_OWNER} initialGroupId={DEMO_GROUP} /> : <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><RefreshCw size={16} className="animate-spin" />Готуємо приклад…</div>}
  </div>
}
