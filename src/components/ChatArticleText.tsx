import { Fragment, useMemo, type ReactNode } from 'react'

function inlineText(text: string): ReactNode[] {
  const tokens: ReactNode[] = []
  const pattern = /\*\*([^*\n]{1,5000})\*\*|\*([^*\n]{1,5000})\*|`([^`\n]{1,5000})`|\[([^\[\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2048})\)/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    tokens.push(text.slice(offset, match.index))
    const key = `${match.index}`
    if (match[1]) tokens.push(<strong key={key}>{match[1]}</strong>)
    else if (match[2]) tokens.push(<em key={key}>{match[2]}</em>)
    else if (match[3]) tokens.push(<code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{match[3]}</code>)
    else tokens.push(<a key={key} href={match[5]} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{match[4]}</a>)
    offset = match.index! + match[0].length
  }
  tokens.push(text.slice(offset))
  return tokens
}

// This renderer creates React text nodes. Raw HTML and embedded scripts are never evaluated.
export function ChatArticleText({ body }: { body: string }) {
  const content = useMemo(() => {
    const lines = body.replace(/\r\n/g, '\n').split('\n')
    const blocks: ReactNode[] = []
    let paragraph: string[] = []
    const flush = () => {
      if (paragraph.length) blocks.push(<p key={`p${blocks.length}`} className="whitespace-pre-wrap">{inlineText(paragraph.join('\n'))}</p>)
      paragraph = []
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (!line.trim()) { flush(); continue }
      if (line.startsWith('```')) {
        flush()
        const code: string[] = []
        while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index])
        blocks.push(<pre key={`code${index}`} className="overflow-x-auto rounded-xl bg-muted p-3 text-xs"><code>{code.join('\n')}</code></pre>)
        continue
      }
      const heading = /^(#{1,3})\s+(.+)$/.exec(line)
      if (heading) {
        flush()
        const title = inlineText(heading[2])
        blocks.push(heading[1].length === 1 ? <h2 key={`h${index}`} className="text-xl font-semibold">{title}</h2> : <h3 key={`h${index}`} className="text-lg font-semibold">{title}</h3>)
        continue
      }
      const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line)
      if (list) {
        flush()
        const ordered = /^\s*\d+\./.test(line)
        const items: ReactNode[] = [<li key={index}>{inlineText(list[1])}</li>]
        while (index + 1 < lines.length) {
          const next = (ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*]\s+(.+)$/).exec(lines[index + 1])
          if (!next) break
          index++
          items.push(<li key={index}>{inlineText(next[1])}</li>)
        }
        blocks.push(ordered ? <ol key={`ol${index}`} className="list-decimal space-y-1 pl-5">{items}</ol> : <ul key={`ul${index}`} className="list-disc space-y-1 pl-5">{items}</ul>)
        continue
      }
      if (/^>\s?/.test(line)) {
        flush()
        blocks.push(<blockquote key={`q${index}`} className="border-l-2 border-primary/40 pl-3 text-muted-foreground">{inlineText(line.replace(/^>\s?/, ''))}</blockquote>)
        continue
      }
      paragraph.push(line)
    }
    flush()
    return blocks
  }, [body])
  return <div className="space-y-4 break-words text-sm leading-7 [overflow-wrap:anywhere]">{content.map((block, index) => <Fragment key={index}>{block}</Fragment>)}</div>
}
