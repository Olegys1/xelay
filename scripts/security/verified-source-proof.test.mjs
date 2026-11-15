// Real temporary filesystem, canonical Git objects, injected read-only Git I/O.
// Every scenario runs under the mandatory offline subprocess/network guard.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { assertSourceTree, assertSourceEntry, SourceIntegrityError } from '../security-ci/source-proof.mjs'

const hash = (kind, data) => createHash('sha1').update(`${kind} ${data.length}\0`).update(data).digest('hex')
async function fixture(t) {
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
    await assert.rejects(fx.run(), { code: 'SOURCE_EXTRA_INPUT' })
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
