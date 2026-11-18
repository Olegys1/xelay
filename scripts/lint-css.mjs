import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import postcss from 'postcss'
import { find, lexer, parse, walk } from 'css-tree'

export function lintStylesheet(source, filename) {
  const diagnostics = []
  const report = (line, column, reason) => diagnostics.push(`${filename}:${line}:${column} ${reason}`)
  // PostCSS enforces balanced source even where CSS Tree would recover at EOF.
  try {
    const sheet = postcss.parse(source, { from: filename })
    sheet.walkDecls(declaration => {
      const previous = declaration.prev()
      if (previous?.type === 'decl' && previous.prop === declaration.prop &&
          previous.value === declaration.value && previous.important === declaration.important) {
        const { line, column } = declaration.source.start
        report(line, column, `Duplicate declaration of ${declaration.prop}`)
      }
    })
  } catch (error) {
    if (error.name !== 'CssSyntaxError') throw error
    report(error.line, error.column, error.reason)
    return diagnostics
  }

  const tree = parse(source, {
    positions: true,
    onParseError(error) { report(error.line, error.column, error.message) },
  })
  walk(tree, {
    visit: 'Declaration',
    enter(declaration) {
      const { property, value } = declaration
      if (property.startsWith('--')) return
      const atRule = this.atrule?.name
      const descriptors = atRule && lexer.getAtrule(atRule)?.descriptors
      const { error } = descriptors && !this.rule
        ? lexer.matchAtruleDescriptor(atRule, property, value)
        : lexer.matchProperty(property, value)
      if (!error) return
      // var() and env() are substituted by the browser. The parser still
      // checks their syntax and the lexer still rejects unknown properties.
      if (error.name !== 'SyntaxReferenceError' && find(value, node =>
        node.type === 'Function' && ['var', 'env'].includes(node.name.toLowerCase()))) return
      const { line, column } = declaration.loc.start
      report(line, column, `${property}: ${error.rawMessage || error.message.split('\n')[0]}`)
    },
  })
  return diagnostics
}

export async function lintDirectory(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.css'))
    .map(entry => resolve(entry.parentPath, entry.name)).sort()
  if (!files.length) throw new Error('No CSS files found to lint')
  const diagnostics = []
  for (const file of files) diagnostics.push(...lintStylesheet(await readFile(file, 'utf8'), file))
  return { files: files.length, diagnostics }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { files, diagnostics } = await lintDirectory(new URL('../src/', import.meta.url))
  for (const diagnostic of diagnostics) console.error(diagnostic)
  console.log(`Checked ${files} CSS files with ${diagnostics.length} errors.`)
  if (diagnostics.length) process.exitCode = 1
}
