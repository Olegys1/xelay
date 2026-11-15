import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { FacultyParliament } from '../lib/facultyParliament'

export function FacultyParliamentLink({ entry, className, onClick, children }: {
  entry: Exclude<FacultyParliament, { kind: 'spef' }>
  className: string
  onClick?: () => void
  children: ReactNode
}) {
  if (entry.kind === 'external') {
    return <a href={entry.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
      {children}<span className="sr-only"> — відкриється в новій вкладці</span>
    </a>
  }
  return <Link to="/news" className={className} onClick={onClick}>{children}</Link>
}
