type Props = { assessedPercent: number | null }

export function TeachingGradeDuck({ assessedPercent }: Props) {
  const value = assessedPercent !== null && Number.isFinite(assessedPercent) ? assessedPercent : null
  const mood = value === null ? 'waiting' : value >= 80 ? 'happy' : value >= 50 ? 'calm' : 'sad'
  const description = value === null
    ? 'Каченя чекає на оцінки. Поки немає числових результатів із відомим максимумом.'
    : `Каченя ${mood === 'happy' ? 'усміхається' : mood === 'calm' ? 'спокійне' : 'сумує'}: ${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value)}% за вже оціненими роботами. Від 80% — усміхається, від 50% до менш ніж 80% — спокійне, нижче 50% — сумує.`
  return <span className={`my-grades-duck my-grades-duck-${mood}`} title={description}>
    <svg viewBox="0 0 100 96" role="img" aria-label={description}>
      <ellipse cx="48" cy="89" rx="30" ry="4" fill="currentColor" opacity=".07" />
      <path d="M34 81v7l-11 2h18v-8M60 82v8h17l-10-3v-6" fill="#f7a73e" stroke="#d68a27" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M21 63Q5 54 9 72l15 7" fill="#ffd75c" stroke="#e6b643" strokeWidth="1.5" strokeLinejoin="round" />
      <ellipse cx="48" cy="67" rx="32" ry="22" fill="#ffda62" stroke="#e6b643" strokeWidth="1.5" />
      <path d="M28 63q11-6 24 2-2 17-19 13-8-3-5-15" fill="#ffcb45" stroke="#e6b643" strokeWidth="1.5" />
      <circle cx="48" cy="33" r="24" fill="#ffe377" stroke="#e6b643" strokeWidth="1.5" />
      <path d="M44 10q-5-9 2-6 3 1 4 6M50 10q2-11 7-5 1 3-2 7" fill="#ffe377" stroke="#e6b643" strokeWidth="1.5" strokeLinecap="round" />
      <ellipse cx="71" cy="44" rx="17" ry="8" fill="#ffad44" stroke="#df8d30" strokeWidth="1.5" />
      {mood === 'happy' ? <>
        <path d="M34 31q5-7 10 0M53 30q4-6 8 0" fill="none" stroke="#5b4631" strokeWidth="2.7" strokeLinecap="round" />
        <path d="M62 43q9 7 18-1" fill="none" stroke="#a76628" strokeWidth="1.8" strokeLinecap="round" />
        <ellipse cx="32" cy="41" rx="5" ry="2.6" fill="#f59d79" opacity=".65" />
      </> : mood === 'sad' ? <>
        <circle cx="39" cy="33" r="2.5" fill="#5b4631" /><circle cx="58" cy="32" r="2.3" fill="#5b4631" />
        <path d="M33 26q6 4 11 1M53 26q4 1 8-2" fill="none" stroke="#8b6a35" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M63 46q8-6 16-1" fill="none" stroke="#a76628" strokeWidth="1.8" strokeLinecap="round" />
      </> : mood === 'waiting' ? <>
        <path d="M35 32h8M54 31h7" fill="none" stroke="#5b4631" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M63 44h15" stroke="#a76628" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="82" cy="18" r="10" fill="#f3ede0" stroke="#d5cbb6" strokeWidth="1.2" />
        <path d="M82 12v6l4 2" fill="none" stroke="#9b8b6d" strokeWidth="1.8" strokeLinecap="round" />
      </> : <>
        <circle cx="39" cy="32" r="2.5" fill="#5b4631" /><circle cx="58" cy="31" r="2.3" fill="#5b4631" />
        <circle cx="38" cy="31" r=".7" fill="#fff9e7" /><circle cx="57" cy="30" r=".7" fill="#fff9e7" />
        <path d="M63 44q7 2 15 0" fill="none" stroke="#a76628" strokeWidth="1.7" strokeLinecap="round" />
      </>}
    </svg>
  </span>
}
