import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
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

test('foreground accents use readable text tokens instead of the dark button fill', async () => {
  const files = await readdir(path.join(projectRoot, 'src'), { recursive: true })
  for (const file of files.filter(file => file.endsWith('.css'))) {
    const root = postcss.parse(await readFile(path.join(projectRoot, 'src', file), 'utf8'))
    root.walkDecls('color', declaration => {
      assert.doesNotMatch(declaration.value, /var\(--primary\)/,
        `${file}: ${declaration.parent.selector} uses the button fill for reading text`)
    })
  }
})

test('night palette keeps reading text and accent labels readable on app surfaces', async () => {
  const root = postcss.parse(await readFile(path.join(projectRoot, 'src/index.css'), 'utf8'))
  const palette = new Map()
  root.walkRules(rule => {
    if (rule.selector.split(',').map(selector => selector.trim()).includes(':root.dark')) {
      rule.walkDecls(declaration => palette.set(declaration.prop, declaration.value))
    }
  })
  const luminance = token => {
    const [h, saturation, lightness] = palette.get('--' + token).match(/[\d.]+/g).map(Number)
    const s = saturation / 100, l = lightness / 100
    const rgb = [0, 8, 4].map(n => {
      const k = (n + h / 30) % 12
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    })
    return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0)
  }
  for (const foreground of ['foreground', 'muted-foreground', 'primary-text', 'destructive-text']) {
    for (const background of ['background', 'card', 'muted', 'accent', 'sidebar']) {
      const a = luminance(foreground), b = luminance(background)
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`)
    }
  }
})
