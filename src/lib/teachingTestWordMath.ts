import { wrapTeachingTestFormula } from './teachingTestContent.ts'

const clipboardLimit = 512_000
const mathSymbols: Record<string, string> = {
  '−': '-', '×': '\\times ', '÷': '\\div ', '±': '\\pm ', '∓': '\\mp ', '·': '\\cdot ', '⋅': '\\cdot ',
  '≤': '\\leq ', '≥': '\\geq ', '≠': '\\ne ', '≈': '\\approx ', '≡': '\\equiv ', '∞': '\\infty ',
  '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ',
  '∂': '\\partial ', '∇': '\\nabla ', '√': '\\surd ', '∈': '\\in ', '∉': '\\notin ', '∅': '\\varnothing ',
  '→': '\\to ', '←': '\\leftarrow ', '⇒': '\\Rightarrow ', '↔': '\\leftrightarrow ', '…': '\\ldots ',
  '\u2061': '', '\u2062': '\\,', '\u2063': ',', '\u2064': '+',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\epsilon ', 'ϵ': '\\varepsilon ',
  'ζ': '\\zeta ', 'η': '\\eta ', 'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ',
  'λ': '\\lambda ', 'μ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ', 'π': '\\pi ', 'ρ': '\\rho ', 'σ': '\\sigma ',
  'τ': '\\tau ', 'υ': '\\upsilon ', 'φ': '\\phi ', 'ϕ': '\\varphi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ',
  'Σ': '\\Sigma ', 'Υ': '\\Upsilon ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
}

const specialText: Record<string, string> = { '\\': '\\backslash ', '^': '\\hat{}', '~': '\\sim ' }
const tag = (element: Element) => element.localName.split(':').pop()?.toLowerCase() || ''
const escapeText = (value: string) => Array.from(value, character =>
  specialText[character] ?? mathSymbols[character] ?? (/[{}%$&#_]/.test(character) ? `\\${character}` : character),
).join('')
const group = (value: string) => `{${value}}`
const children = (element: Element, name?: string) => Array.from(element.children).filter(child => !name || tag(child) === name)
const child = (element: Element, name: string) => children(element, name)[0]
const property = (element: Element | undefined, name: string, fallback = '') => {
  const value = element && child(element, name)
  return value?.getAttribute('m:val') ?? value?.getAttribute('val') ?? fallback
}
const fence: Record<string, string> = { '': '.', '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\Vert', '⟨': '\\langle', '⟩': '\\rangle', '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor' }

function wordMath(element: Element, depth = 0): string {
  if (depth > 40) throw new Error('Formula too deep')
  const name = tag(element)
  const convert = (value?: Element) => value ? wordMath(value, depth + 1) : ''
  const get = (key: string) => convert(child(element, key))
  const content = () => children(element).map(convert).join('')
  if (name.endsWith('pr') || name === 'ctrlpr' || name === 'brk' || name === 'argpr') return ''
  if (name === 't') return escapeText(element.textContent || '')
  if (['omath', 'omathpara', 'r', 'e', 'num', 'den', 'deg', 'sub', 'sup', 'lim', 'fname'].includes(name)) return content()
  if (name === 'f') return `\\frac${group(get('num'))}${group(get('den'))}`
  if (name === 'rad') {
    const degree = get('deg')
    return `\\sqrt${degree && property(child(element, 'radpr'), 'deghide') !== '1' ? `[${degree}]` : ''}${group(get('e'))}`
  }
  if (name === 'ssub' || name === 'ssubsup' || name === 'ssup') {
    return `${group(get('e'))}${name !== 'ssup' ? `_${group(get('sub'))}` : ''}${name !== 'ssub' ? `^${group(get('sup'))}` : ''}`
  }
  if (name === 'spre') return `{}_${group(get('sub'))}^${group(get('sup'))}${group(get('e'))}`
  if (name === 'nary') {
    const props = child(element, 'narypr')
    const operator = escapeText(property(props, 'chr', '∫'))
    const sub = get('sub'), sup = get('sup')
    return `${operator}${sub && property(props, 'subhide') !== '1' ? `_${group(sub)}` : ''}${sup && property(props, 'suphide') !== '1' ? `^${group(sup)}` : ''}${group(get('e'))}`
  }
  if (name === 'd') {
    const props = child(element, 'dpr')
    const left = property(props, 'begchr', '('), right = property(props, 'endchr', ')')
    const body = children(element, 'e').map(convert).join(escapeText(property(props, 'sepchr', '|')))
    return fence[left] !== undefined && fence[right] !== undefined
      ? `\\left${fence[left]} ${body} \\right${fence[right]}` : `${escapeText(left)}${body}${escapeText(right)}`
  }
  if (name === 'm') return `\\begin{matrix}${children(element, 'mr').map(row => children(row, 'e').map(convert).join(' & ')).join(' \\\\ ')}\\end{matrix}`
  if (name === 'eqarr') return `\\begin{aligned}${children(element, 'e').map(convert).join(' \\\\ ')}\\end{aligned}`
  if (name === 'limlow' || name === 'limupp') return `\\${name === 'limlow' ? 'underset' : 'overset'}${group(get('lim'))}${group(get('e'))}`
  if (name === 'bar') return `\\${property(child(element, 'barpr'), 'pos') === 'bot' ? 'underline' : 'overline'}${group(get('e'))}`
  if (name === 'acc') {
    const mark = property(child(element, 'accpr'), 'chr', '̂')
    const command = ({ '̂': 'hat', '̃': 'tilde', '⃗': 'vec', '̇': 'dot', '̈': 'ddot', '̄': 'bar', '̆': 'breve', '̌': 'check' } as Record<string, string>)[mark]
    return command ? `\\${command}${group(get('e'))}` : `\\overset${group(escapeText(mark))}${group(get('e'))}`
  }
  if (name === 'func') return `\\operatorname${group(get('fname'))}${group(get('e'))}`
  if (name === 'box' || name === 'borderbox') return group(get('e'))
  if (name === 'phant') return `\\phantom${group(get('e'))}`
  throw new Error(`Unsupported Word equation element: ${name}`)
}

function mathMl(element: Element, depth = 0): string {
  if (depth > 40) throw new Error('Formula too deep')
  const name = tag(element), list = children(element)
  const convert = (value?: Element) => value ? mathMl(value, depth + 1) : ''
  const a = () => group(convert(list[0])), b = () => group(convert(list[1])), c = () => group(convert(list[2]))
  const value = () => escapeText(element.textContent || '')
  if (name === 'mi' || name === 'mn' || name === 'mo') return value()
  if (name === 'mtext' || name === 'ms') return `\\text${group(value())}`
  if (name === 'mspace') return '\\,'
  if (name === 'annotation' || name === 'annotation-xml') return ''
  if (['math', 'mrow', 'mstyle', 'mpadded'].includes(name)) return list.map(convert).join('')
  if (name === 'semantics') return convert(list.find(item => !tag(item).startsWith('annotation')))
  if (name === 'mfrac') return `\\frac${a()}${b()}`
  if (name === 'msqrt') return `\\sqrt${group(list.map(convert).join(''))}`
  if (name === 'mroot') return `\\sqrt[${convert(list[1])}]${a()}`
  if (name === 'msub' || name === 'msup') return `${a()}${name === 'msub' ? '_' : '^'}${b()}`
  if (name === 'msubsup') return `${a()}_${b()}^${c()}`
  if (name === 'munder' || name === 'mover') return `\\${name === 'munder' ? 'underset' : 'overset'}${b()}${a()}`
  if (name === 'munderover') return `\\overset${c()}{\\underset${b()}${a()}}`
  if (name === 'mfenced') {
    const left = element.getAttribute('open') ?? '(', right = element.getAttribute('close') ?? ')'
    const separators = Array.from((element.getAttribute('separators') ?? ',').replace(/\s/g, ''))
    const body = list.map((item, index) => `${index && separators.length ? escapeText(separators[Math.min(index - 1, separators.length - 1)]) : ''}${convert(item)}`).join('')
    return fence[left] !== undefined && fence[right] !== undefined
      ? `\\left${fence[left]} ${body} \\right${fence[right]}` : `${escapeText(left)}${body}${escapeText(right)}`
  }
  if (name === 'mtable') return `\\begin{matrix}${list.map(row => children(row).map(cell => children(cell).map(convert).join('')).join(' & ')).join(' \\\\ ')}\\end{matrix}`
  if (name === 'mphantom') return `\\phantom${group(list.map(convert).join(''))}`
  throw new Error(`Unsupported MathML element: ${name}`)
}

type EquationPaste = { formulas: string[]; recognized: boolean }

function inertEquation(fragment: string): Element | null {
  // Office XML frequently uses self-closing property nodes and inherits
  // namespace prefixes from the rest of its HTML clipboard document.
  if (/^<(?:[\w.-]+:)?(?:omath|math)\b/i.test(fragment)) {
    const prefixes = new Set(Array.from(fragment.matchAll(/(?:<\/?|\s)([A-Za-z][\w.-]*):[\w.-]+/g), match => match[1]))
    prefixes.delete('xml')
    prefixes.delete('xmlns')
    const namespaces = [...prefixes].map(prefix => ` xmlns:${prefix}="urn:xelay:clipboard:${prefix}"`).join('')
    const xml = new DOMParser().parseFromString(`<clipboard${namespaces}>${fragment.replace(/&nbsp;/g, '&#160;')}</clipboard>`, 'application/xml')
    if (xml.documentElement.localName === 'clipboard') return xml.documentElement.firstElementChild
  }
  const template = document.createElement('template')
  template.innerHTML = fragment
  return template.content.firstElementChild
}

/** Extract only equation fragments. Clipboard HTML never enters the document. */
export function readTeachingWordEquations(clipboard: Pick<DataTransfer, 'getData'>, parse = inertEquation): EquationPaste {
  const markup = ['application/mathml+xml', 'text/mathml', 'MathML', 'MathML Presentation', 'application/x-omml', 'application/omml+xml', 'text/html', 'text/plain']
  let recognized = false
  for (const type of markup) {
    const source = clipboard.getData(type)
    if (!source) continue
    if (source.length > clipboardLimit) {
      recognized ||= /<(?:[\w.-]+:)?(?:omath|math)\b/i.test(source)
      continue
    }
    for (const [closing, pattern, convert] of [
      [/<\/(?:[\w.-]+:)?omath\s*>/i, /<(?:[\w.-]+:)?omath\b[\s\S]*?<\/(?:[\w.-]+:)?omath\s*>/gi, wordMath],
      [/<\/(?:[\w.-]+:)?math\s*>/i, /<(?:[\w.-]+:)?math\b[\s\S]*?<\/(?:[\w.-]+:)?math\s*>/gi, mathMl],
    ] as const) {
      if (!closing.test(source)) continue
      const fragments = Array.from(source.matchAll(pattern), match => match[0])
      if (!fragments.length) continue
      recognized = true
      if (fragments.length > 20) continue
      const formulas: string[] = []
      for (const fragment of fragments) {
        if (fragment.length > 48_000) break
        try {
          const equation = parse(fragment)
          if (!equation || !['math', 'omath'].includes(tag(equation))) break
          const formula = wrapTeachingTestFormula(convert(equation))
          if (!formula) break
          formulas.push(formula)
        } catch {
          break
        }
      }
      if (formulas.length === fragments.length) return { formulas, recognized }
    }
  }
  return { formulas: [], recognized }
}
