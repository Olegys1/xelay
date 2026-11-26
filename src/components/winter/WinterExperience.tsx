import { lazy, Suspense } from 'react'
import { useOnboarding } from '../../context/OnboardingContext'
import { useWinterCampaign } from '../../hooks/useWinterCampaign'
import { winterRouteAllowed } from '../../lib/winterCampaign'

const WinterAmbient = lazy(() => import('./WinterAmbient').then(module => ({ default: module.WinterAmbient })))

export function WinterExperience({ pathname, blocked = false }: { pathname: string; blocked?: boolean }) {
  const { suspended } = useOnboarding()
  const { now, decorationsAvailable } = useWinterCampaign()
  if (!decorationsAvailable || suspended || blocked || !winterRouteAllowed(pathname)) return null
  return <Suspense fallback={null}><WinterAmbient now={now} pathname={pathname} /></Suspense>
}
