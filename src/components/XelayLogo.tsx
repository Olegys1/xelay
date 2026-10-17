import { useId } from 'react'

interface XelayLogoProps {
  className?: string
}

export function XelayLogo({ className = '' }: XelayLogoProps) {
  const maskId = `xelay-logo-${useId().replace(/:/g, '')}`
  const seasonalGradientId = `${maskId}-autumn`

  return (
    <svg
      viewBox="64 122 1655 680"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 select-none ${className}`}
    >
      <defs>
        <linearGradient id={seasonalGradientId} x1="70" y1="160" x2="1670" y2="590" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFF0CF" />
          <stop offset="0.48" stopColor="#FFCD89" />
          <stop offset="1" stopColor="#F6AA5D" />
        </linearGradient>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="1774"
          height="887"
          style={{ maskType: 'alpha' }}
        >
          <image href="/images/xelay-header-logo.png" width="1774" height="887" />
        </mask>
      </defs>
      <image
        href="/images/xelay-header-logo.png"
        width="1774"
        height="887"
        className="xelay-logo-standard-light dark:hidden"
      />
      <g mask={`url(#${maskId})`} className="xelay-logo-standard-dark hidden dark:block">
        <rect width="1774" height="887" fill="hsl(var(--foreground))" />
        <rect x="700" y="700" width="400" height="187" fill="hsl(var(--primary-text))" />
      </g>
      <g className="xelay-logo-seasonal">
        <g mask={`url(#${maskId})`}>
          <rect width="1774" height="887" fill={`url(#${seasonalGradientId})`} />
          <rect x="700" y="700" width="400" height="187" fill="#C6A9E5" />
        </g>
        <path d="m1585 164 10-30 10 30 30 10-30 10-10 30-10-30-30-10 30-10Z" fill="#F6AA5D" />
        <circle cx="1526" cy="139" r="9" fill="#C6A9E5" />
      </g>
    </svg>
  )
}
