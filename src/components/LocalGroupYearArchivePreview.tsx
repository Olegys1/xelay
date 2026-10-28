import { useSyncExternalStore } from 'react'
import { Outlet } from '@tanstack/react-router'
import { archivePreviewFixture } from '../../scripts/group-year-archive-preview-fixture'

export function LocalGroupYearArchivePreview() {
  const stats = useSyncExternalStore(archivePreviewFixture.subscribe, archivePreviewFixture.snapshot)
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card/80 px-5 py-5">
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-primary">Xelay · локальний приклад</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Навчальні роки своєї групи</h1><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">Оберіть рік у групі та відкрийте збережені ДЗ, семінари, матеріали й презентації. Усі імена та дані тут вигадані.</p></div>
          <div className="flex flex-wrap gap-2" aria-label="Роль у локальному прикладі">{([['head', 'Староста'], ['student', 'Студент']] as const).map(([role, label]) => <button key={role} type="button" aria-pressed={stats.role === role} onClick={() => archivePreviewFixture.setRole(role)} className={`min-h-10 rounded-full border px-4 text-sm font-medium ${stats.role === role ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}>{label}</button>)}</div>
        </div>
        <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">Перевірка локального прикладу</summary><p className="mt-2">Читань: {stats.reads} · Спроб збереження: {stats.writes} · Зовнішніх запитів: {stats.blockedExternalRequests}. Усі зміни й зовнішні сервери вимкнено.</p><button type="button" className="mt-2 min-h-9 text-primary underline" onClick={() => archivePreviewFixture.resetMetrics()}>Обнулити лічильники</button><ol className="mt-2 max-h-48 overflow-auto">{stats.calls.slice(-15).map((item: Record<string, any>, index: number) => <li key={`${stats.revision}:${index}`}>{item.kind} · {item.name}</li>)}</ol></details>
      </div>
    </header>
    <Outlet />
  </div>
}
