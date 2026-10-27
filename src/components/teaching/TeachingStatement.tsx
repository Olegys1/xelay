import { FileSpreadsheet } from 'lucide-react'
import type { TeachingSnapshot } from '../../lib/teaching'
import type { TeachingStatementRow } from '../../lib/teachingSemesterJournal'

const number = (value: number | null) => value === null ? 'Ще немає балів' : new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 6 }).format(value)
export function TeachingStatement({ snapshot, groupId, rows }: { snapshot: TeachingSnapshot; groupId: string; rows: TeachingStatementRow[] }) {
  const group = snapshot.groups.find(item => item.group_id === groupId)
  const drafts = rows.reduce((total, row) => total + row.pendingDrafts, 0)
  return <section aria-label="Список для відомості" className="space-y-4">
    <div className="teaching-card"><div className="flex items-start gap-3"><FileSpreadsheet size={22} className="shrink-0 text-primary" /><div><h3 className="font-semibold">Підсумки для відомості</h3><p className="mt-1 text-sm text-muted-foreground">{snapshot.course.title} · {group?.group_name} · {snapshot.course.semester}</p><p className="mt-3 text-xs leading-relaxed text-muted-foreground">Тільки опубліковані бали цього предмета. Підсумок враховує коефіцієнти та максимуми групи. Порожній результат не означає нуль.</p>{drafts > 0 && <p role="status" className="teaching-note mt-3">Неопублікованих змін: {drafts}. Перевірте й опублікуйте їх у журналі, якщо вони мають увійти у відомість.</p>}</div></div></div>
    <div className="teaching-table-wrap"><table className="teaching-table"><caption className="sr-only">Опубліковані підсумкові бали групи {group?.group_name} за предметом {snapshot.course.title}</caption><thead><tr><th scope="col">№</th><th scope="col">ПІБ студента</th><th scope="col">Підсумкові бали</th><th scope="col">Оцінених робіт</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.entry.id}><td>{index + 1}</td><th scope="row" className="!whitespace-normal !bg-background">{row.entry.full_name}</th><td className="font-semibold">{number(row.total)}</td><td>{row.assessed}</td></tr>)}</tbody></table></div>
    <p className="text-xs leading-relaxed text-muted-foreground">Це робочий список Xelay для перенесення результатів. Офіційний шаблон відомості кафедри можна буде підключити окремо. Експорт Excel зберігає вибраний порядок студентів.</p>
  </section>
}
