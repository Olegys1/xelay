import { spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_ONLY_FILES, TASK_FILES, safeEnvironment } from './policy.mjs'

export const repository = fileURLToPath(new URL('../../', import.meta.url))

export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') &&
    !path.split('/').some(part => part === '..' || part === '.' || part === '') && !/[\x00-\x1f:]/.test(path)
}

export function inventoryPaths(tracked, existingTaskFiles = []) {
  for (const path of tracked) if (!safePath(path)) throw new Error('Unsafe tracked path')
  for (const path of existingTaskFiles) if (!TASK_FILES.includes(path)) throw new Error('Untracked path is outside the security task allowlist')
  const paths = [...new Set([...tracked, ...existingTaskFiles])]
  if (paths.some(path => /(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith('.example'))) {
    throw new Error('Tracked dotenv file is not permitted; remove credentials from repository history before release')
  }
  return paths.sort()
}

export async function selectedPaths(root = repository) {
  // HEAD membership, current working contents: validate the proposed change,
  // while never discovering untracked tests or dotenv files by a disk glob.
  const result = spawnSync('git', ['-c', `safe.directory=${resolve(root).replaceAll('\\', '/')}`, 'ls-tree', '-rz', '--name-only', 'HEAD'], {
    cwd: root, encoding: 'utf8', shell: false, env: safeEnvironment(tmpdir()), maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0 || result.error) throw new Error('Could not read tracked HEAD inventory')
  const tracked = result.stdout.split('\0').filter(Boolean)
  const existingTaskFiles = []
  for (const path of TASK_FILES) {
    try { await lstat(join(root, path)); existingTaskFiles.push(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return inventoryPaths(tracked, existingTaskFiles)
}

export async function createSnapshot({ root = repository, dependencies = true } = {}) {
  const paths = await selectedPaths(root)
  // A child directory resolves the existing parent's node_modules naturally.
  // This avoids junction/symlink privileges on Windows and avoids dependency
  // copies or installs. *.local is already ignored by this repository.
  const parent = dependencies ? join(root, '.security-ci.local') : tmpdir()
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'xelay-security-ci-'))
  try {
    for (const path of paths) {
      if (!safePath(path)) throw new Error('Unsafe task allowlist path')
      // Symlinks can escape the snapshot; fail closed rather than follow one.
      const source = join(root, path), info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Snapshot requires a regular file: ${path}`)
      const target = join(directory, path)
      await mkdir(dirname(target), { recursive: true })
      if (BASELINE_ONLY_FILES.includes(path)) {
        const blob = spawnSync('git', ['-c', `safe.directory=${resolve(root).replaceAll('\\', '/')}`, 'show', `HEAD:${path}`], { cwd: root, shell: false, env: safeEnvironment(directory), maxBuffer: 8 * 1024 * 1024 })
        if (blob.status !== 0 || blob.error) throw new Error(`Could not read baseline file: ${path}`)
        await writeFile(target, blob.stdout)
      } else await copyFile(source, target)
    }
    if (dependencies) {
      const modules = resolve(root, 'node_modules')
      if (!(await lstat(modules)).isDirectory()) throw new Error('Install the existing lockfile dependencies first')
    }
    return { directory, paths, dispose: () => disposeSnapshot(directory, parent) }
  } catch (error) { await disposeSnapshot(directory, parent); throw error }
}

export async function disposeSnapshot(directory, parent = tmpdir()) {
  const relativePath = relative(resolve(parent), resolve(directory))
  if (!relativePath.startsWith('xelay-security-ci-') || relativePath.includes(sep) || isAbsolute(relativePath)) throw new Error('Refusing to remove an unexpected snapshot path')
  await rm(directory, { recursive: true, force: true })
}
