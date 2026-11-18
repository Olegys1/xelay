'use strict'

const path = require('node:path')
const { readFile } = require('node:fs/promises')
const postcss = require('postcss')
const { compile } = require('tailwindcss')
const { Scanner } = require('@tailwindcss/oxide')

const projectRoot = path.resolve(__dirname, '../..')
const sourceDir = path.join(projectRoot, 'src')
const sourcePattern = '**/*.{js,jsx,ts,tsx}'
const defaultTheme = require.resolve('tailwindcss/theme.css')
const appTheme = path.join(sourceDir, 'styles/utility-theme.css')
const configPath = path.join(projectRoot, 'tailwind.config.cjs')

module.exports = {
  postcssPlugin: 'xelay-utilities',
  async Once(root, { result }) {
    const directive = root.nodes.find(node =>
      node.type === 'atrule' && node.name === 'tailwind' && node.params === 'utilities')
    if (!directive) return

    // Keep the same source boundaries as the old build, including literal class maps in TS.
    const scanner = new Scanner({ sources: [
      { base: projectRoot, pattern: 'index.html', negated: false },
      { base: sourceDir, pattern: sourcePattern, negated: false },
    ] })
    const [defaults, tokens] = await Promise.all([readFile(defaultTheme, 'utf8'), readFile(appTheme, 'utf8')])
    const compiler = await compile([defaults, tokens, '@config "xelay-theme";', '@tailwind utilities;'].join('\n'), {
      base: projectRoot,
      async loadModule(id) {
        if (id !== 'xelay-theme') throw new Error('Unexpected utility theme')
        // The local development server reuses this process between edits.
        delete require.cache[configPath]
        return { module: require(configPath), base: projectRoot, path: configPath }
      },
    })
    const utilities = compiler.build(scanner.scan())
    directive.replaceWith(...postcss.parse(utilities, { from: undefined }).nodes)

    const plugin = 'xelay-utilities'
    const dirs = new Set([sourceDir])
    for (const file of [...scanner.files, appTheme, defaultTheme, configPath]) {
      result.messages.push({ type: 'dependency', plugin, file })
      if (file.startsWith(sourceDir + path.sep)) dirs.add(path.dirname(file))
    }
    for (const dir of dirs) result.messages.push({ type: 'dir-dependency', plugin, dir, glob: sourcePattern })
  },
}
