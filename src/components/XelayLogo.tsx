import { useId } from 'react'

interface XelayLogoProps {
  className?: string
}

export function XelayLogo({ className = '' }: XelayLogoProps) {
  const maskId = `xelay-logo-${useId().replace(/:/g, '')}`

  return (
    <svg
      viewBox="64 122 1655 680"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 select-none ${className}`}
    >
      <defs>
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
        className="dark:hidden"
      />
      <g mask={`url(#${maskId})`} className="hidden dark:block">
        <rect width="1774" height="887" fill="hsl(var(--foreground))" />
        <rect x="700" y="700" width="400" height="187" fill="hsl(var(--primary-text))" />
      </g>
    </svg>
  )
}
