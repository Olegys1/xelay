// Real temporary filesystem, canonical Git objects, injected read-only Git I/O.
// Every scenario runs under the mandatory offline subprocess/network guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { assertSourceTree, assertSourceEntry, SourceIntegrityError } from '../security-ci/source-proof.mjs'
import { CI_POLICY } from '../security-ci/verified-ci.mjs'

const hash = (kind, data) => createHash('sha1').update(`${kind} ${data.length}\0`).update(data).digest('hex')
async function fixture(t, { config, configBytes, tracked = [] } = {}) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'xelay-source-proof-test-'))
  t.after(async () => {
    assert.equal(dirname(directory), parent); assert.match(basename(directory), /^xelay-source-proof-test-/)
    await rm(directory, { recursive: true, force: true })
  })
  const sources = new Map([
    ['.gitignore', Buffer.from('node_modules\ndist\ndist-ssr\n*.local\n.env\n.env.*\n')],
    ['package.json', Buffer.from('{"private":true,"type":"module"}\n')],
    ['public/seed.txt', Buffer.from('public fixture\n')],
    ['src/app.js', Buffer.from('export const safe = true\n')],
  ])
  if (configBytes) sources.set('vercel.json', Buffer.from(configBytes))
  else if (config) sources.set('vercel.json', Buffer.from(JSON.stringify(config)))
  for (const [path, value] of tracked) sources.set(path, Buffer.from(value))
  await mkdir(join(directory, '.git'))
  for (const [path, bytes] of sources) { await mkdir(dirname(join(directory, path)), { recursive: true }); await writeFile(join(directory, path), bytes) }
  const treeObjects = new Map(), records = []
  function tree(prefix = '') {
    const children = new Map()
    for (const [path, bytes] of sources) {
      if (!path.startsWith(prefix)) continue
      const suffix = path.slice(prefix.length), slash = suffix.indexOf('/')
      if (slash < 0) children.set(suffix, { mode: '100644', type: 'blob', hash: hash('blob', bytes) })
      else children.set(suffix.slice(0, slash), null)
    }
    const parts = []
    for (const [name, entry] of [...children].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const value = entry ?? { mode: '040000', type: 'tree', hash: tree(prefix + name + '/') }
      parts.push(Buffer.from(`${value.type === 'tree' ? '40000' : value.mode} ${name}\0`), Buffer.from(value.hash, 'hex'))
      records.push(`${value.mode} ${value.type} ${value.hash}\t${prefix}${name}\0`)
    }
    const data = Buffer.concat(parts), sha = hash('tree', data)
    treeObjects.set(sha, data)
    return sha
  }
  const rootTree = tree(), commit = Buffer.from(`tree ${rootTree}\nauthor Synthetic <fixture@example.invalid> 1 +0000\ncommitter Synthetic <fixture@example.invalid> 1 +0000\n\nsource proof\n`)
  const expectedSha = hash('commit', commit), calls = []
  function spawn(command, args, options) {
    calls.push({ command, args, options })
    assert.equal(command, 'git'); assert.equal(options.shell, false); assert.equal(options.cwd, directory)
    assert.ok(args.includes('--no-replace-objects'))
    assert.ok(args.includes(`--git-dir=${join(directory, '.git')}`)); assert.ok(args.includes(`--work-tree=${directory}`))
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1'); assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(options.env.GIT_CONFIG_COUNT, '0'); assert.ok(options.timeout <= 3000)
    if (args.includes('rev-parse')) return { status: 0, stdout: Buffer.from(expectedSha + '\n') }
    if (args.includes('ls-tree')) return { status: 0, stdout: Buffer.from(records.join('')) }
    if (args.includes('--batch')) {
      const data = options.input.toString().trim().split('\n').map(sha => {
        const bytes = treeObjects.get(sha); assert.ok(bytes)
        return Buffer.concat([Buffer.from(`${sha} tree ${bytes.length}\n`), bytes, Buffer.from('\n')])
      })
      return { status: 0, stdout: Buffer.concat(data) }
    }
    if (args.includes('blob')) {
      const sha = args.at(-1), bytes = [...sources.values()].find(value => hash('blob', value) === sha)
      assert.ok(bytes); return { status: 0, stdout: bytes }
    }
    assert.ok(args.includes('commit')); return { status: 0, stdout: commit }
  }
  return { directory, expectedSha, calls, spawn,
    run: (extra = {}) => assertSourceTree({ directory, expectedSha, spawn, ...extra }) }
}

test('canonical source produces an immutable bounded nonsecret receipt and sanitized anchored Git reads', async t => {
  const fx = await fixture(t), proof = await fx.run({ environment: { PATH: process.env.PATH || '', GIT_WORK_TREE: '/wrong', GIT_DIR: '/wrong',
    GIT_CONFIG_PARAMETERS: 'unsafe', NODE_OPTIONS: '--unsafe', GITHUB_TOKEN: 'private-value', VERCEL_TOKEN: 'private-value' } })
  assert.equal(proof.sha, fx.expectedSha); assert.equal(proof.fileCount, 4); assert.ok(proof.totalBytes > 0)
  assert.match(proof.digest, /^[a-f0-9]{64}$/); assert.equal(Object.isFrozen(proof), true)
  assert.equal(fx.calls.length, 5); assert.doesNotMatch(JSON.stringify(proof), /private-value|fixture@example|source-proof-test/)
  for (const { options } of fx.calls) for (const key of ['GITHUB_TOKEN', 'VERCEL_TOKEN', 'NODE_OPTIONS', 'GIT_WORK_TREE', 'GIT_DIR', 'GIT_CONFIG_PARAMETERS']) assert.equal(options.env[key], undefined)
})

test('ignored dotenv, ignored public assets and arbitrary Vercel files cannot enter the build', async t => {
  for (const path of ['.env.production', '.env.local', 'public/injected.local', '.vercel/output/config.json']) await t.test(path, async t => {
    const fx = await fixture(t); await mkdir(dirname(join(fx.directory, path)), { recursive: true }); await writeFile(join(fx.directory, path), 'injected')
    await assert.rejects(fx.run(), { code: path.startsWith('.vercel/') ? 'SOURCE_PROVIDER_CONTEXT_INVALID' : 'SOURCE_EXTRA_INPUT' })
  })
})

test('precise generated root directories are allowed, while a similarly named directory is not', async t => {
  const fx = await fixture(t)
  for (const name of ['node_modules', 'dist', 'dist-ssr', '.security-ci.local']) {
    await mkdir(join(fx.directory, name)); await writeFile(join(fx.directory, name, 'generated.bin'), 'generated')
  }
  assert.equal((await fx.run()).fileCount, 4)
  await mkdir(join(fx.directory, 'node_modules-local'))
  await assert.rejects(fx.run(), { code: 'SOURCE_EXTRA_INPUT' })
})

test('actual tracked bytes are checked despite forged index flags and local worktree configuration', async t => {
  const fx = await fixture(t)
  await writeFile(join(fx.directory, '.git', 'config'), '[core]\nworktree = /fictional/clean/tree\nignorestat = true\n')
  await writeFile(join(fx.directory, '.git', 'index'), 'synthetic assume-unchanged and skip-worktree metadata')
  await writeFile(join(fx.directory, 'src', 'app.js'), 'export const safe = false\n')
  await assert.rejects(fx.run(), { code: 'SOURCE_CONTENT_MISMATCH' })
  assert.ok(fx.calls.every(({ args }) => !args.includes('status') && !args.includes('diff') && !args.includes('ls-files')))
})

test('mutations between independent proofs and missing committed files are rejected', async t => {
  const fx = await fixture(t), first = await fx.run()
  assert.equal((await fx.run()).digest, first.digest)
  await writeFile(join(fx.directory, 'src', 'app.js'), 'changed after first proof\n')
  await assert.rejects(fx.run(), { code: 'SOURCE_CONTENT_MISMATCH' })
  await unlink(join(fx.directory, 'src', 'app.js'))
  await assert.rejects(fx.run(), { code: 'SOURCE_MISSING_INPUT' })
})

test('a content mismatch exposes only an immutable verified source path, never file bytes or sentinel content', async t => {
  const fx = await fixture(t), sentinel = 'PRIVATE_FILE_VALUE_MUST_NOT_APPEAR_9f642'
  await writeFile(join(fx.directory, 'src', 'app.js'), sentinel)
  await assert.rejects(fx.run(), error => {
    assert.equal(error.code, 'SOURCE_CONTENT_MISMATCH'); assert.equal(error.sourcePath, 'src/app.js')
    assert.equal(Object.hasOwn(error, 'sourcePath'), true)
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'sourcePath'), { value: 'src/app.js', enumerable: true, writable: false, configurable: false })
    assert.doesNotMatch(String(error), /PRIVATE_FILE_VALUE|9f642/)
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_FILE_VALUE|9f642/)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'sourcePath'])
    return true
  })
})

test('credential-file names never become diagnostic source paths even if a public tree contains them', async t => {
  for (const path of ['.env.production', '.npmrc', 'src/.env.local']) await t.test(path, async t => {
    const fx = await fixture(t, { tracked: [[path, 'public invalid fixture baseline']] })
    await writeFile(join(fx.directory, path), 'PRIVATE_DIAGNOSTIC_SENTINEL')
    await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH' && !Object.hasOwn(error, 'sourcePath')
      && !JSON.stringify(error).includes('PRIVATE_DIAGNOSTIC_SENTINEL'))
  })
})

test('the actual walk entry boundary rejects symlinks and special files before treating directories as generated', () => {
  for (const isDirectory of [false, true]) assert.throws(() => assertSourceEntry({
    isSymbolicLink: () => true, isDirectory: () => isDirectory, isFile: () => !isDirectory,
  }), { code: 'SOURCE_SYMLINK' })
  assert.throws(() => assertSourceEntry({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }), { code: 'SOURCE_NOT_REGULAR_FILE' })
  assert.doesNotThrow(() => assertSourceEntry({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }))
})

test('HEAD changing during the final source walk cannot receive a receipt', async t => {
  const fx = await fixture(t); let headReads = 0
  await assert.rejects(fx.run({ spawn(command, args, options) {
    const result = fx.spawn(command, args, options)
    if (args.includes('rev-parse') && ++headReads === 2) result.stdout = Buffer.from('b'.repeat(40) + '\n')
    return result
  } }), { code: 'SOURCE_CHANGED' })
})

test('commit and tree object bytes must hash to their claimed IDs, independently of local Git metadata', async t => {
  for (const target of ['commit', 'tree']) await t.test(target, async t => {
    const fx = await fixture(t)
    await assert.rejects(fx.run({ spawn(command, args, options) {
      const result = fx.spawn(command, args, options)
      if (target === 'commit' && args.includes('commit')) { result.stdout = Buffer.from(result.stdout); result.stdout[result.stdout.length - 2] ^= 1 }
      if (target === 'tree' && args.includes('--batch')) { result.stdout = Buffer.from(result.stdout); result.stdout[result.stdout.indexOf(10) + 1] ^= 1 }
      return result
    } }), { code: target === 'commit' ? 'SOURCE_COMMIT_MISMATCH' : 'SOURCE_TREE_MISMATCH' })
  })
})

test('unexpected HEAD, missing Git metadata, unavailable Git and invalid SHA fail without source disclosure', async t => {
  const fx = await fixture(t)
  await assert.rejects(fx.run({ expectedSha: 'b'.repeat(40) }), { code: 'SOURCE_HEAD_MISMATCH' })
  await assert.rejects(fx.run({ expectedSha: 'main' }), { code: 'SOURCE_INVALID_INPUT' })
  await assert.rejects(fx.run({ spawn: () => ({ status: 1, stdout: Buffer.from('private-data') }) }), error => error instanceof SourceIntegrityError && error.code === 'SOURCE_GIT_UNAVAILABLE' && !String(error).includes('private-data'))
  await rm(join(fx.directory, '.git'), { recursive: true, force: true })
  await assert.rejects(fx.run(), { code: 'SOURCE_UNAVAILABLE' })
})

test('oversized source files are refused before their contents are read', async t => {
  const fx = await fixture(t)
  await truncate(join(fx.directory, 'src', 'app.js'), 64 * 1024 * 1024 + 1)
  await assert.rejects(fx.run(), { code: 'SOURCE_LIMIT_EXCEEDED' })
})

test('malformed canonical paths and symlink modes are rejected before walking', async t => {
  for (const record of ['100644 blob ' + 'a'.repeat(40) + '\t../escape\0', '120000 blob ' + 'a'.repeat(40) + '\tsrc/link\0']) await t.test(record.slice(0, 6), async t => {
    const fx = await fixture(t)
    await assert.rejects(fx.run({ spawn(command, args, options) { return args.includes('ls-tree') ? { status: 0, stdout: Buffer.from(record) } : fx.spawn(command, args, options) } }), { code: 'SOURCE_TREE_INVALID' })
  })
})

const canonicalConfig = Object.freeze({ buildCommand: 'node scripts/security-ci/release-gate.mjs && npm run build',
  installCommand: 'npm ci --ignore-scripts --no-audit --no-fund', framework: 'vite', outputDirectory: 'dist' })
const providerEnvironment = () => ({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: CI_POLICY.projectId })
const validManifest = () => ({ version: '20260304', runtime: 'node', framework: 'vite',
  runtimeVersion: { resolved: process.versions.node.split('.')[0] },
  dependencies: [{ name: 'vite', type: 'direct', scopes: ['dev'], requested: '8.1.6', resolved: '8.1.6', source: 'registry', sourceUrl: 'https://registry.npmjs.org' }] })
async function providerFixture(t, { manifest = true } = {}) {
  const fx = await fixture(t, { config: canonicalConfig }), metadataPath = join(fx.directory, '.vercel')
  await mkdir(metadataPath); await mkdir(join(metadataPath, 'static-build'))
  const project = { projectId: CI_POLICY.projectId, orgId: 'synthetic_team_only', settings: {
    ...canonicalConfig, rootDirectory: null, nodeVersion: process.versions.node.split('.')[0] + '.x', createdAt: 1, devCommand: null,
  } }
  const projectPath = join(metadataPath, 'project.json'), manifestPath = join(metadataPath, 'static-build', 'package-manifest.json')
  await writeFile(projectPath, JSON.stringify(project))
  if (manifest) await writeFile(manifestPath, JSON.stringify(validManifest()))
  return { ...fx, metadataPath, projectPath, manifestPath, project,
    run: (extra = {}) => fx.run({ environment: providerEnvironment(), ...extra }) }
}

test('observed Vercel project metadata and the single official static manifest are validated without extra Git reads', async t => {
  for (const manifest of [false, true]) await t.test(manifest ? 'strict package manifest' : 'empty manifest staging directory', async t => {
    const fx = await providerFixture(t, { manifest }), before = await fx.run(), after = await fx.run()
    assert.equal(before.fileCount, 5); assert.equal(before.digest, after.digest); assert.equal(fx.calls.length, 10)
    assert.doesNotMatch(JSON.stringify(before), /synthetic_team|registry|package-manifest|buildCommand/)
    await assert.rejects(fx.run({ environment: { ...providerEnvironment(), VERCEL_PROJECT_ID: 'prj_other' } }), { code: 'SOURCE_PROVIDER_CONTEXT_INVALID' })
  })
})

test('Vercel namespace never exempts committed source paths from the canonical tree', async t => {
  for (const path of ['.vercel/project.json', '.vercel/static-build/source.js', '.vercel']) await t.test(path, async t => {
    const fx = await fixture(t, { tracked: [[path, 'committed source cannot be hidden']] })
    await assert.rejects(fx.run({ environment: providerEnvironment() }), { code: 'SOURCE_RESERVED_TRACKED_PATH' })
  })
})

test('provider metadata cannot contain env, output, cache, builders, nested code or unknown files', async t => {
  for (const path of ['.env.production.local', 'output/config.json', 'cache/data', 'builders/package.json', 'README.txt',
    'static-build/script.js', 'static-build/cache/data', 'static-build/.env']) await t.test(path, async t => {
    const fx = await providerFixture(t)
    await mkdir(dirname(join(fx.metadataPath, path)), { recursive: true }); await writeFile(join(fx.metadataPath, path), 'injected provider input')
    await assert.rejects(fx.run(), { code: 'SOURCE_PROVIDER_EXTRA_INPUT' })
  })
})

test('project identities, exact observed settings, closed keys and canonical commands are mandatory', async t => {
  const mutations = [
    value => { value.projectId = 'prj_wrong' }, value => { value.orgId = 'https://wrong.invalid/token' },
    value => { value.projectName = 'unobserved' }, value => { value.settings = [] },
    value => { value.settings.buildCommand = 'execute unverified source' }, value => { value.settings.installCommand = 'npm install' },
    value => { value.settings.outputDirectory = '.vercel/output' }, value => { value.settings.framework = 'other' },
    value => { value.settings.rootDirectory = 'src' }, value => { value.settings.devCommand = 'execute' },
    value => { value.settings.nodeVersion = '0.x' }, value => { value.settings.createdAt = -1 },
    value => { value.settings.vercelFlags = {} }, value => { delete value.settings.framework },
    value => { Object.defineProperty(value, '__proto__', { value: { privateValue: 'do-not-print' }, enumerable: true }) },
    value => { value.settings.constructor = 'do-not-print' },
  ]
  for (const [index, mutate] of mutations.entries()) await t.test(String(index), async t => {
    const fx = await providerFixture(t); mutate(fx.project); await writeFile(fx.projectPath, JSON.stringify(fx.project))
    await assert.rejects(fx.run(), error => error.code === 'SOURCE_PROVIDER_METADATA_INVALID' && !String(error).includes('do-not-print'))
  })
})

test('matching unverified manifest edits cannot authorize provider commands', async t => {
  const fx = await providerFixture(t), injected = { ...canonicalConfig, buildCommand: 'execute unverified source' }
  await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(injected))
  fx.project.settings.buildCommand = injected.buildCommand; await writeFile(fx.projectPath, JSON.stringify(fx.project))
  await assert.rejects(fx.run(), { code: 'SOURCE_CONTENT_MISMATCH' })
})

test('official diagnostics grammar rejects unknown keys, versions, runtimes, nested settings and dependency shapes', async t => {
  const mutations = [
    value => { value.version = 'future' }, value => { value.runtime = 'python' },
    value => { value.framework = 'unknown' }, value => { value.serviceType = 'executable' },
    value => { value.buildType = 'untrusted' }, value => { value.settings = {} },
    value => { value.runtimeVersion.resolved = '0' }, value => { value.runtimeVersion.settings = {} },
    value => { value.runtimeVersion.requestedSource = '../private' }, value => { value.dependencies = {} },
    value => { value.dependencies[0].type = 'script' }, value => { value.dependencies[0].scopes = ['admin'] },
    value => { value.dependencies[0].scopes = ['dev', 'dev'] }, value => { value.dependencies[0].name = '../source' },
    value => { value.dependencies[0].resolved = {} }, value => { value.dependencies[0].source = 'executable' },
    value => { value.dependencies[0].sourceUrl = '\u0000private' }, value => { value.dependencies[0].scripts = { preinstall: 'execute' } },
    value => { value.dependencies.push({ ...value.dependencies[0] }) }, value => { value.dependencies[0].constructor = 'do-not-print' },
  ]
  for (const [index, mutate] of mutations.entries()) await t.test(String(index), async t => {
    const fx = await providerFixture(t), manifest = validManifest(); mutate(manifest); await writeFile(fx.manifestPath, JSON.stringify(manifest))
    await assert.rejects(fx.run(), { code: 'SOURCE_PROVIDER_METADATA_INVALID' })
  })
})

test('metadata bytes affect the proof and oversized or malformed JSON fails closed without disclosure', async t => {
  const fx = await providerFixture(t), before = await fx.run()
  fx.project.settings.createdAt = 2; await writeFile(fx.projectPath, JSON.stringify(fx.project))
  const after = await fx.run(); assert.notEqual(before.digest, after.digest)
  await writeFile(fx.projectPath, '{private malformed JSON')
  await assert.rejects(fx.run(), error => error.code === 'SOURCE_PROVIDER_METADATA_INVALID' && !String(error).includes('private'))
  await writeFile(fx.projectPath, JSON.stringify(fx.project)); await truncate(fx.manifestPath, 1024 * 1024 + 1)
  await assert.rejects(fx.run(), { code: 'SOURCE_PROVIDER_LIMIT_EXCEEDED' })
})

test('metadata changing during final HEAD verification fails its stable readback', async t => {
  const fx = await providerFixture(t); let headReads = 0
  await assert.rejects(fx.run({ spawn(command, args, options) {
    const result = fx.spawn(command, args, options)
    if (args.includes('rev-parse') && ++headReads === 2) {
      writeFileSync(fx.projectPath, JSON.stringify({ ...fx.project, settings: { ...fx.project.settings, createdAt: 3 } }))
    }
    return result
  } }), { code: 'SOURCE_CHANGED' })
})

const routedConfig = () => ({ ...canonicalConfig,
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] }],
  rewrites: [{ source: '/one', destination: '/one.html' }, { source: '/two', destination: '/two.html' }],
  redirects: [{ source: '/old', destination: '/new', permanent: true }],
  functions: { 'api/seo.ts': { includeFiles: 'dist/index.html', maxDuration: 60 } },
})

test('only root vercel.json can accept formatting and object-key ordering equivalent to its verified Git blob', async t => {
  const config = routedConfig(), fx = await fixture(t, { config }), exact = await fx.run()
  const reordered = Object.fromEntries(Object.entries(config).reverse())
  await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(reordered, null, 2).replaceAll('\n', '\r\n') + '\r\n')
  const formatted = await fx.run(), repeated = await fx.run()
  assert.notEqual(exact.digest, formatted.digest); assert.equal(formatted.digest, repeated.digest)
  assert.equal(formatted.fileCount, 5); assert.equal(fx.calls.length, 17)
  assert.equal(fx.calls.filter(({ args }) => args.includes('blob')).length, 2)
})

test('format-only config still authorizes provider metadata against canonical Git values', async t => {
  const fx = await providerFixture(t)
  await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(canonicalConfig, null, 2) + '\n')
  assert.equal((await fx.run()).fileCount, 5); assert.equal(fx.calls.length, 6)
})

test('the complete actual project configuration accepts only representation changes and retains security/routing values', async t => {
  const bytes = await readFile(new URL('../../vercel.json', import.meta.url)), actual = JSON.parse(bytes.toString('utf8'))
  const fx = await fixture(t, { configBytes: bytes }), first = await fx.run()
  const reordered = Object.fromEntries(Object.entries(actual).reverse())
  const formatted = JSON.stringify(reordered, null, 4).replaceAll('\n', '\r\n').replace('nosniff', 'no\\u0073niff') + '\r\n'
  await writeFile(join(fx.directory, 'vercel.json'), formatted)
  const after = await fx.run()
  assert.equal(after.fileCount, first.fileCount); assert.notEqual(after.digest, first.digest); assert.equal(fx.calls.length, 11)
  for (const [name, mutate] of [
    ['header', value => { value.headers[0].headers[0].value += ' changed' }],
    ['rewrite array', value => { value.rewrites.reverse() }],
    ['node command', value => { value.buildCommand += ' && node unexpected.mjs' }],
    ['security encoding', value => { const row = value.headers.flatMap(item => item.headers).find(item => item.value === 'nosniff'); assert.ok(row); row.value = 'nosn\u0131ff' }],
  ]) await t.test(name, async t => {
    const fx = await fixture(t, { configBytes: bytes }), changed = structuredClone(actual); mutate(changed)
    await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(changed))
    await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH' && error.sourcePath === 'vercel.json')
  })
})

test('formatting equivalence never applies to package.json or other source files', async t => {
  const fx = await fixture(t)
  await writeFile(join(fx.directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n')
  await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH' && error.sourcePath === 'package.json')
  assert.equal(fx.calls.filter(({ args }) => args.includes('blob')).length, 0)
})

test('changes to any config values, keys, headers, routes, array order or function settings remain forbidden', async t => {
  const mutations = [
    value => { value.buildCommand = 'different command' }, value => { value.installCommand = 'different install' },
    value => { value.framework = 'other' }, value => { value.outputDirectory = 'other' },
    value => { value.headers[0].headers[0].value = 'SAMEORIGIN' }, value => { value.headers[0].headers.reverse() },
    value => { value.rewrites.reverse() }, value => { value.rewrites[0].destination = '/different.html' },
    value => { value.redirects[0].permanent = false }, value => { value.redirects[0].permanent = 'true' },
    value => { value.functions['api/seo.ts'].maxDuration = 61 }, value => { value.functions['api/seo.ts'].includeFiles = '**' },
    value => { value.providerDefault = true }, value => { delete value.headers }, value => { value.headers = null },
  ]
  for (const [index, mutate] of mutations.entries()) await t.test(String(index), async t => {
    const config = routedConfig(), fx = await fixture(t, { config }); mutate(config)
    await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(config, null, 2))
    await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH' && error.sourcePath === 'vercel.json')
  })
})

test('unchecked or forged canonical config blobs cannot authorize the format exception', async t => {
  const fx = await fixture(t, { config: canonicalConfig })
  await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify(canonicalConfig, null, 2))
  await assert.rejects(fx.run({ spawn(command, args, options) {
    const result = fx.spawn(command, args, options)
    if (args.includes('blob')) result.stdout = Buffer.from(JSON.stringify(canonicalConfig, null, 2))
    return result
  } }), error => error.code === 'SOURCE_CONTENT_MISMATCH' && error.sourcePath === 'vercel.json')
})

test('config rejection reports immutable fixed public key names and only a count of unknown keys, never values', async t => {
  const fx = await fixture(t, { config: canonicalConfig }), privateKey = 'PRIVATE_UNKNOWN_KEY_7b12', privateValue = 'PRIVATE_CONFIG_VALUE_9fa3'
  await writeFile(join(fx.directory, 'vercel.json'), JSON.stringify({ ...canonicalConfig,
    headers: [{ source: '/', headers: [{ key: 'Private', value: privateValue }] }], env: { KEY: privateValue }, [privateKey]: privateValue }))
  await assert.rejects(fx.run(), error => {
    assert.equal(error.code, 'SOURCE_CONTENT_MISMATCH'); assert.equal(error.sourcePath, 'vercel.json')
    assert.deepEqual(error.configurationChangedKeys, ['headers', 'env']); assert.equal(error.configurationUnknownKeyCount, 1)
    assert.equal(Object.isFrozen(error.configurationChangedKeys), true)
    for (const key of ['configurationChangedKeys', 'configurationUnknownKeyCount']) {
      assert.equal(Object.hasOwn(error, key), true)
      const descriptor = Object.getOwnPropertyDescriptor(error, key)
      assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false)
    }
    assert.equal(JSON.stringify(error).includes(privateKey), false); assert.equal(JSON.stringify(error).includes(privateValue), false)
    assert.equal(String(error).includes(privateKey), false); assert.equal(String(error).includes(privateValue), false)
    return true
  })
})

test('invalid or unauthenticated config does not receive invented key-difference diagnostics', async t => {
  const fx = await fixture(t, { config: canonicalConfig })
  await writeFile(join(fx.directory, 'vercel.json'), '{invalid private JSON')
  await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH'
    && !Object.hasOwn(error, 'configurationChangedKeys') && !Object.hasOwn(error, 'configurationUnknownKeyCount'))
})

test('ambiguous or invalid JSON never becomes formatting equivalence', async t => {
  const canonical = JSON.stringify(canonicalConfig)
  const invalid = [canonical.slice(0, -1) + ',"framework":"vite"}', canonical.slice(0, -1) + ',"\\u0066ramework":"vite"}', canonical + ' trailing', canonical.replace('{', '{/*comment*/'),
    canonical.slice(0, -1) + ',}', canonical.slice(0, -1) + ',"number":9007199254740993}', canonical.slice(0, -1) + ',"number":1e400}',
    canonical.replace('"vite"', '"private\u0000sentinel"')]
  for (const [index, text] of invalid.entries()) await t.test(String(index), async t => {
    const fx = await fixture(t, { config: canonicalConfig }); await writeFile(join(fx.directory, 'vercel.json'), text)
    await assert.rejects(fx.run(), error => error.code === 'SOURCE_CONTENT_MISMATCH' && error.sourcePath === 'vercel.json'
      && !JSON.stringify(error).includes('sentinel'))
  })
})
