export function normalizedScheduleSubjectName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('uk-UA')
}
