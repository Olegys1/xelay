import { legalMerchant } from '../lib/legal'
import { LegalLinks } from './LegalLinks'
import { XelayLogo } from './XelayLogo'

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-background py-8">
      <div className="mx-auto grid max-w-6xl gap-6 px-5 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="space-y-3">
          <a href="/" aria-label="Xelay — на головну" className="inline-flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <XelayLogo className="h-10 w-[100px]" />
          </a>
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Xelay · Університетська спільнота</p>
          {legalMerchant.name && <p className="text-xs leading-relaxed text-muted-foreground">Продавець послуг: {legalMerchant.name}</p>}
        </div>
        <LegalLinks />
      </div>
    </footer>
  )
}
