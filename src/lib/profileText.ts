// Profiles created before free-text editing may contain several separate items.
export function profileText(values?: readonly string[] | null): string {
  return values?.join(', ') || ''
}

// Keep the existing text[] columns while preserving the text exactly as entered.
export function profileTextArray(value: string): string[] {
  return value.trim() ? [value] : []
}
