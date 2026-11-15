export type TeachingTestContentPart =
  | { kind: 'text' | 'formula'; value: string }
  | { kind: 'link'; value: string; href: string }

export const MAX_TEST_FORMULA_LENGTH = 1600

export function teachingTestLink(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null
  try {
    const url = new URL(value)
    return !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function trimLinkEnd(value: string) {
  let end = value.length
  let parentheses = 0
  let brackets = 0
  for (const character of value) {
    if (character === '(') parentheses++
    if (character === ')') parentheses--
    if (character === '[') brackets++
    if (character === ']') brackets--
  }
  while (end) {
    const tail = value[end - 1]
    if (tail === ')' && parentheses < 0) parentheses++
    else if (tail === ']' && brackets < 0) brackets++
    else if (!/[.,;:!?»”’]/.test(tail)) break
    end--
  }
  return value.slice(0, end)
}

export function splitTeachingTestContent(text: string): TeachingTestContentPart[] {
  const parts: TeachingTestContentPart[] = []
  const tokens = /\\\(([^\r\n]{1,1600}?)\\\)|https?:\/\/[^\s<>"'\\]+/gi
  let position = 0
  for (const match of text.matchAll(tokens)) {
    const start = match.index ?? 0
    const value = match[0]
    if (start > position) parts.push({ kind: 'text', value: text.slice(position, start) })
    if (match[1]?.trim()) {
      parts.push({ kind: 'formula', value: match[1] })
    } else {
      const label = trimLinkEnd(value)
      const href = teachingTestLink(label)
      if (href) {
        parts.push({ kind: 'link', value: label, href })
        if (label.length < value.length) parts.push({ kind: 'text', value: value.slice(label.length) })
      } else parts.push({ kind: 'text', value })
    }
    position = start + value.length
  }
  if (position < text.length) parts.push({ kind: 'text', value: text.slice(position) })
  return parts
}

export function plainTeachingTestContent(text: string): string {
  return splitTeachingTestContent(text).map(part => part.value).join('')
}

export function wrapTeachingTestFormula(source: string): string | null {
  const value = source.trim().replace(/\s*\r?\n\s*/g, ' ').replace(/^\\\((.+)\\\)$|^\\\[(.+)\\\]$|^\$\$(.+)\$\$$|^\$([^$]+)\$$/, (_whole, inline, block, dollars, dollar) => inline ?? block ?? dollars ?? dollar)
  if (!value || value.length > MAX_TEST_FORMULA_LENGTH || /\\[()]/.test(value)) return null
  return `\\(${value}\\)`
}

export function teachingTestFormulaFromTextPaste(source: string): string | null {
  const text = source.trim()
  const explicitlyDelimited = /^\\\([\s\S]+\\\)$|^\\\[[\s\S]+\\\]$|^\$\$[\s\S]+\$\$$|^\$[^$]+\$$/.test(text)
  const startsWithFormulaCommand = /^\\(?:d?frac|tfrac|sqrt|sum|prod|int|lim|binom|begin|left|overline|underline|alpha|beta|pi|theta|infty)\b/.test(text)
  return explicitlyDelimited || startsWithFormulaCommand ? wrapTeachingTestFormula(text) : null
}
