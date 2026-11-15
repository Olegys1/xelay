import type { Theme } from '../../context/ThemeContext'
import { homeDateLabel, homeKyivClock } from '../../lib/homeDashboardModel'
import { HomeIcon } from './HomeIcons'
import './HomeDashboard.css'
import { PublicEcosystemIntro } from '../PublicEcosystemIntro'
import { HomeUsefulTools } from '../partners/HomeUsefulTools'

export function GuestHomeDashboard({ theme, onAuthRequest }: { theme: Theme; onAuthRequest: () => void }) {
  const { date } = homeKyivClock(new Date().toISOString())
  const dateLabel = homeDateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })

  return <div className="hd-dashboard hd-live" data-theme={theme}>
    <main className="hd-home">
      <section className="hd-welcome" aria-labelledby="hd-page-title">
        <div>
          <p className="hd-brand-line">Навчайся. Ділися. Знайомся.</p>
          <h1 id="hd-page-title">Ваш навчальний день<span>Усе потрібне поруч.</span></h1>
          <p className="hd-welcome-copy">Xelay — навчальна екосистема для студентів, старост і викладачів. Розклад, завдання та новини ваших груп на головній.</p>
        </div>
        <div className="hd-welcome-side">
          <div className="hd-today-date">
            <HomeIcon name="calendar" size={19} />
            <span>{dateLabel}</span>
            <small>Київ</small>
          </div>
        </div>
      </section>

      <div className="hd-day-grid">
        <section className="hd-schedule" aria-labelledby="hd-schedule-heading">
          <div className="hd-section-heading">
            <h2 id="hd-schedule-heading">Мій розклад</h2>
            <HomeIcon name="calendar" />
          </div>
          <article className="hd-focus-card hd-guest-focus">
            <div className="hd-focus-subject">
              <h3>Пари та матеріали ваших груп</h3>
              <p>Увійдіть, щоб побачити розклад, посилання на заняття та матеріали.</p>
            </div>
            <div className="hd-focus-bottom">
              <button type="button" className="hd-button hd-button-primary" onClick={onAuthRequest}>
                Увійти до Xelay <HomeIcon name="arrow" size={17} />
              </button>
            </div>
          </article>
        </section>

        <aside className="hd-attention" aria-labelledby="hd-attention-heading">
          <div className="hd-section-heading">
            <h2 id="hd-attention-heading">Потрібно зробити</h2>
            <HomeIcon name="spark" />
          </div>
          <div className="hd-attention-card">
            <div className="hd-all-clear">
              <span><HomeIcon name="file" size={24} /></span>
              <h3>Завдання та терміни</h3>
              <p>Після входу тут з’являться ваші домашні завдання та найближчі дедлайни.</p>
            </div>
          </div>
        </aside>
      </div>

      <section className="hd-updates" aria-labelledby="hd-updates-heading">
        <div className="hd-section-heading">
          <h2 id="hd-updates-heading">Нове у ваших групах</h2>
        </div>
        <div className="hd-updates-empty">
          <HomeIcon name="bell" />
          <p>Увійдіть, щоб побачити нові матеріали, оцінки та зміни в розкладі.</p>
        </div>
      </section>

      <section className="hd-discover-grid" aria-label="Можливості та новини">
        <article className="hd-opportunities">
          <div className="hd-opportunity-copy">
            <span className="hd-coming-label"><span />Готуємо для вас</span>
            <h2>Можливості, з яких починається більше.</h2>
            <p>Стажування, перша робота, освітні програми та події для студентів.</p>
            <a href="/opportunities" className="hd-button hd-button-ink">
              Про майбутній розділ <HomeIcon name="arrow" size={16} />
            </a>
          </div>
          <div className="hd-opportunity-art" aria-hidden="true">
            <span className="hd-art-stamp"><HomeIcon name="briefcase" size={35} /></span>
            <span className="hd-art-note hd-art-note-one">Перша робота</span>
            <span className="hd-art-note hd-art-note-two">Новий досвід</span>
          </div>
        </article>
        <article className="hd-news">
          <div className="hd-section-heading"><h2>Варто знати</h2><HomeIcon name="bell" /></div>
          <div className="hd-news-item">
            <h3>Новини факультету й університету</h3>
            <p>Увійдіть, щоб переглянути новини вашого факультету.</p>
          </div>
        </article>
      </section>

      <section className="hd-community" aria-labelledby="hd-community-heading">
        <div className="hd-section-heading">
          <div>
            <h2 id="hd-community-heading">Спільнота поруч</h2>
            <p>Запитуйте, діліться досвідом, допомагайте одне одному.</p>
          </div>
          <a href="/community" className="hd-button hd-button-outline">
            <HomeIcon name="chat" size={17} /> Спільнота
          </a>
        </div>
      </section>
      <PublicEcosystemIntro />
      <HomeUsefulTools />
      <footer className="hd-page-footer">
        <span><b>Xelay</b> Навчайся. Ділися. Знайомся.</span>
        <span><a href="/guides/">Посібники</a></span>
      </footer>
    </main>
  </div>
}
