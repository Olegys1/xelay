import { useId, useState } from 'react'
import { ArrowUpRight, BookOpen, CalendarDays, FolderOpen, Play, RefreshCw, ShieldCheck, UsersRound, Video } from 'lucide-react'
import { safeStudyGroupGuideMediaUrl, STUDY_GROUP_VIDEO_GUIDES, type StudyGroupGuideTarget, type StudyGroupVideoGuide } from '../lib/studyGroupVideoGuides'

type Props = {
  onNavigate: (target: StudyGroupGuideTarget) => void
  canManageDeputies?: boolean
}

const SHORTCUTS = [
  { target: 'members', icon: UsersRound, title: 'Запросити одногрупників', text: 'У блоці «Учасники групи» введіть нік людини у Xelay. Доступ з’явиться після прийняття запрошення.' },
  { target: 'timetable', icon: CalendarDays, title: 'Налаштувати розклад', text: 'Відкрийте «Наш розклад», щоб додати пари або перенести таблицю з фото й перевірити результат.' },
  { target: 'schedule', icon: CalendarDays, title: 'Додати домашнє завдання', text: 'У «Розклад і ДЗ» оберіть дату та потрібну пару. Додайте тему, завдання, файли й посилання.' },
  { target: 'seminars', icon: BookOpen, title: 'Підготувати семінар', text: 'Додайте предмет, заняття та питання або командну роботу. Учасники зможуть обрати свої завдання.' },
  { target: 'materials', icon: FolderOpen, title: 'Зібрати матеріали', text: 'Зберігайте презентації, конспекти й корисні посилання за предметами та темами.' },
  { target: 'deputies', icon: ShieldCheck, title: 'Призначити заступників', text: 'Оберіть учасника й конкретні дозволи. Права можна змінити або скасувати в будь-який момент.' },
] as const

export function StudyGroupVideoGuides({ onNavigate, canManageDeputies = false }: Props) {
  const titleId = useId()
  const shortcutsId = useId()
  return <div className="min-w-0 space-y-6">
    <section aria-labelledby={titleId} className="relative min-w-0 overflow-hidden rounded-3xl border border-primary/15 bg-primary/5 p-5 sm:p-7">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/5" aria-hidden="true" />
      <div className="relative flex items-start gap-3.5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary/10 bg-background text-primary"><Video size={23} aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Допомога з навчальною групою</p>
          <h2 id={titleId} className="mt-1.5 break-words text-xl font-semibold sm:text-2xl">Відеогайди для старост і заступників</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">Пояснення та короткі маршрути до потрібних дій. Цей розділ доступний старостам і призначеним заступникам усіх навчальних груп.</p>
        </div>
      </div>
    </section>

    {STUDY_GROUP_VIDEO_GUIDES.length > 0 ? <div className={`grid min-w-0 gap-5 ${STUDY_GROUP_VIDEO_GUIDES.length > 1 ? 'lg:grid-cols-2' : ''}`}>
      {STUDY_GROUP_VIDEO_GUIDES.map((guide) => <VideoGuideCard key={`${guide.id}:${guide.videoUrl}`} guide={guide} />)}
    </div> : <section className="flex min-w-0 flex-col items-start gap-4 rounded-2xl border border-border bg-background p-5 sm:flex-row sm:items-center sm:p-6" aria-label="Відеогайди готуються">
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-muted text-primary"><Play size={26} aria-hidden="true" /></span>
      <div className="min-w-0">
        <span className="inline-flex rounded-full border border-primary/15 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary">Відео готуємо</span>
        <h3 className="mt-2.5 text-base font-semibold">Тут з’явиться відео від команди Xelay</h3>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">Додамо його до цього розділу для всіх старост і заступників, щойно гайд буде готовий. Поки можна скористатися короткими підказками нижче.</p>
      </div>
    </section>}

    <section aria-labelledby={shortcutsId} className="min-w-0">
      <div className="mb-4"><h3 id={shortcutsId} className="text-lg font-semibold">З чого почати</h3><p className="mt-1 text-sm text-muted-foreground">Оберіть дію — відкриємо потрібний розділ цієї групи.</p></div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {SHORTCUTS.filter(({ target }) => target !== 'deputies' || canManageDeputies).map(({ target, icon: Icon, title, text }) => <button key={target} type="button" onClick={() => onNavigate(target)} className="group flex min-w-0 flex-col rounded-2xl border border-border bg-background p-4 text-left transition-colors hover:border-primary/25 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none sm:p-5">
          <span className="mb-3 flex w-full items-center justify-between gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-primary transition-colors group-hover:bg-background motion-reduce:transition-none"><Icon size={19} aria-hidden="true" /></span><ArrowUpRight size={18} className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary motion-reduce:transition-none" aria-hidden="true" /></span>
          <span className="break-words text-sm font-semibold">{title}</span><span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{text}</span>
          <span className="mt-4 block text-xs font-semibold text-primary">Відкрити розділ</span>
        </button>)}
      </div>
    </section>
  </div>
}

function VideoGuideCard({ guide }: { guide: StudyGroupVideoGuide }) {
  const titleId = useId()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const videoUrl = safeStudyGroupGuideMediaUrl(guide.videoUrl)
  const posterUrl = safeStudyGroupGuideMediaUrl(guide.posterUrl) || undefined
  return <article aria-labelledby={titleId} className="min-w-0 overflow-hidden rounded-2xl border border-border bg-background">
    <div className="flex aspect-video items-center justify-center bg-muted">
      {videoUrl && !failed ? <video key={attempt} controls playsInline preload="none" poster={posterUrl} src={videoUrl} onError={() => setFailed(true)} aria-label={guide.title} className="h-full w-full object-contain">
        Ваш браузер не підтримує відтворення відео. <a href={videoUrl} target="_blank" rel="noopener noreferrer">Відкрити відео окремо</a>
      </video> : <div className="flex max-w-sm flex-col items-center gap-3 p-5 text-center" role="status">
        <Video size={27} className="text-muted-foreground" aria-hidden="true" /><p className="text-sm font-medium">Відео поки не вдалося відкрити</p><p className="text-xs leading-relaxed text-muted-foreground">{videoUrl ? 'Перевірте з’єднання та спробуйте ще раз.' : 'Команда Xelay має оновити посилання на цей гайд.'}</p>
        {videoUrl && <><button type="button" onClick={() => { setAttempt((value) => value + 1); setFailed(false) }} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"><RefreshCw size={16} aria-hidden="true" />Спробувати ще раз</button><a href={videoUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-primary underline underline-offset-4">Відкрити відео окремо</a></>}
      </div>}
    </div>
    <div className="p-4 sm:p-5"><h3 id={titleId} className="break-words text-base font-semibold">{guide.title}</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{guide.description}</p></div>
  </article>
}
