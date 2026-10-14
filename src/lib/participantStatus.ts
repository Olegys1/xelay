// Keep this picker list aligned with the participant status RPC allowlist.
export const PARTICIPANT_STATUS_MAX_LENGTH = 48
export const PARTICIPANT_STATUS_MAX_EMOJIS = 3
export const PARTICIPANT_CHEBURASHKA_STATUS = 'sticker:cheburashka'

export const PARTICIPANT_STATUS_EMOJI_GROUPS: readonly { name: string; emojis: readonly string[] }[] = [
  { name: 'Настрій', emojis: ['😊', '😄', '😎', '🥰', '😍', '🤩', '🥹', '😌', '🤔', '😴', '😅', '😂', '🥳', '🙃', '😇', '🤗', '🫠', '🤓', '💤', '❤️'] },
  { name: 'Навчання', emojis: ['🎓', '📚', '📖', '📝', '✏️', '📌', '📎', '🗓️', '⏰', '💻', '🧠', '💡', '🎯', '🧪', '🔬', '📐', '🧮', '🏛️', '💼', '🏆'] },
  { name: 'Захоплення', emojis: ['🎨', '🎭', '🎬', '🎵', '🎧', '🎤', '🎸', '📷', '🎮', '🎲', '⚽', '🏀', '🏐', '🎾', '🏋️', '🚴', '🏃', '🧘', '🏊', '📸'] },
  { name: 'Природа і подорожі', emojis: ['🦛', '🌱', '🌿', '🌻', '🌸', '🍀', '🌳', '🌍', '🌊', '⛰️', '🏕️', '✈️', '🚀', '🚂', '🚗', '🌙', '☀️', '🌈', '⭐', '✨', '❄️'] },
  { name: 'Щодня', emojis: ['☕', '🍵', '🍕', '🍫', '🍒', '🍉', '🥐', '🔥', '⚡', '💪', '🙌', '👏', '🤝', '🫶', '💜', '💙', '💛', '🤍', '🖤', '💬'] },
  { name: 'Стікери', emojis: [PARTICIPANT_CHEBURASHKA_STATUS] },
]

export const PARTICIPANT_STATUS_EMOJIS = PARTICIPANT_STATUS_EMOJI_GROUPS.flatMap((group) => group.emojis)

export function participantStatusEmojiLabel(emoji: string) {
  return emoji === '🦛' ? 'Бегемотик'
    : emoji === PARTICIPANT_CHEBURASHKA_STATUS ? 'Чебурашка з сердечком' : emoji
}

