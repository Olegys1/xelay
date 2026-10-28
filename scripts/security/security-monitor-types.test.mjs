// Real semantic checking of only the two monitor modules and their declarations.
// No application build, provider execution, environment credentials or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

test('security monitor modules pass semantic TypeScript checks with real dependency declarations', () => {
  const rootNames = ['securityMonitor.ts', 'securityMonitorPolicy.ts'].map(name => fileURLToPath(new URL('../../server/' + name, import.meta.url)))
  const program = ts.createProgram({ rootNames, options: {
    noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: ['node'],
    strictNullChecks: true, skipLibCheck: true, esModuleInterop: true,
    allowSyntheticDefaultImports: true, forceConsistentCasingInFileNames: true,
  } })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const details = diagnostics.map(diagnostic => {
    const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null
    return `${diagnostic.file?.fileName || 'compiler'}${position ? ':' + (position.line + 1) : ''}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  }).join('\n')
  assert.equal(diagnostics.length, 0, details)
  assert.equal(program.getRootFileNames().length, 2)
  assert.equal(program.getSourceFiles().some(source => /[/\\]src[/\\]App\.tsx$/.test(source.fileName)), false)
})
