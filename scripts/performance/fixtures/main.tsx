import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../../../src/App'
import { ThemeProvider } from '../../../src/context/ThemeContext'
import '../../../src/index.css'
import { fixture } from './mockSupabase'

function Controls() {
  const [snapshot, setSnapshot] = useState(fixture.snapshot())
  const [slow, setSlow] = useState(false)
  const [mounted, setMounted] = useState(true)
  useEffect(() => fixture.subscribe(() => setSnapshot(fixture.snapshot())), [])
  const counts: Record<string, number> = {}
  for (const request of snapshot.requests) counts[request.name + (request.detail.head ? ':count' : '')] = (counts[request.name + (request.detail.head ? ':count' : '')] || 0) + 1
  return <><aside className="border-b border-primary/30 bg-accent p-3 text-xs text-accent-foreground" aria-label="Локальні перевірки">
    <strong>Локальна перевірка справжніх компонентів · робоча база відключена</strong>
    <div className="mt-2 flex flex-wrap gap-2">{[
      ['Очистити лічильники', () => fixture.clearMetrics()],
      ['Нове запитання з іншої вкладки', () => fixture.externalQuestion()],
      ['Додати фото з іншої вкладки', () => fixture.externalImage()],
      ['Пачка 8 подій', () => fixture.burst()],
      ['Помилка завантаження фото', () => fixture.fail()],
      ['Помилка завантаження питань', () => fixture.fail('questions')],
      ['Помилка транспорту', () => fixture.fail('questions', true)],
      ['Завислий запит', () => fixture.hang()],
      [slow ? 'Швидка мережа' : 'Повільна мережа', () => { fixture.slow(!slow); setSlow(!slow) }],
      [snapshot.visibility === 'visible' ? 'Приховати вкладку' : 'Повернути вкладку', () => fixture.hidden(snapshot.visibility === 'visible')],
      ['Realtime недоступний', () => fixture.realtime(false)],
      ['Відновити Realtime', () => fixture.realtime(true)],
      ['Нове сповіщення', () => fixture.notify()],
      ['Змінити локальний акаунт', () => fixture.switchUser()],
      ['Гість', () => fixture.guest()],
      [mounted ? 'Прибрати застосунок' : 'Повернути застосунок', () => setMounted(!mounted)],
    ].map(([label, action]) => <button key={String(label)} className="rounded-lg border border-primary/25 px-2 py-1" onClick={action as () => void}>{String(label)}</button>)}</div>
    <output data-testid="local-request-counts" className="mt-2 block break-words">{JSON.stringify({ counts, active: snapshot.active, maxActive: snapshot.maxActive, channels: snapshot.channels, visibility: snapshot.visibility, questions: snapshot.questions, unread: snapshot.notifications })}</output>
    <details className="mt-2"><summary>Запити до локальної бази</summary><pre data-testid="local-query-log" className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(snapshot.requests, null, 2)}</pre></details>
  </aside>{mounted && <App />}</>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemeProvider><Controls /></ThemeProvider></React.StrictMode>)
