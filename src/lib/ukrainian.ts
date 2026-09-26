export type UkrainianPluralForms = [string, string, string]

export function ukrainianCount(count: number, forms: UkrainianPluralForms) {
  const value = Math.abs(Math.trunc(count))
  const lastTwo = value % 100
  const last = value % 10

  const form = last === 1 && lastTwo !== 11
    ? forms[0]
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
      ? forms[1]
      : forms[2]

  return `${count} ${form}`
}

const EXPERIENCE_LABELS: Record<string, string> = {
  'Student / Fresh Graduate': 'Студент / випускник',
  '1–3 years': '1–3 роки',
  '3–7 years': '3–7 років',
  '7–15 years': '7–15 років',
  '15+ years': 'Понад 15 років',
}

export function experienceLabel(value: string) {
  return EXPERIENCE_LABELS[value] ?? value
}
