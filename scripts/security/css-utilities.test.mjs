import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import postcss from 'postcss'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)

test('the application emits responsive grids, dark status colors and focused controls with its own theme', async () => {
  const sourcePath = path.join(projectRoot, 'src/index.css')
  const source = await readFile(sourcePath, 'utf8')
  const result = await postcss(require('../../postcss.config.cjs').plugins).process(source, { from: sourcePath })
  const rules = []
  result.root.walkRules(rule => rules.push(rule))
  const declarations = selector => {
    const rule = rules.findLast(entry => entry.selector === selector)
    assert.ok(rule, 'Missing CSS for ' + selector)
    return new Map(rule.nodes.map(node => [node.prop, node.value]))
  }
  assert.equal(declarations('.bg-primary').get('background-color'), 'hsl(var(--primary))')
  assert.equal(declarations('.text-primary').get('color'), 'hsl(var(--primary-text))')
  assert.equal(declarations('.rounded-xl').get('border-radius'), 'var(--radius-xl)')
  assert.equal(declarations('.dark\\:text-amber-300:is(.dark *)').get('color'), 'var(--color-amber-300)')
  const responsive = rules.find(rule => rule.selector.startsWith('.lg\\:grid-cols-') &&
    rule.nodes.some(node => node.value === '240px minmax(0,1fr)' || node.value === '240px minmax(0, 1fr)'))
  assert.ok(responsive && responsive.parent.name === 'media', 'Missing the two-column responsive layout')
  assert.ok(rules.some(rule => rule.selector.includes('.focus-visible\\:outline-none:focus-visible') &&
    rule.nodes.some(node => node.prop === 'outline' && node.value === '2px solid transparent')))
  assert.ok(result.messages.some(msg => msg.type === 'dependency' && msg.file.endsWith('OfflineStudyReader.tsx')))
  assert.ok(result.messages.some(msg => msg.type === 'dir-dependency' && path.basename(msg.dir) === 'components'))
})
