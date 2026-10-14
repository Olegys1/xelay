import { useState } from 'react'
import hippoStatusImage from '../assets/status/hippo-20261014.webp'
import cheburashkaStatusImage from '../assets/status/cheburashka-20261014.png'
import cheburashkaHeartImage from '../assets/status/cheburashka-heart-20261014.png'
import { PARTICIPANT_CHEBURASHKA_STATUS, participantStatusEmojiLabel } from '../lib/participantStatus'
import './ParticipantStatusEmoji.css'

export function ParticipantStatusEmoji({ emoji, picker = false, decorative = false }: {
  emoji: string
  picker?: boolean
  decorative?: boolean
}) {
  if (emoji !== '🦛' && emoji !== PARTICIPANT_CHEBURASHKA_STATUS) return <span aria-hidden={decorative || undefined}>{emoji}</span>
  // A different sticker remounts its image state, including cached-image loads.
  return <ParticipantStatusSticker key={emoji} emoji={emoji} picker={picker} decorative={decorative} />
}

function ParticipantStatusSticker({ emoji, picker, decorative }: {
  emoji: string
  picker: boolean
  decorative: boolean
}) {
  const [imageUnavailable, setImageUnavailable] = useState(false)
  const [firstFrameReady, setFirstFrameReady] = useState(false)
  const [heartFrameReady, setHeartFrameReady] = useState(false)
  const isCheburashka = emoji === PARTICIPANT_CHEBURASHKA_STATUS
  const label = participantStatusEmojiLabel(emoji)
  const animated = isCheburashka && firstFrameReady && heartFrameReady && !imageUnavailable

  return <span className={`participant-status-sticker inline-flex shrink-0 items-center justify-center align-middle ${picker ? 'h-8 w-8' : 'h-6 w-6'} ${animated ? 'participant-status-sticker--animated' : ''}`} role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
    {imageUnavailable
      ? <span aria-hidden="true">{isCheburashka ? '🧸' : '🦛'}</span>
      : <>
        <img src={isCheburashka ? cheburashkaStatusImage : hippoStatusImage} width={picker ? 32 : 24} height={picker ? 32 : 24} alt="" aria-hidden="true" draggable={false} className="participant-status-sticker__base h-full w-full select-none object-contain" onLoad={() => setFirstFrameReady(true)} onError={() => setImageUnavailable(true)} />
        {isCheburashka && <img src={cheburashkaHeartImage} width={picker ? 32 : 24} height={picker ? 32 : 24} alt="" aria-hidden="true" draggable={false} className="participant-status-sticker__heart h-full w-full select-none object-contain" onLoad={() => setHeartFrameReady(true)} onError={() => setHeartFrameReady(false)} />}
      </>}
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
