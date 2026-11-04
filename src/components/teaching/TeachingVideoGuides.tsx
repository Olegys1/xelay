import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, Clock3, Play, RotateCcw, Sparkles, Video } from 'lucide-react'
import { readTeacherGuideProgress, saveTeacherGuideProgress, TEACHER_GUIDE_UPDATES, TEACHER_VIDEO_GUIDES, teacherGuideDuration, teacherGuideManualUrl, type TeacherGuideProgress } from '../../lib/teacherVideoGuides'
import './teaching-video-guides.css'

function browserStorage() { try { return window.localStorage } catch { return undefined } }

export default function TeachingVideoGuides({ userId }: { userId: string }) {
  // The workspace keys this component by account, so local progress cannot cross accounts.
  const [progress, setProgress] = useState< TeacherGuideProgress>(() => readTeacherGuideProgress(browserStorage(), userId))
  const [selected, setSelected] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false), [saved, setSaved] = useState(true)
  const [saveRevision, setSaveRevision] = useState(0)
  const playerHeading = useRef<HTMLHeadingElement>(null)
  const catalogueHeading = useRef<HTMLHeadingElement>(null)
  const index = TEACHER_VIDEO_GUIDES.findIndex(guide => guide.id === selected)
  const lesson = TEACHER_VIDEO_GUIDES[index]
  const completed = progress.completed.length
  useEffect(() => { if (saveRevision) setSaved(saveTeacherGuideProgress(browserStorage(), userId, progress)) }, [progress, userId, saveRevision])
  function open(id: string) {
    setSelected(id); setPlaying(false); setFailed(false)
    setProgress(previous => ({ ...previous, lastLesson: id })); setSaveRevision(revision => revision + 1)
    requestAnimationFrame(() => playerHeading.current?.focus())
  }
  function markDone() {
    if (!lesson) return
    setProgress(previous => ({ ...previous, completed: [...new Set([...previous.completed, lesson.id])] })); setSaveRevision(revision => revision + 1)
  }
  function showCatalogue() {
    setSelected(null); setPlaying(false)
    requestAnimationFrame(() => catalogueHeading.current?.focus())
  }
  return <div className="tvg-course">
    <section className="tvg-hero" aria-label="Відеокурс для викладачів">
      <div className="tvg-hero-copy"><span className="tvg-kicker"><Video size={15} />Від команди Xelay</span><h2>Усе для впевненого<br className="tvg-desktop-break" /> старту викладання</h2><p>Шість коротких відео. Від першого предмета до опублікованих балів. Обирайте потрібну тему та повторюйте кроки у своєму кабінеті.</p><div className="tvg-meta"><span><BookOpen size={15} />6 уроків</span><span><Clock3 size={15} />Близько 11 хвилин</span><span>У власному темпі</span></div><button type="button" className="tvg-button tvg-primary" onClick={() => open(progress.lastLesson || TEACHER_VIDEO_GUIDES[0].id)}><Play size={16} />{progress.lastLesson ? 'Продовжити навчання' : 'Почати з першого уроку'}<ArrowRight size={16} /></button></div>
      <div className="tvg-progress-card"><span className="tvg-orbit" aria-hidden="true"><GraduationMark /></span><span className="tvg-progress-label">Ваш маршрут</span><strong>{completed}<span> / 6</span></strong><p>{completed === 6 ? 'Усі уроки позначено переглянутими' : 'уроків позначено переглянутими'}</p><progress value={completed} max={6} aria-label="Переглянуті уроки" /><small>Позначки зберігаються у цьому браузері для вашого акаунта.</small></div>
    </section>
    {!saved && <p className="tvg-notice" role="status">Браузер не зберіг позначки. Відео доступні, але після закриття сторінки прогрес може зникнути.</p>}

    {lesson ? <section className="tvg-learning" aria-label="Перегляд уроку">
      <div className="tvg-lesson-main"><button className="tvg-text-button" type="button" onClick={showCatalogue}><ArrowLeft size={16} />Усі уроки</button><div className="tvg-lesson-label">Урок {index + 1} з 6 <span>· {teacherGuideDuration(lesson.durationSeconds)}</span></div><h3 ref={playerHeading} tabIndex={-1}>{lesson.title}</h3>
        <div className="tvg-player" key={lesson.id}>
          {failed ? <div className="tvg-player-error" role="status"><Video size={30} /><strong>Не вдалося відкрити відео</strong><p>Перевірте з’єднання та спробуйте ще раз.</p><button type="button" className="tvg-button" onClick={() => { setFailed(false); setPlaying(true) }}><RotateCcw size={16} />Повторити</button><a href={lesson.videoUrl} target="_blank" rel="noopener noreferrer">Відкрити відео окремо</a></div> : playing ? <video key={lesson.id} controls autoPlay playsInline preload="none" poster={lesson.posterUrl} src={lesson.videoUrl} aria-label={lesson.title} onEnded={markDone} onError={() => setFailed(true)}>Ваш браузер не підтримує відео. <a href={lesson.videoUrl}>Відкрити відео</a></video> : <button type="button" className="tvg-play-cover" aria-label={`Дивитися урок ${index + 1}: ${lesson.title}`} onClick={() => setPlaying(true)}><img src={lesson.posterUrl} alt="Кадр із відеоуроку" /><span><Play size={28} fill="currentColor" /><b>Дивитися урок</b></span></button>}
        </div>
        <div className="tvg-lesson-actions"><button type="button" className={`tvg-button ${progress.completed.includes(lesson.id) ? 'tvg-done' : 'tvg-primary'}`} disabled={progress.completed.includes(lesson.id)} onClick={markDone}><CheckCircle2 size={17} />{progress.completed.includes(lesson.id) ? 'Урок переглянуто' : 'Позначити переглянутим'}</button><a className="tvg-button" href={teacherGuideManualUrl(lesson.manualId)} target="_blank" rel="noopener noreferrer"><BookOpen size={16} />Покроково текстом<ChevronRight size={16} /></a></div>
        <div className="tvg-lesson-details"><h4>Повторіть у своєму кабінеті</h4><ol>{lesson.steps.map(step => <li key={step}>{step}</li>)}</ol><div className="tvg-fresh-note"><Sparkles size={19} /><div><strong>Актуально зараз</strong><p>{lesson.update}</p></div></div></div>
        <div className="tvg-pager"><button type="button" className="tvg-button" disabled={index === 0} onClick={() => open(TEACHER_VIDEO_GUIDES[index - 1].id)}><ArrowLeft size={16} />Попередній</button><button type="button" className="tvg-button" disabled={index === TEACHER_VIDEO_GUIDES.length - 1} onClick={() => open(TEACHER_VIDEO_GUIDES[index + 1].id)}>Наступний урок<ArrowRight size={16} /></button></div>
      </div>
      <nav className="tvg-syllabus" aria-label="Уроки курсу"><h3>Зміст курсу</h3>{TEACHER_VIDEO_GUIDES.map((guide, i) => <button type="button" key={guide.id} aria-current={selected === guide.id ? 'step' : undefined} onClick={() => open(guide.id)}><span className={`tvg-number ${progress.completed.includes(guide.id) ? 'tvg-complete-number' : ''}`}>{progress.completed.includes(guide.id) ? <Check size={16} /> : String(i + 1).padStart(2, '0')}</span><span><b>{guide.title}</b><small>{teacherGuideDuration(guide.durationSeconds)}{progress.completed.includes(guide.id) ? ' · Переглянуто' : ''}</small></span><ChevronRight size={15} /></button>)}</nav>
    </section> : <section aria-label="Каталог відеоуроків"><div className="tvg-section-title"><div><span className="tvg-kicker">Навчання без поспіху</span><h3 ref={catalogueHeading} tabIndex={-1}>Оберіть свій наступний крок</h3></div><span>6 уроків у зручному порядку</span></div><div className="tvg-catalog">{TEACHER_VIDEO_GUIDES.map((guide, i) => <button type="button" key={guide.id} className="tvg-module" onClick={() => open(guide.id)}><span className="tvg-thumbnail"><img src={guide.posterUrl} alt="" loading="lazy" /><span className="tvg-play-badge"><Play size={20} fill="currentColor" /></span><small>{teacherGuideDuration(guide.durationSeconds)}</small></span><span className="tvg-module-copy"><span className="tvg-module-top"><span>Урок {String(i + 1).padStart(2, '0')}</span>{progress.completed.includes(guide.id) && <span className="tvg-viewed"><CheckCircle2 size={14} />Переглянуто</span>}</span><strong>{guide.title}</strong><span className="tvg-module-description">{guide.description}</span><span className="tvg-module-link">Перейти до уроку<ArrowRight size={16} /></span></span></button>)}</div></section>}

    <section className="tvg-updates" aria-labelledby="teacher-guide-updates"><div className="tvg-section-title"><div><span className="tvg-kicker"><Sparkles size={15} />Кабінет розвивається</span><h3 id="teacher-guide-updates">Що ще вже працює</h3></div><span>Оновлено 4 листопада 2026</span></div><p className="tvg-updates-intro">У записах можуть бути попередні назви кнопок. Тут зібрані актуальні можливості та інструкції, зокрема функції, додані після запису відео.</p><div className="tvg-feature-grid">{TEACHER_GUIDE_UPDATES.map(feature => <a href={teacherGuideManualUrl(feature.manualId)} key={feature.title} target="_blank" rel="noopener noreferrer"><span>{feature.tag}</span><h4>{feature.title}<ArrowRight size={16} /></h4><p>{feature.text}</p><b>Відкрити інструкцію</b></a>)}</div><a className="tvg-manual" href="/guides/#teacher/__first-setup" target="_blank" rel="noopener noreferrer"><BookOpen size={21} /><span><strong>Повний текстовий посібник</strong><small>Оберіть окрему тему, знайдіть потрібну дію або поверніться до інструкції пізніше.</small></span><ArrowRight size={19} /></a></section>
  </div>
}

function GraduationMark() { return <><span className="tvg-orbit-one" /><span className="tvg-orbit-two" /><Play size={28} fill="currentColor" /></> }
