import { ArrowUpRight, Gift } from 'lucide-react'
import './birthdayProfile.css'

export interface BirthdayGiftReminderProps { recipientName?: string; busy?: boolean; onOpen: () => void }

export function BirthdayGiftReminder({ recipientName, busy = false, onOpen }: BirthdayGiftReminderProps) {
  return <aside className="bp-gift-reminder"><span className="bp-reminder-art" aria-hidden="true"><Gift size={26} strokeWidth={1.35} /><i>✦</i></span><div><p>Сьогодні твій день</p><h3>{recipientName ? `${recipientName}, з днем народження!` : 'З днем народження!'}</h3><span>У нас є дещо приємне для тебе.</span></div><button type="button" className="bp-reminder-open" disabled={busy} onClick={onOpen}>Мій подарунок<ArrowUpRight size={15} aria-hidden="true" /></button></aside>
}
