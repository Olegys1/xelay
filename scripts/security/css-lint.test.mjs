import assert from 'node:assert/strict'
import test from 'node:test'
import { lintDirectory, lintStylesheet } from '../lint-css.mjs'

test('CSS lint rejects malformed syntax, unknown properties, invalid values and exact duplicate declarations', () => {
  for (const source of ['.x { color: red', '.x { bogus-property: var(--accent) }',
    '.x { color: #abcdz }', '.x { width: red }', '.x { width: 1px; width: 1px }']) {
    assert.match(lintStylesheet(source, 'sample.css').join('\n'), /^sample\.css:\d+:\d+ /)
  }
})

test('CSS lint permits cascade fallbacks, custom values, environment insets and build-time directives', () => {
  const source = '@tailwind utilities; @layer base { .x { @apply fixed; --local: abc; color: red; color: var(--local); padding-bottom: env(safe-area-inset-bottom, 0px) } }'
  assert.deepEqual(lintStylesheet(source, 'sample.css'), [])
})

test('CSS lint validates the application styles under src', async () => {
  const { files, diagnostics } = await lintDirectory(new URL('../../src/', import.meta.url))
  assert.ok(files > 0)
  assert.deepEqual(diagnostics, [])
})
