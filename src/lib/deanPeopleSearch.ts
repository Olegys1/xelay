export type DeanPersonOption = { id: string; name: string; group?: string }

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’'ʼ`]/g, '').trim()

export function searchDeanPeople(options: readonly DeanPersonOption[], query: string) {
  const words = normalize(query).split(/\s+/).filter(Boolean)
  return options.filter(option => {
    const haystack = normalize(`${option.name} ${option.group ?? ''}`)
    return words.every(word => haystack.includes(word))
  })
}
