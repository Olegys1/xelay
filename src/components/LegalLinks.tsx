import { useId } from 'react'
import type { LegalPageKind } from '../lib/legal'

const links: { href: string; kind: LegalPageKind; label: string }[] = [
  { href: '/terms', kind: 'terms', label: 'Правила та умови' },
  { href: '/refund-policy', kind: 'refund-policy', label: 'Повернення коштів' },
  { href: '/contacts', kind: 'contacts', label: 'Контакти та реквізити' },
]

interface LegalLinksProps {
  variant?: 'footer' | 'checkout' | 'page'
  activeKind?: LegalPageKind
  className?: string
  inverse?: boolean
  stacked?: boolean
}

export function LegalLinks({ variant = 'footer', activeKind, className = '', inverse = false, stacked = false }: LegalLinksProps) {
  const checkout = variant === 'checkout'

  return (
    <div className={`${checkout ? 'space-y-2 text-xs leading-relaxed' : ''} ${className}`}>
      {checkout && <p className="text-muted-foreground">Перед оплатою ознайомтеся з правилами надання послуг, повернення коштів і реквізитами продавця.</p>}
      <nav
        aria-label={checkout ? 'Умови оплати' : 'Правила платформи та контакти'}
        className={`flex ${stacked ? 'flex-col items-start' : 'flex-wrap'} ${checkout ? 'gap-x-4 gap-y-2' : 'gap-x-5 gap-y-3 text-sm'}`}
      >
        {links.map((link) => (
          <a
            key={link.kind}
            href={link.href}
            aria-current={activeKind === link.kind ? 'page' : undefined}
            target={checkout ? '_blank' : undefined}
            rel={checkout ? 'noopener noreferrer' : undefined}
            className={`rounded-sm underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${inverse ? 'text-white/85 hover:text-white focus-visible:ring-white focus-visible:ring-offset-[#181418]' : `hover:text-foreground focus-visible:ring-primary focus-visible:ring-offset-background ${activeKind === link.kind ? 'text-foreground' : 'text-muted-foreground'}`} ${activeKind === link.kind ? 'font-semibold underline' : ''} ${checkout ? 'underline' : ''}`}
          >
            {variant === 'footer' && link.kind === 'terms' ? 'Публічна оферта та умови' : link.label}
            {checkout && <span className="sr-only"> (відкриється в новій вкладці)</span>}
          </a>
        ))}
      </nav>
    </div>
  )
}

interface CheckoutLegalConsentProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

export function CheckoutLegalConsent({ checked, onChange, disabled = false }: CheckoutLegalConsentProps) {
  const id = useId()
  const linkClass = 'rounded-sm text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

  return (
    <div className={`space-y-3 text-xs leading-relaxed text-muted-foreground ${disabled ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
        />
        <label htmlFor={id} className={disabled ? 'cursor-default' : 'cursor-pointer'}>
          Я ознайомився/ознайомилася з{' '}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className={linkClass}>умовами надання послуг<span className="sr-only"> (відкриється в новій вкладці)</span></a>
          {' '}і{' '}
          <a href="/refund-policy" target="_blank" rel="noopener noreferrer" className={linkClass}>правилами повернення коштів<span className="sr-only"> (відкриється в новій вкладці)</span></a>
          {' '}та погоджуюся з ними.
        </label>
      </div>
      <p className="pl-7"><a href="/contacts" target="_blank" rel="noopener noreferrer" className={linkClass}>Контакти та реквізити продавця<span className="sr-only"> (відкриється в новій вкладці)</span></a></p>
    </div>
  )
}
