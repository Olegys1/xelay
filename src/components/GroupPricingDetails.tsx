import { useId, useState } from 'react'

/** Illustrative cost sharing only; checkout always charges 750 UAH for the group. */
export function GroupPricingDetails() {
  const countId = useId()
  const [people, setPeople] = useState('30')
  const count = /^\d+$/.test(people) ? Number(people) : NaN
  const validCount = Number.isSafeInteger(count) && count >= 1 && count <= 1000
  const price = validCount ? new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(750 / count) : null

  return <div className="space-y-3">
    <div>
      <p aria-live="polite" aria-atomic="true" className="text-xl font-medium leading-snug text-primary">
        {price ? `${count === 30 ? 'Лише ' : ''}${price} грн з людини на рік` : 'Розрахуйте вартість на людину'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <label htmlFor={countId}>Приклад розрахунку для групи з</label>
        <input id={countId} type="number" inputMode="numeric" min={1} max={1000} step={1}
          value={people} onChange={(event) => setPeople(event.target.value)} aria-invalid={!validCount}
          aria-describedby={`${countId}-help`}
          className="h-9 w-20 border border-primary/20 bg-background px-2 text-center text-sm text-foreground" />
        <span>людей</span>
      </div>
      {!validCount && <p className="mt-1 text-xs text-muted-foreground">Вкажіть ціле число від 1 до 1000.</p>}
    </div>
    <p className="text-sm leading-relaxed text-foreground">Доступ для всієї групи коштує 750 грн на 12 місяців. Оплата одним платежем, без автоматичних списань.</p>
    <p id={`${countId}-help`} className="text-xs leading-relaxed text-muted-foreground">Це розрахунок спільної вартості. Сайт не збирає оплату окремо з кожного учасника. Особиста підписка «Учасник» для доступу до розкладу, ДЗ, семінарів і матеріалів групи не потрібна.</p>
  </div>
}
