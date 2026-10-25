import './teaching-grade-duck.css'

type Props = { assessedPercent: number | null }

/** Mood reflects published, assessed work rather than the unfinished semester. */
export function TeachingGradeDuck({ assessedPercent }: Props) {
  const value = assessedPercent !== null && Number.isFinite(assessedPercent) ? assessedPercent : null
  const mood = value === null ? 'waiting' : value >= 80 ? 'happy' : value >= 50 ? 'calm' : 'sad'
  const description = value === null
    ? 'Каченя чекає на перші оцінки. Відсутні результати не вважаються нулем.'
    : `Каченя ${mood === 'happy' ? 'радіє вашим результатам' : mood === 'calm' ? 'спокійно підтримує вас' : 'трохи сумує й підтримує вас'}: ${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(value)}% за вже оціненими роботами.`

  return <span className={`my-grades-duck my-grades-duck-${mood}`} role="img" aria-label={description} title={description} data-mood={mood}>
    <span className="my-grades-duck-sprite" aria-hidden="true" />
  </span>
}
