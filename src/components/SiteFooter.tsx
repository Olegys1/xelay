import { legalMerchant } from '../lib/legal'
import { LegalLinks } from './LegalLinks'
import { XelayLogo } from './XelayLogo'

export function SiteFooter() {
  const sameAddress = legalMerchant.registrationAddress === legalMerchant.actualAddress
  const contactLink = 'rounded-sm text-sm leading-6 text-white/90 underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#181418]'
  return (
    <footer className="relative isolate mt-auto overflow-hidden border-t border-border bg-[#181418] text-white">
      <picture aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-20 h-[290px] sm:inset-0 sm:h-full lg:hidden">
        <source type="image/webp" srcSet="/images/knu-footer-480.webp 480w, /images/knu-footer-768.webp 768w, /images/knu-footer-1280.webp 1280w" sizes="100vw" />
        <img src="/images/knu-footer.jpg" alt="" width={1280} height={1051} loading="lazy" decoding="async" className="h-full w-full object-cover object-[50%_40%] sm:object-[50%_45%]" />
      </picture>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(24,20,24,0.12)_0%,rgba(24,20,24,0.35)_120px,#181418_290px)] sm:bg-[linear-gradient(180deg,rgba(24,20,24,0.18),rgba(24,20,24,0.62)_60%,rgba(24,20,24,0.88))]" />
      <div className="mx-auto max-w-6xl px-4 pb-6 pt-7 sm:px-6 sm:pb-7 sm:pt-9">
        <div className="mb-6 flex min-h-[132px] flex-col items-start justify-end gap-3 sm:min-h-[104px] sm:flex-row sm:items-end sm:justify-between">
          <a href="/" aria-label="Xelay — на головну" className="inline-flex shrink-0 items-center rounded-2xl border border-border bg-background px-4 py-3 shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#181418]">
            <XelayLogo className="h-14 w-[136px]" />
          </a>
          <p className="max-w-xs rounded-xl bg-[#181418]/85 px-3.5 py-2.5 text-sm leading-6 text-white">Спілкування, взаємодопомога та навчання в університетській спільноті.</p>
        </div>
        <div className="grid gap-7 rounded-2xl border border-white/15 bg-[#181418]/95 p-5 shadow-xl sm:p-6 md:grid-cols-2 lg:grid-cols-[0.9fr_1fr_1.45fr]">
          <section className="min-w-0 space-y-4" aria-labelledby="footer-rules">
            <h2 id="footer-rules" className="text-xs font-semibold uppercase tracking-widest text-white/65">Правила та оплата</h2>
            <LegalLinks inverse stacked />
            <p className="text-xs leading-5 text-white/70">Оплата карткою через WayForPay. Послуги надаються онлайн.</p>
          </section>
          <section className="min-w-0 space-y-4" aria-labelledby="footer-support">
            <h2 id="footer-support" className="text-xs font-semibold uppercase tracking-widest text-white/65">Зв’язок та підтримка</h2>
            <address className="space-y-2 not-italic">
              {legalMerchant.email && <p className="[overflow-wrap:anywhere]"><a href={`mailto:${legalMerchant.email}`} className={contactLink}>{legalMerchant.email}</a></p>}
              {legalMerchant.phone && <p><a href={`tel:${legalMerchant.phone.replace(/[^+\d]/g, '')}`} className={contactLink}>{legalMerchant.phone}</a></p>}
            </address>
            <p className="text-xs leading-5 text-white/70">Питання щодо оплати, доступу до платформи та повернення коштів.</p>
          </section>
          <section className="min-w-0 space-y-4 md:col-span-2 lg:col-span-1" aria-labelledby="footer-merchant">
            <h2 id="footer-merchant" className="text-xs font-semibold uppercase tracking-widest text-white/65">Продавець послуг</h2>
            <div className="space-y-2 text-xs leading-5 text-white/80 [overflow-wrap:anywhere]">
              {legalMerchant.name && <p className="text-sm font-medium leading-6 text-white">{legalMerchant.name}</p>}
              {legalMerchant.taxId && <p>РНОКПП (ІПН): {legalMerchant.taxId}</p>}
              {legalMerchant.registrationAddress && <p><span className="text-white/65">{sameAddress ? 'Юридична та фактична адреса: ' : 'Юридична адреса: '}</span>{legalMerchant.registrationAddress}</p>}
              {!sameAddress && legalMerchant.actualAddress && <p><span className="text-white/65">Фактична адреса: </span>{legalMerchant.actualAddress}</p>}
            </div>
          </section>
        </div>
        <p className="mt-5 text-xs leading-5 text-white/65">© {new Date().getFullYear()} Xelay · Університетська спільнота</p>
      </div>
    </footer>
  )
}
