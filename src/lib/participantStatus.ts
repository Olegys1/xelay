// Keep this picker list aligned with 202610020003_participant_statuses.sql.
export const PARTICIPANT_STATUS_MAX_LENGTH = 48
export const PARTICIPANT_STATUS_MAX_EMOJIS = 3

export const PARTICIPANT_STATUS_EMOJI_GROUPS: readonly { name: string; emojis: readonly string[] }[] = [
  { name: 'Настрій', emojis: ['😊', '😄', '😎', '🥰', '😍', '🤩', '🥹', '😌', '🤔', '😴', '😅', '😂', '🥳', '🙃', '😇', '🤗', '🫠', '🤓', '💤', '❤️'] },
  { name: 'Навчання', emojis: ['🎓', '📚', '📖', '📝', '✏️', '📌', '📎', '🗓️', '⏰', '💻', '🧠', '💡', '🎯', '🧪', '🔬', '📐', '🧮', '🏛️', '💼', '🏆'] },
  { name: 'Захоплення', emojis: ['🎨', '🎭', '🎬', '🎵', '🎧', '🎤', '🎸', '📷', '🎮', '🎲', '⚽', '🏀', '🏐', '🎾', '🏋️', '🚴', '🏃', '🧘', '🏊', '📸'] },
  { name: 'Природа і подорожі', emojis: ['🌱', '🌿', '🌻', '🌸', '🍀', '🌳', '🌍', '🌊', '⛰️', '🏕️', '✈️', '🚀', '🚂', '🚗', '🌙', '☀️', '🌈', '⭐', '✨', '❄️'] },
  { name: 'Щодня', emojis: ['☕', '🍵', '🍕', '🍫', '🍒', '🍉', '🥐', '🔥', '⚡', '💪', '🙌', '👏', '🤝', '🫶', '💜', '💙', '💛', '🤍', '🖤', '💬'] },
]

export const PARTICIPANT_STATUS_EMOJIS = PARTICIPANT_STATUS_EMOJI_GROUPS.flatMap((group) => group.emojis)

