import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

// Only these exact root directories are generated outside the source tree.
// An ignored file anywhere else is still an input and must match the commit.
const GENERATED_ROOTS = new Set(['.git', 'node_modules', 'dist', 'dist-ssr', '.security-ci.local'])
const MAX_FILES = 10_000, MAX_ENTRIES = 20_000, MAX_BYTES = 256 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_GIT_BYTES = 4 * 1024 * 1024
const MAX_COMMIT_BYTES = 1024 * 1024, MAX_TIME_MS = 30_000
const SHA = /^[a-f0-9]{40}$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class SourceIntegrityError extends Error {
  constructor(code) {
    super(`Source integrity rejected (${code}).`)
    this.name = 'SourceIntegrityError'
    this.code = code
  }
}
const fail = code => { throw new SourceIntegrityError(code) }
const objectHash = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex')
const decode = bytes => { try { return utf8.decode(bytes) } catch { fail('SOURCE_INVALID_PATH') } }
const safePath = path => typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 2048
  && !isAbsolute(path) && !/[\\\x00-\x1f\x7f:]/.test(path)
  && !path.split('/').some(part => !part || part === '.' || part === '..')

function gitEnvironment(source) {
  const env = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (typeof source?.[key] === 'string') env[key] = source[key]
  }
  return env
}

function sameState(a, b) {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
function sameDirectory(a, b) {
  return a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

// Kept independently testable on Windows hosts that cannot create symlinks.
export function assertSourceEntry(info) {
  if (!info || typeof info.isSymbolicLink !== 'function' || typeof info.isFile !== 'function' || typeof info.isDirectory !== 'function') fail('SOURCE_NOT_REGULAR_FILE')
  if (info.isSymbolicLink()) fail('SOURCE_SYMLINK')
  if (!info.isFile() && !info.isDirectory()) fail('SOURCE_NOT_REGULAR_FILE')
}

/** Read-only, index-independent proof of actual build inputs against a SHA1 commit. */
export async function assertSourceTree({ directory, expectedSha, spawn = spawnSync, environment = process.env } = {}) {
  if (typeof directory !== 'string' || !directory || !SHA.test(expectedSha ?? '') || typeof spawn !== 'function') fail('SOURCE_INVALID_INPUT')
  const started = Date.now()
  const budget = () => { if (Date.now() - started > MAX_TIME_MS) fail('SOURCE_LIMIT_EXCEEDED') }
  try {
    const requested = resolve(directory)
    const rootInfo = await lstat(requested)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('SOURCE_ROOT_INVALID')
    const root = await realpath(requested), gitDirectory = join(root, '.git')
    const gitInfo = await lstat(gitDirectory)
    if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) fail('SOURCE_GIT_DIRECTORY_INVALID')
    const prefix = ['--no-replace-objects', '--literal-pathspecs', `--git-dir=${gitDirectory}`, `--work-tree=${root}`,
      '-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.preloadIndex=false', '-c', 'core.ignoreStat=false', '-c', 'core.sparseCheckout=false', '-c', 'core.useReplaceRefs=false']
    const git = (args, input) => {
      budget()
      const result = spawn('git', [...prefix, ...args], { cwd: root, shell: false, windowsHide: true,
        env: gitEnvironment(environment), timeout: 3000, maxBuffer: MAX_GIT_BYTES, encoding: 'buffer', ...(input === undefined ? {} : { input }) })
      if (result?.error || result?.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > MAX_GIT_BYTES) fail('SOURCE_GIT_UNAVAILABLE')
      return result.stdout
    }
    const head = decode(git(['rev-parse', '--verify', 'HEAD'])).trim()
    if (head !== expectedSha) fail('SOURCE_HEAD_MISMATCH')
    const commit = git(['cat-file', 'commit', expectedSha])
    if (commit.length > MAX_COMMIT_BYTES || objectHash('commit', commit) !== expectedSha) fail('SOURCE_COMMIT_MISMATCH')
    const treeLine = /^tree ([a-f0-9]{40})\n/.exec(decode(commit))
    if (!treeLine) fail('SOURCE_COMMIT_MISMATCH')
    const files = new Map(), directories = new Set(), treeIds = new Set([treeLine[1]])
    const records = decode(git(['ls-tree', '-r', '-t', '-z', '--full-tree', expectedSha])).split('\0')
    if (records.pop() !== '') fail('SOURCE_TREE_INVALID')
    if (records.length > MAX_ENTRIES) fail('SOURCE_LIMIT_EXCEEDED')
    const seen = new Set()
    for (const record of records) {
      const match = /^(040000|100644|100755) (tree|blob) ([a-f0-9]{40})\t(.+)$/.exec(record)
      if (!match || !safePath(match[4]) || seen.has(match[4])) fail('SOURCE_TREE_INVALID')
      const [, mode, type, hash, path] = match
      if (GENERATED_ROOTS.has(path.split('/')[0])) fail('SOURCE_RESERVED_TRACKED_PATH')
      seen.add(path)
      if (type === 'tree' && mode === '040000') { directories.add(path); treeIds.add(hash) }
      else if (type === 'blob' && mode !== '040000') files.set(path, { hash, mode })
      else fail('SOURCE_TREE_INVALID')
    }
    if (!files.size || files.size > MAX_FILES) fail('SOURCE_LIMIT_EXCEEDED')
    // Git's loose-object reader does not itself establish that a local object's
    // bytes hash to its filename. Validate every tree linked from the commit.
    const batch = git(['cat-file', '--batch'], Buffer.from([...treeIds].join('\n') + '\n'))
    let offset = 0
    for (const hash of treeIds) {
      const end = batch.indexOf(10, offset)
      if (end < 0) fail('SOURCE_TREE_INVALID')
      const header = /^([a-f0-9]{40}) tree (0|[1-9]\d*)$/.exec(decode(batch.subarray(offset, end)))
      if (!header || header[1] !== hash) fail('SOURCE_TREE_INVALID')
      const size = Number(header[2])
      offset = end + 1
      if (!Number.isSafeInteger(size) || size > MAX_GIT_BYTES || offset + size >= batch.length) fail('SOURCE_TREE_INVALID')
      if (objectHash('tree', batch.subarray(offset, offset + size)) !== hash || batch[offset + size] !== 10) fail('SOURCE_TREE_MISMATCH')
      offset += size + 1
    }
    if (offset !== batch.length) fail('SOURCE_TREE_INVALID')
    let count = 0, entries = 0, totalBytes = 0
    const digest = createHash('sha256').update(`xelay-source-v1\0${expectedSha}\0`)
    async function readTracked(path, filename, before, expected) {
      if (!before.isFile() || before.isSymbolicLink()) fail('SOURCE_NOT_REGULAR_FILE')
      if (before.size > MAX_FILE_BYTES || totalBytes + before.size > MAX_BYTES) fail('SOURCE_LIMIT_EXCEEDED')
      if (process.platform !== 'win32' && Boolean(before.mode & 0o111) !== (expected.mode === '100755')) fail('SOURCE_MODE_MISMATCH')
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!sameState(before, await handle.stat())) fail('SOURCE_CHANGED')
        const hash = createHash('sha1').update(`blob ${before.size}\0`), buffer = Buffer.allocUnsafe(64 * 1024)
        let bytes = 0
        for (;;) {
          budget()
          const result = await handle.read(buffer, 0, buffer.length, null)
          if (!result.bytesRead) break
          bytes += result.bytesRead
          if (bytes > before.size || bytes > MAX_FILE_BYTES) fail('SOURCE_CHANGED')
          hash.update(buffer.subarray(0, result.bytesRead))
        }
        if (bytes !== before.size || !sameState(before, await handle.stat()) || !sameState(before, await lstat(filename))) fail('SOURCE_CHANGED')
        if (hash.digest('hex') !== expected.hash) fail('SOURCE_CONTENT_MISMATCH')
        count++; totalBytes += bytes
        digest.update(path).update('\0').update(expected.mode).update('\0').update(expected.hash).update('\0')
      } finally { await handle.close() }
    }
    async function walk(parent, relative = '', priorInfo) {
      budget()
      const before = await lstat(parent)
      if (before.isSymbolicLink() || !before.isDirectory() || priorInfo && !sameDirectory(priorInfo, before)) fail('SOURCE_CHANGED')
      const names = (await readdir(parent, { encoding: 'buffer' })).map(decode).sort()
      for (const name of names) {
        budget()
        if (++entries > MAX_ENTRIES) fail('SOURCE_LIMIT_EXCEEDED')
        const path = relative ? `${relative}/${name}` : name
        if (!safePath(path)) fail('SOURCE_INVALID_PATH')
        const filename = join(parent, name), info = await lstat(filename)
        assertSourceEntry(info)
        if (!relative && GENERATED_ROOTS.has(name)) {
          if (!info.isDirectory()) fail('SOURCE_GENERATED_DIRECTORY_INVALID')
          continue
        }
        if (info.isDirectory()) {
          if (!directories.has(path)) fail('SOURCE_EXTRA_INPUT')
          await walk(filename, path, info)
        } else {
          const expected = files.get(path)
          if (!expected) fail('SOURCE_EXTRA_INPUT')
          await readTracked(path, filename, info, expected)
        }
      }
      if (!sameDirectory(before, await lstat(parent))) fail('SOURCE_CHANGED')
    }
    await walk(root)
    if (count !== files.size) fail('SOURCE_MISSING_INPUT')
    if (decode(git(['rev-parse', '--verify', 'HEAD'])).trim() !== expectedSha) fail('SOURCE_CHANGED')
    budget()
    return Object.freeze({ sha: expectedSha, digest: digest.digest('hex'), fileCount: count, totalBytes })
  } catch (error) {
    if (error instanceof SourceIntegrityError) throw error
    fail('SOURCE_UNAVAILABLE')
  }
}
