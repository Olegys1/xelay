import { createElement, useMemo, type MouseEvent, type ReactNode } from 'react'
import katex from 'katex'
import { splitTeachingTestContent } from '../../lib/teachingTestContent'
import './teaching-test-content.css'

const mathNamespace = 'http://www.w3.org/1998/Math/MathML'
const mathElements = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace', 'mfrac', 'msqrt', 'mroot',
  'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded',
  'mphantom', 'menclose', 'mmultiscripts', 'mprescripts', 'none',
])
const mathAttributes = [
  'display', 'accent', 'accentunder', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathcolor', 'stretchy', 'fence',
  'separator', 'form', 'largeop', 'movablelimits', 'symmetric', 'minsize', 'maxsize', 'lspace', 'rspace', 'linethickness',
  'width', 'height', 'depth', 'voffset', 'notation', 'columnalign', 'columnspacing', 'rowalign', 'rowspacing', 'columnlines', 'rowlines',
]

function mathNode(node: Node, key: number, depth = 0): ReactNode {
  if (node.nodeType === 3) return node.nodeValue
  if (node.nodeType !== 1 || depth > 120) return null
  const element = node as Element
  if (element.namespaceURI !== mathNamespace || !mathElements.has(element.localName)) return null
  const props: Record<string, string | number> = { key }
  for (const name of mathAttributes) {
    const value = element.getAttribute(name)
    if (value !== null) props[name] = value
  }
  return createElement(element.localName, props, Array.from(element.childNodes, (child, index) => mathNode(child, index, depth + 1)))
}

function TeachingFormula({ source }: { source: string }) {
  const formula = useMemo(() => {
    if (typeof DOMParser === 'undefined') return null
    try {
      const markup = katex.renderToString(source, { output: 'mathml', trust: false, throwOnError: true, maxExpand: 100, maxSize: 8 })
      const document = new DOMParser().parseFromString(markup, 'application/xml')
      const math = document.getElementsByTagNameNS(mathNamespace, 'math')[0]
      return math ? mathNode(math, 0) : null
    } catch {
      return null
    }
  }, [source])
  return formula ?? <span className="teaching-test-formula-fallback" title="Не вдалося відобразити формулу">{source}</span>
}

export function TeachingTestContent({ text, allowExternalLinks = false, onExternalLink }: {
  text: string
  allowExternalLinks?: boolean
  onExternalLink?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void
}) {
  const parts = useMemo(() => splitTeachingTestContent(text), [text])
  return <span className="teaching-test-content">{parts.map((part, index) => {
    if (part.kind === 'formula') return <TeachingFormula key={index} source={part.value} />
    if (part.kind === 'link' && allowExternalLinks) {
      return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer"
        onClick={onExternalLink ? event => onExternalLink(event, part.href) : undefined}>{part.value}</a>
    }
    return part.value
  })}</span>
}
