import { useState } from 'react'
import hippoStatusImage from '../assets/status/hippo-20261014.webp'
import { participantStatusEmojiLabel } from '../lib/participantStatus'

export function ParticipantStatusEmoji({ emoji, picker = false, decorative = false }: {
  emoji: string
  picker?: boolean
  decorative?: boolean
}) {
  const [imageUnavailable, setImageUnavailable] = useState(false)
  if (emoji !== '🦛') return <span aria-hidden={decorative || undefined}>{emoji}</span>

  return <span className={`inline-flex shrink-0 items-center justify-center align-middle ${picker ? 'h-8 w-8' : 'h-6 w-6'}`} aria-hidden={decorative || undefined}>
    {imageUnavailable
      ? <span role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : 'Бегемотик'}>🦛</span>
      : <img src={hippoStatusImage} width={picker ? 32 : 24} height={picker ? 32 : 24} alt={decorative ? '' : 'Бегемотик'} draggable={false} className="h-full w-full select-none object-contain" onError={() => setImageUnavailable(true)} />}
  </span>
}

export function ParticipantStatusEmojis({ status, label = 'Емодзі-статус' }: {
  status: string
  label?: string
}) {
  const emojis = status.split(' ').filter(Boolean)
  if (!emojis.length) return null
  return <span role="img" title={label} aria-label={`${label}: ${emojis.map(participantStatusEmojiLabel).join(', ')}`} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-base leading-none">
    {emojis.map((emoji, index) => <ParticipantStatusEmoji key={`${emoji}-${index}`} emoji={emoji} decorative />)}
  </span>
}
