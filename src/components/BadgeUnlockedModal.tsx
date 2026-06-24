interface Props {
  badge: string
  onClose: () => void
}

const badgeData: Record<
  string,
  {
    emoji: string
    title: string
    description: string
    glow: string
  }
> = {
  pioneer: {
    emoji: '🚀',
    title: 'Pioneer',
    description:
      'You are among the first explorers shaping Xelay.',
    glow: 'from-cyan-500 to-blue-500',
  },

  expert: {
    emoji: '🔥',
    title: 'Expert',
    description:
      'Your knowledge is helping others grow.',
    glow: 'from-orange-500 to-red-500',
  },

  authority: {
    emoji: '👑',
    title: 'Authority',
    description:
      'Your expertise has become recognized across the platform.',
    glow: 'from-yellow-400 to-amber-600',
  },

  community_favorite: {
    emoji: '❤️',
    title: 'Community Favorite',
    description:
      'The community truly values your contributions.',
    glow: 'from-pink-500 to-red-500',
  },
}

export function BadgeUnlockedModal({
  badge,
  onClose,
}: Props) {
  const data = badgeData[badge]

  if (!data) return null

  return (
    <div className="fixed inset-0 z-[9999] bg-white/60 backdrop-blur-xl flex items-center justify-center px-4 animate-in fade-in duration-300">

      <div className="relative w-full max-w-md">

        <div
          className={`absolute inset-0 blur-3xl opacity-40 bg-gradient-to-r ${data.glow}`}
        />

        <div className="relative overflow-hidden rounded-3xl border border-border bg-white p-8 text-center shadow-2xl">

          <div className="absolute inset-0 bg-gradient-to-b from-black/[0.02] to-transparent" />

          <div className="relative">

            <p className="uppercase tracking-[0.4em] text-xs text-zinc-400 mb-4">
              Achievement Unlocked
            </p>

            <div
              className={`mx-auto mb-6 flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-r ${data.glow} text-6xl shadow-2xl animate-pulse`}
            >
              {data.emoji}
            </div>

            <h2 className="text-4xl font-black text-black mb-3">
              {data.title}
            </h2>

            <p className="text-zinc-600 leading-relaxed mb-8">
              {data.description}
            </p>

            <button
              onClick={onClose}
              className={`w-full rounded-2xl bg-gradient-to-r ${data.glow} py-4 font-bold text-white transition hover:scale-[1.02] active:scale-[0.98]`}
            >
              LET'S GO →
            </button>

          </div>

        </div>
      </div>
    </div>
  )
}