'use strict'

const path = require('node:path')
const { readFile } = require('node:fs/promises')
const postcss = require('postcss')
const { compile } = require('tailwindcss')
const { Scanner } = require('@tailwindcss/oxide')
const theme = require('../../tailwind.config.cjs')

const projectRoot = path.resolve(__dirname, '../..')
const sourcePattern = '**/*.{js,jsx,ts,tsx}'
const themePath = require.resolve('tailwindcss/theme.css')
const appThemePath = path.join(projectRoot, 'src/styles/utility-theme.css')

/** Let the maintained compiler and scanner handle arbitrary values, variants and future classes. */
module.exports = {
  postcssPlugin: 'xelay-utilities',
  async Once(root, { result }) {
    const directive = root.nodes.find(node => node.type === 'atrule' && node.name === 'tailwind' && node.params === 'utilities')
    if (!directive) return

    const scanner = new Scanner({ sources: [
      { base: projectRoot, pattern: 'index.html', negated: false },
      { base: path.join(projectRoot, 'src'), pattern: sourcePattern, negated: false },
    ] })
    const [defaults, appTheme] = await Promise.all([readFile(themePath, 'utf8'), readFile(appThemePath, 'utf8')])
    const compiler = await compile(defaults + '\n' + appTheme + '\n@config "xelay-theme";\n@tailwind utilities;', {
      base: projectRoot,
      loadModule: async (id) => {
        if (id !== 'xelay-theme') throw new Error('Unexpected utility theme')
        return { module: theme, base: projectRoot, path: path.join(projectRoot, 'tailwind.config.cjs') }
      },
    })
    const utilities = compiler.build(scanner.scan())
    directive.replaceWith(...postcss.parse(utilities, { from: undefined }).nodes)
    for (const file of [...scanner.files, appThemePath, themePath, path.join(projectRoot, 'tailwind.config.cjs')]) result.messages.push({ type: 'dependency', plugin: 'xelay-utilities', file })
    result.messages.push({ type: 'dir-dependency', plugin: 'xelay-utilities', dir: path.join(projectRoot, 'src'), glob: sourcePattern })
  },
}
