import { Check, Sparkles } from 'lucide-react'
import { formatSupportAmount } from '../lib/teamSupport'
import { nextSupporterTier, previewSupporterTier, SIX_SEVEN_KOPIYKAS, SUPPORTER_TIERS, type ActiveSupporterTier, type SupporterSummary, type SupporterTier } from '../lib/supporterTiers'
import { SixSevenMark, SupporterMark } from './SupporterBadge'

export function SupporterSecretHint({ unlocked, onSelectAmount, disabled }: { unlocked: boolean; onSelectAmount: () => void; disabled: boolean }) {
  return <aside aria-label="Секретний бейдж підтримки" className="-mt-2 mb-7 text-xs text-muted-foreground sm:mb-9">
    <details className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3">
      <summary className="cursor-pointer leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {unlocked ? 'Секрет знайдено: Six Seven ✨' : 'Псс… у Xelay є секретний бейдж ✨'}
      </summary>
      <div className="mt-3 space-y-3 leading-6">
        <SixSevenMark compact={false} />
        <p>Один внесок рівно 67 грн відкриває «67 · Six Seven» поруч з ім’ям — додатково до вашого рівня підтримки. Кілька менших внесків не відкривають цей бейдж.</p>
        <p>Він з’явиться після підтвердження реальної оплати. Публічний бейдж означає, що був внесок 67 грн; загальна сума й історія залишаються приватними. Якщо повернути всі внески по 67 грн, бейдж зникне.</p>
        {!unlocked && <button type="button" disabled={disabled} onClick={onSelectAmount} className="rounded-lg border border-border bg-background px-3 py-2 font-medium text-foreground hover:border-primary/40 disabled:opacity-50">Обрати 67 грн</button>}
      </div>
    </details>
  </aside>
}

export function SupporterLevels({ currentTier, previewTier }: { currentTier?: SupporterTier; previewTier?: SupporterTier }) {
  return <section aria-labelledby="supporter-levels-heading" className="my-7 sm:my-9">
    <h2 id="supporter-levels-heading" className="text-base font-semibold">П’ять рівнів подяки</h2>
    <p className="mt-1 text-sm leading-6 text-muted-foreground">Усі підтверджені внески додаються. Два внески по 50 грн — це бронзовий рівень від 100 грн.</p>
    <ol className="mt-4 grid min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
      {SUPPORTER_TIERS.map((item) => {
        const current = currentTier === item.tier
        const preview = previewTier === item.tier
        return <li key={item.tier} className={`flex min-w-0 items-center justify-between gap-3 rounded-2xl border p-3 sm:block sm:p-4 ${preview ? 'border-primary/50 bg-primary/[.035] ring-1 ring-primary/10' : 'border-border bg-card'}`}>
          <div><SupporterMark tier={item.tier} /><p className="mt-2 text-sm font-semibold">{item.tier === 1 ? 'Від 1 грн' : `Від ${formatSupportAmount(item.minimumKopiykas)} грн`}</p></div>
          <div className="min-h-5 text-right text-[11px] font-medium sm:mt-2 sm:text-left">
            {current ? <span className="inline-flex items-center gap-1 text-primary"><Check size={12} aria-hidden="true" />Ваш рівень</span>
              : preview ? <span className="inline-flex items-center gap-1 text-primary"><Sparkles size={12} aria-hidden="true" />За вибраною сумою</span>
                : <span className="text-muted-foreground">{item.name} рівень</span>}
          </div>
        </li>
      })}
    </ol>
  </section>
}

export function SupporterProgress({ summary }: { summary: SupporterSummary }) {
  const next = nextSupporterTier(summary.totalKopiykas)
  return <section aria-label="Ваш рівень підтримки" className="mt-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
    <p className="text-xs font-medium text-muted-foreground">Ваша підтверджена підтримка</p>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><strong className="text-xl font-semibold">{formatSupportAmount(summary.totalKopiykas)} грн</strong>
      <div className="flex flex-wrap items-center gap-1.5">{summary.tier > 0 && <SupporterMark tier={summary.tier as ActiveSupporterTier} />}{summary.sixSeven && <SixSevenMark />}</div></div>
    {next ? <>
      <div role="progressbar" aria-label="Прогрес до наступного рівня" aria-valuemin={0} aria-valuemax={next.minimumKopiykas} aria-valuenow={summary.totalKopiykas}
        aria-valuetext={`${formatSupportAmount(summary.totalKopiykas)} із ${formatSupportAmount(next.minimumKopiykas)} грн`} className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${Math.min(100, summary.totalKopiykas / next.minimumKopiykas * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">До {next.tier === 1 ? 'першого бейджа' : `рівня «${next.name}»`} — {formatSupportAmount(next.remainingKopiykas)} грн.</p>
    </> : <p className="mt-3 text-xs leading-5 text-muted-foreground">У вас найвищий рівень. Дякуємо, що допомагаєте розвивати Xelay!</p>}
    <p className="mt-3 text-[11px] leading-5 text-muted-foreground">Враховані лише підтверджені робочі платежі за весь час. Повернені й скасовані внески не враховуються.</p>
  </section>
}

export function SupporterContributionPreview({ amountKopiykas, summary, authenticated, testMode }: {
  amountKopiykas: number | null; summary?: SupporterSummary | null; authenticated: boolean; testMode: boolean
}) {
  const tier = amountKopiykas === null ? 0 : previewSupporterTier(summary?.totalKopiykas || 0, amountKopiykas)
  if (tier === 0) return null
  return <div aria-live="polite" className="mt-4 rounded-2xl border border-border bg-background/70 p-4">
    <p className="text-xs font-medium text-muted-foreground">{testMode ? 'Приклад бейджа' : authenticated && !summary ? 'Щонайменше за цей внесок' : 'Бейдж після підтримки'}</p>
    <div className="mt-2 flex flex-wrap items-center gap-1.5"><SupporterMark tier={tier as ActiveSupporterTier} />{(summary?.sixSeven || amountKopiykas === SIX_SEVEN_KOPIYKAS) && <SixSevenMark compact={false} />}</div>
    {amountKopiykas === SIX_SEVEN_KOPIYKAS && !summary?.sixSeven && <p className="mt-2 text-xs font-medium text-foreground">{testMode ? 'Приклад секретного бейджа «67 · Six Seven».' : 'Секрет знайдено! Цей внесок також відкриє «67 · Six Seven».'}</p>}
    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{testMode ? 'Тестова оплата не змінює робочий бейдж.'
      : 'Попередній перегляд. Бейдж буде отримано після підтвердження оплати. Показ біля імені можна змінити в налаштуваннях профілю.'}</p>
  </div>
}
