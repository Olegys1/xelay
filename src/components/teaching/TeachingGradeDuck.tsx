type Props = { assessedPercent: number | null }

export function TeachingGradeDuck({ assessedPercent }: Props) {
  const value = assessedPercent !== null && Number.isFinite(assessedPercent) ? assessedPercent : null
  const mood = value === null ? 'waiting' : value >= 80 ? 'happy' : value >= 50 ? 'calm' : 'sad'
  const description = value === null
    ? 'Каченя чекає на оцінки. Поки немає числових результатів із відомим максимумом.'
    : `Каченя ${mood === 'happy' ? 'усміхається' : mood === 'calm' ? 'спокійне' : 'сумує'}: ${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value)}% за вже оціненими роботами. Від 80% — усміхається, від 50% до менш ніж 80% — спокійне, нижче 50% — сумує.`
  const body = 'M18 37C18 18 32 7 51 7s33 11 33 30c0 14-6 24-15 29 8 7 8 16 1 22-9 8-29 8-38 0-7-6-7-15 1-22-9-5-15-15-15-29Z'
  const feet = 'M32 87l-7 9q-1 2 3 2h15l2-9M59 89l2 9h15q4 0 3-2l-7-9'
  const ink = '#392d28'
  return <span className={`my-grades-duck my-grades-duck-${mood}`} title={description}>
    <svg viewBox="0 0 104 104" role="img" aria-label={description}>
      <g strokeLinejoin="round" strokeLinecap="round">
        <path d={feet} fill="#ffab42" stroke="#fffaf2" strokeWidth="9" />
        <path d={body} fill="#ffdc55" stroke="#fffaf2" strokeWidth="9" />
        <path d={feet} fill="#ffab42" stroke={ink} strokeWidth="3.6" />
        <path d={body} fill="#ffdc55" stroke={ink} strokeWidth="3.6" />
        <path d="M31 22q8-8 18-8" fill="none" stroke="#fff2af" strokeWidth="4.2" />
        <ellipse cx="51" cy="81" rx="12" ry="7" fill="#ffe98e" />
        {mood === 'happy'
          ? <path d="M29 74q4-8 11-6M73 74q-4-8-11-6" fill="none" stroke={ink} strokeWidth="3.2" />
          : <path d="M31 73q-2 8 5 10M71 73q2 8-5 10" fill="none" stroke={ink} strokeWidth="3.2" />}
        <ellipse cx="26" cy="46" rx="5" ry="3.4" fill="#f49d84" />
        <ellipse cx="77" cy="46" rx="5" ry="3.4" fill="#f49d84" />
        <path d="M29 46c2-5 10-6 22-6s21 1 23 6c3 9-7 15-23 15S26 55 29 46Z" fill="#ffab42" stroke={ink} strokeWidth="3.4" />
        {mood === 'happy' ? <>
          <path d="M30 34q6-9 12 0M60 34q6-9 12 0" fill="none" stroke={ink} strokeWidth="3.9" />
          <path d="M37 49q14 10 28 0" fill="none" stroke={ink} strokeWidth="3" />
        </> : mood === 'sad' ? <>
          <ellipse cx="36" cy="35" rx="3.7" ry="4.1" fill={ink} /><ellipse cx="66" cy="35" rx="3.7" ry="4.1" fill={ink} />
          <path d="M29 26q6 1 12-4M61 22q6 5 12 4" fill="none" stroke={ink} strokeWidth="2.9" />
          <path d="M37 54q14-8 28 0" fill="none" stroke={ink} strokeWidth="3" />
        </> : mood === 'waiting' ? <>
          <path d="M31 34h10M61 34h10" fill="none" stroke={ink} strokeWidth="3.8" />
          <path d="M38 51h26" fill="none" stroke={ink} strokeWidth="3" />
          <path d="M75 3h15a7 7 0 0 1 7 7v2a7 7 0 0 1-7 7h-8l-7 5v-5a7 7 0 0 1-7-7v-2a7 7 0 0 1 7-7Z" fill="#fffaf2" stroke={ink} strokeWidth="2.7" />
          <circle cx="76" cy="11" r="1.6" fill={ink} /><circle cx="83" cy="11" r="1.6" fill={ink} /><circle cx="90" cy="11" r="1.6" fill={ink} />
        </> : <>
          <ellipse cx="36" cy="33" rx="3.7" ry="4.2" fill={ink} /><ellipse cx="66" cy="33" rx="3.7" ry="4.2" fill={ink} />
          <circle cx="35" cy="31.8" r="1.1" fill="#fffaf2" /><circle cx="65" cy="31.8" r="1.1" fill="#fffaf2" />
          <path d="M37 51q14 3 28 0" fill="none" stroke={ink} strokeWidth="3" />
        </>}
      </g>
    </svg>
  </span>
}
