import { useEffect } from 'react'
import { ArrowLeft, FileText, Mail, Phone, RotateCcw } from 'lucide-react'
import { LegalLinks } from '../components/LegalLinks'
import { getLegalPage, legalMerchant, type LegalPageKind } from '../lib/legal'

interface LegalPageProps {
  kind: LegalPageKind
}

export function LegalPage({ kind }: LegalPageProps) {
  const page = getLegalPage(kind)
  const Icon = kind === 'refund-policy' ? RotateCcw : kind === 'contacts' ? Mail : FileText

  useEffect(() => {
    const previousTitle = document.title
    document.title = `${page.title} · Xelay`
    return () => { document.title = previousTitle }
  }, [page.title])

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <a href="/" className="mb-7 inline-flex items-center gap-2 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
        <ArrowLeft size={16} aria-hidden="true" /> На головну
      </a>

      <header className="mb-8 space-y-5">
        <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/50 text-primary">
          <Icon size={22} aria-hidden="true" />
        </div>
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{page.title}</h1>
          {page.description && <p className="max-w-3xl text-base leading-relaxed text-muted-foreground">{page.description}</p>}
          {page.updatedAt && <p className="text-xs text-muted-foreground">Оновлено: {page.updatedAt}</p>}
        </div>
        <LegalLinks variant="page" activeKind={kind} />
      </header>

      {legalMerchant.ready === false && (
        <p className="mb-6 rounded-xl border border-border bg-muted/50 px-5 py-4 text-sm leading-relaxed text-muted-foreground">
          Відомості продавця уточнюються. Прийом оплат ще недоступний.
        </p>
      )}

      <article aria-label={page.title} className="rounded-2xl border border-border bg-card px-5 py-6 text-card-foreground sm:px-9 sm:py-9">
        <div className="divide-y divide-border">
          {page.sections.map((section, index) => (
            <section key={`${index}-${section.title}`} className="py-6 first:pt-0 last:pb-0">
              <h2 className="mb-4 text-lg font-semibold leading-snug text-foreground sm:text-xl">{section.title}</h2>
              <div className="space-y-3 text-sm leading-7 text-muted-foreground sm:text-base">
                {section.paragraphs?.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex} className="whitespace-pre-line break-words">{paragraph}</p>
                ))}
                {section.items && section.items.length > 0 && (
                  <ul className="list-disc space-y-2 pl-5 marker:text-primary">
                    {section.items.map((item, itemIndex) => <li key={itemIndex} className="break-words pl-1">{item}</li>)}
                  </ul>
                )}
              </div>
            </section>
          ))}

          {kind === 'contacts' && (legalMerchant.email || legalMerchant.phone) && (
            <section className="pt-6">
              <h2 className="mb-4 text-lg font-semibold text-foreground sm:text-xl">Зв’язатися з нами</h2>
              <div className="flex flex-col items-start gap-3 text-sm sm:text-base">
                {legalMerchant.email && (
                  <a href={`mailto:${legalMerchant.email}`} className="inline-flex max-w-full items-start gap-3 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card">
                    <Mail size={19} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="break-all">{legalMerchant.email}</span>
                  </a>
                )}
                {legalMerchant.phone && (
                  <a href={`tel:${legalMerchant.phone.replace(/[^\d+]/g, '')}`} className="inline-flex max-w-full items-start gap-3 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card">
                    <Phone size={19} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="break-words">{legalMerchant.phone}</span>
                  </a>
                )}
              </div>
            </section>
          )}
        </div>
      </article>
    </main>
  )
}
