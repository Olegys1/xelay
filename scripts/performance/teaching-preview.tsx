import { useEffect, useMemo, useState } from 'react'
import { TeachingWorkspace } from '../../src/components/teaching/TeachingWorkspace'
import { TeachingWorkspace as BaselineWorkspace } from './teaching-baseline-workspace'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES } from '../../src/lib/localTeachingRepository'
import type { TeachingRepository } from '../../src/lib/teaching'

type Counts = Record<string, number>
const readMethods = new Set(['workspace', 'course', 'materialLibrary', 'teacherCalendar', 'scheduledItems', 'gradeRequests', 'classroom', 'assignmentLessons', 'myMaterials', 'groupContext', 'classroomSeminars'])

export function TeachingPerformancePreview() {
  const [baseline, setBaseline] = useState(false)
  const [counts, setCounts] = useState<Counts>({})
  const [run, setRun] = useState(0)
  const [testResult, setTestResult] = useState('')
  const [testing, setTesting] = useState(false)
  useEffect(() => { document.documentElement.classList.add('dark') }, [])
  const repository = useMemo(() => {
    const source = createLocalTeachingRepository('teacher')
    return Object.fromEntries(Object.entries(source).map(([name, value]) => [name, typeof value !== 'function' ? value : async (...args: unknown[]) => {
      if (readMethods.has(name)) {
        setCounts(previous => ({ ...previous, [name]: (previous[name] || 0) + 1 }))
        // Fixed delay makes repeated loading visible; it is not a production speed benchmark.
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      return value.apply(source, args)
    }])) as unknown as TeachingRepository
  }, [run, baseline])
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const rpcs = total + (counts.workspace || 0)
  const Workspace = baseline ? BaselineWorkspace : TeachingWorkspace
  const identity = LOCAL_TEACHING_IDENTITIES.teacher
  return <div className="min-h-screen bg-background text-foreground">
    <div className="border-b border-border bg-card px-5 py-5"><div className="mx-auto max-w-[1180px]">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Xelay · Локальна перевірка</p>
      <h1 className="mt-2 text-2xl font-semibold">Кабінет викладача без зайвих завантажень</h1>
      <p className="mt-2 text-sm text-muted-foreground">Вигадані дані. Робоча база відключена. Затримка 250 мс додана лише для наочності.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={`teaching-button ${!baseline ? 'teaching-button-primary' : ''}`} aria-pressed={!baseline} onClick={() => { setCounts({}); setBaseline(false); setRun(value => value + 1) }}>Після оптимізації</button>
        <button type="button" className={`teaching-button ${baseline ? 'teaching-button-primary' : ''}`} aria-pressed={baseline} onClick={() => { setCounts({}); setBaseline(true); setRun(value => value + 1) }}>До оптимізації</button>
        <button type="button" className="teaching-button" onClick={() => setCounts({})}>Обнулити лічильник</button>
        <span className="ml-2 text-sm" role="status">Читань: <strong>{total}</strong> · Запитів до БД: <strong>{rpcs}</strong></span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{Object.entries(counts).map(([method, count]) => `${method}: ${count}`).join(' · ') || 'Лічильник очищено'} · У робочому кабінеті workspace складається з двох запитів.</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Перевірки роботи кабінету</summary>
        <button className="teaching-button mt-3" type="button" disabled={testing} onClick={async () => {
          setTesting(true); setTestResult('Перевіряємо на тестових даних…')
          try {
            const { runTeachingBrowserTests } = await import('./teaching-browser-fixture')
            const result = await runTeachingBrowserTests()
            setTestResult(JSON.stringify(result, null, 2))
          } catch (error) { setTestResult(String(error)) }
          finally { setTesting(false) }
        }}>Перевірити локально</button>
        {testResult && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{testResult}</pre>}
      </details>
    </div></div>
    <Workspace key={`${baseline}:${run}`} repository={repository} userId={identity.userId} fullName={identity.fullName} />
  </div>
}
