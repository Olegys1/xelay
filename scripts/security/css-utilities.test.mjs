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
      assert.doesNotMatch(declaration.value, /var\(--(?:primary|xai-primary)\)/,
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
test('custom workspaces keep ordinary text and accents readable in the selected dark theme', async () => {
  const globalCss = postcss.parse(await readFile(path.join(projectRoot, 'src/index.css'), 'utf8'))
  const globals = new Map()
  globalCss.walkRules(rule => {
    if (rule.selector.split(',').some(selector => selector.trim() === ':root.dark')) {
      rule.walkDecls(declaration => globals.set(declaration.prop, declaration.value))
    }
  })
  const cases = [
    ['components/home/HomeDashboard.css', ['.hd-dashboard', '.hd-dashboard[data-theme=dark]'], ['--hd-text','--hd-muted','--hd-accent'], ['--hd-bg','--hd-card','--hd-soft']],
    ['pages/deanWorkspace.css', ['.dean-shell','.dark .dean-shell'], ['--dean-ink','--dean-muted','--dean-accent'], ['--dean-surface','--dean-canvas']],
    ['components/student/maxTutorAssistant.css', ['.mta','.dark .mta-chat'], ['--mta-ink','--mta-muted','--mta-accent'], ['--mta-surface','--mta-soft','--mta-answer']],
    ['components/assistant-v2/xelay-assistant.css', ['.xai-root'], ['--xai-text','--xai-muted','--xai-accent-text'], ['--xai-bg','--xai-soft','--xai-accent']],
    ['components/student/studentDeskTools.css', ['.sdt','.dark .sdt'], ['--sdt-ink','--sdt-muted','--sdt-wine'], ['--card','--muted']],
    ['components/student/studentPracticeLab.css', ['.spl','.dark .spl'], ['--spl-ink','--spl-muted','--spl-wine'], ['--card','--muted']],
    ['components/student/studyWorkbench.css', ['.swb','.dark .swb'], ['--swb-ink','--swb-muted','--swb-wine'], ['--card','--muted']],
    ['components/student/maxCourseworkStudio.css', ['.mcs','.dark .mcs'], ['--mcs-ink','--mcs-muted','--mcs-wine'], ['--card','--muted']],
    ['components/student/maxResearchStudio.css', ['.mrs','.dark .mrs'], ['--mrs-ink','--mrs-muted','--mrs-wine'], ['--mrs-paper','--mrs-wash']],
    ['components/student/maxExamPreparation.css', ['.mep','.dark .mep'], ['--exam-ink','--exam-soft','--exam-accent'], ['--exam-paper']],
    ['components/opportunities/Opportunities.css', ['.op-workspace','.dark .op-workspace'], ['--op-ink','--op-muted','--op-accent'], ['--op-paper','--op-soft']],
    ['components/opportunities/OrganizationWorkspace.css', ['.org-shell','.dark .org-shell'], ['--org-ink','--org-muted'], ['--org-surface','--org-bg']],
    ['components/seminarActivity.css', ['.seminar-activity','.dark .seminar-activity'], ['--sa-ink','--sa-muted','--sa-wine'], ['--sa-paper']],
  ]
  const luminance = (value, palette) => {
    for (let depth = 0; value.includes('var(') && depth < 12; depth++) {
      value = value.replace(/var\((--[\w-]+)(?:,[^()]*)?\)/g, (_, key) => {
        assert.ok(palette.has(key), 'Unknown contrast token ' + key)
        return palette.get(key)
      })
    }
    let rgb
    if (/^#[\da-f]{6}$/i.test(value)) {
      rgb = [1,3,5].map(offset => parseInt(value.slice(offset, offset + 2),16) / 255)
    } else {
      const channels = value.match(/[\d.]+/g)?.map(Number)
      assert.ok(channels?.length === 3, 'Unsupported contrast color ' + value)
      const [h,saturation,lightness] = channels, s = saturation / 100, l = lightness / 100
      rgb = [0,8,4].map(n => {
        const k = (n + h / 30) % 12
        return l - s * Math.min(l,1-l) * Math.max(-1,Math.min(k-3,9-k,1))
      })
    }
    return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i],0)
  }
  for (const [file,selectors,foregrounds,backgrounds] of cases) {
    const palette = new Map(globals)
    const css = postcss.parse(await readFile(path.join(projectRoot,'src',file),'utf8'))
    for (const selector of selectors) {
      css.walkRules(rule => {
        if (rule.selector.split(',').some(entry => entry.trim() === selector)) {
          // Manual and clock-based night themes must work even when the OS is light.
          if (selector.includes('.dark')) {
            for (let parent = rule.parent; parent; parent = parent.parent) {
              assert.ok(parent.type !== 'atrule' || !/prefers-color-scheme/.test(parent.params || ''), file + ' gates dark colors on the OS preference')
            }
          }
          rule.walkDecls(declaration => { if (declaration.prop.startsWith('--')) palette.set(declaration.prop,declaration.value) })
        }
      })
    }
    for (const foreground of foregrounds) for (const background of backgrounds) {
      assert.ok(palette.has(foreground) && palette.has(background), file + ' is missing a reading color')
      const a = luminance(palette.get(foreground),palette), b = luminance(palette.get(background),palette)
      const ratio = (Math.max(a,b) + .05) / (Math.min(a,b) + .05)
      assert.ok(ratio >= 4.5, `${file}: ${foreground} on ${background}: ${ratio.toFixed(2)}:1`)
    }
  }
})
