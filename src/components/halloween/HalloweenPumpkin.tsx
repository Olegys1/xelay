import { useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { useHalloweenHunt } from '../../context/HalloweenHuntContext'
import { useOnboarding } from '../../context/OnboardingContext'
import pumpkin from '../../assets/halloween/pumpkin-witch-20261017.webp'
import './halloween.css'

export function PumpkinArt({ className = '', size = 64 }: { className?: string; size?: number }) {
  return <img src={pumpkin} width={size} height={size} alt="" aria-hidden="true" draggable={false} className={`halloween-pumpkin-art ${className}`} />
}

export function HalloweenPumpkin({ pumpkinId, className = '', perch = 'right' }: { pumpkinId: string; className?: string; perch?: 'left' | 'right' | 'center' }) {
  const hunt = useHalloweenHunt()
  const { suspended } = useOnboarding()
  const shown = useRef(false)
  const found = hunt.state?.collected.includes(pumpkinId as never)
  if (found) return shown.current ? <div aria-hidden="true" className={`halloween-perch halloween-perch--collected ${className}`} /> : null
  if (!hunt.available || !hunt.userId || !hunt.state || hunt.state.phase !== 'active' || !hunt.state.eligible || suspended || hunt.state.completed) return null
  shown.current = true
  const busy = hunt.collecting === pumpkinId
  return <div className={`halloween-perch halloween-perch--${perch} ${className}`}>
    <button type="button" disabled={Boolean(hunt.collecting)} onClick={() => { void hunt.collect(pumpkinId) }} aria-label="Знайшли гарбузик! Зібрати" title="Псс… здається, ви когось знайшли" className="halloween-pumpkin-pickup" data-pumpkin-id={pumpkinId}>
      <span className="halloween-pumpkin-shadow" aria-hidden="true" />
      <PumpkinArt size={64} />
      <span className="halloween-pumpkin-spark" aria-hidden="true">✧</span>
      {busy && <span className="halloween-pumpkin-saving"><Loader2 size={20} className="animate-spin motion-reduce:animate-none" /></span>}
    </button>
  </div>
}
