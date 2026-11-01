// Exercise unbundled compiler output: bundlers resolve .ts imports and can hide
// production failures when a platform emits only .js files. No server listens.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url)), parent = path.resolve(root, '.assistant-server-emission.local')
const entries = ['api/assistant.ts', 'api/security/media-cleanup.ts']
const privateNames = ['OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVICE_ROLE','SUPABASE_ANON_KEY','VITE_SUPABASE_ANON_KEY','SUPABASE_ACCESS_TOKEN']
function checkEnvironment() {
  assert.ok(process.execArgv.some(value => value.endsWith('offline-guard.mjs')), 'Run emitted runtime imports with the existing offline guard')
  assert.ok(privateNames.every(name => !Object.hasOwn(process.env,name)), 'Use the existing credential-free CI environment; no provider environment is inspected')
}
async function temporary(t) {
  await fs.mkdir(parent, { recursive:true })
  const directory = await fs.mkdtemp(path.join(parent, 'case-'))
  t.after(async () => {
    const absolute = path.resolve(directory), relative = path.relative(parent, absolute)
    assert.equal(path.dirname(absolute), parent, 'Recursive cleanup stays in the verified ignored test directory')
    assert.match(relative, /^case-[a-zA-Z0-9]+$/)
    await fs.rm(absolute, {recursive:true,force:true})
  })
  return directory
}
async function emit(directory, removeRewrite = false) {
  const config = ts.readConfigFile(path.join(root,'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.deepEqual(parsed.errors, [])
  // Only output location/emit controls differ from the real application config.
  // The positive case never supplies a replacement extension-rewriting flag.
  const options = {...parsed.options,noEmit:false,noEmitOnError:false,rootDir:root,outDir:directory,declaration:false,declarationMap:false,sourceMap:false,incremental:false}
  if (removeRewrite) delete options.rewriteRelativeImportExtensions
  const written = [], program = ts.createProgram(entries.map(entry => path.join(root,entry)), options)
  const result = program.emit(undefined, (filename, data) => {
    const target = path.resolve(filename)
    assert.ok(target.startsWith(path.resolve(directory)+path.sep), 'Compiler output stays inside its disposable directory')
    // TypeScript's host is synchronous; these bounded files contain source,
    // public guide JSON and no configuration secrets.
    mkdirSync(path.dirname(target),{recursive:true}); writeFileSync(target,data)
    written.push(target)
  })
  assert.equal(result.emitSkipped, false)
  await fs.writeFile(path.join(directory,'package.json'), '{"type":"module"}\n')
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(row => row.category === ts.DiagnosticCategory.Error).map(row => ({code:row.code,message:ts.flattenDiagnosticMessageText(row.messageText,' ')}))
  const missing = []
  for (const file of written.filter(value => value.endsWith('.js'))) {
    const ast = ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
    function inspect(node) {
      const specifier = (ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.') && !existsSync(path.resolve(path.dirname(file),specifier.text))) missing.push({file:path.relative(directory,file).replaceAll('\\','/'),import:specifier.text})
      ts.forEachChild(node,inspect)
    }
    inspect(ast)
  }
  return {written,missing,diagnostics}
}

test('actual server compiler configuration emits an importable JS closure including the real guide JSON', {timeout:120000}, async t => {
  checkEnvironment()
  const directory = await temporary(t), result = await emit(directory)
  assert.deepEqual(result.diagnostics, [])
  assert.deepEqual(result.missing, [], 'Every local emitted JS/JSON import must exist; a bundler is deliberately not involved')
  for (const audience of ['headman','teacher']) {
    const file = 'public/guides/data/'+audience+'.json'
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,file),'utf8')),JSON.parse(await fs.readFile(path.join(root,file),'utf8')))
  }
  const switches = ['ASSISTANT_ENABLED','ASSISTANT_CLOUD_DRAFTS_READY','ASSISTANT_MODEL_ENABLED','ASSISTANT_MODEL_BUDGET_READY','ASSISTANT_MODEL_SPEND_APPROVED'], previous = switches.map(name => [name,process.env[name]])
  try {
    for (const name of switches) process.env[name] = 'false'
    for (const [index,entry] of entries.entries()) {
      const value = await import(pathToFileURL(path.join(directory,entry.replace(/\.ts$/,'.js'))).href)
      assert.equal(typeof value.default,'function',entry+' exports its actual HTTP handler')
      assert.equal(value.config.maxDuration,index===0?120:60)
    }
  } finally {
    for (const [name,value] of previous) { if (value===undefined) delete process.env[name]; else process.env[name]=value }
  }
})

test('removing extension rewriting reproduces missing runtime TS paths without executing the broken output', {timeout:120000}, async t => {
  checkEnvironment()
  const directory = await temporary(t), result = await emit(directory,true)
  assert.ok(result.missing.some(row => row.file==='api/assistant.js'&&row.import==='../server/assistant-v2/cloudRuntime.ts'))
  assert.ok(result.missing.some(row => row.file.startsWith('server/assistant-v2/')&&row.import.endsWith('.ts')), 'The complete dependency graph, not only the entry file, is protected')
  // Never import this intentionally broken graph or construct an SDK/provider.
})
