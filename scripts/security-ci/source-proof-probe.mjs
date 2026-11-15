// Explicit local diagnostic only. Creates/removes only its own temporary Git
// fixture, never builds the application or contacts a provider.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSourceTree } from './source-proof.mjs'

export async function probeRealGitSourceProof() {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, 'xelay-source-proof-probe-'))
  const env = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull, GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0' }
  const git = args => {
    const result = spawnSync('git', ['-c', 'safe.directory=' + directory.replaceAll('\\', '/'), ...args], {
      cwd: directory, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('LOCAL_FIXTURE_GIT_FAILED')
    return result.stdout.trim()
  }
  const results = []
  const pass = name => { results.push({ name, passed: true }) }
  try {
    git(['init', '-q']); git(['config', 'core.autocrlf', 'false'])
    git(['config', 'user.name', 'Synthetic source proof']); git(['config', 'user.email', 'fixture@example.invalid'])
    await mkdir(join(directory, 'src')); await mkdir(join(directory, 'public'))
    await writeFile(join(directory, '.gitignore'), '.env*\n*.local\nnode_modules\ndist\n')
    await writeFile(join(directory, 'src', 'app.js'), 'export const safe = true\n')
    await writeFile(join(directory, 'public', 'seed.txt'), 'fixture\n')
    git(['add', '--all']); git(['commit', '-qm', 'Synthetic fixture'])
    const expectedSha = git(['rev-parse', 'HEAD']), options = { directory, expectedSha }
    const original = await readFile(join(directory, 'src', 'app.js'))
    await assertSourceTree(options); pass('clean real Git checkout')
    const reject = async (name, code) => {
      try { await assertSourceTree(options) } catch (error) { if (error.code === code) { pass(name); return } throw error }
      throw new Error('LOCAL_FIXTURE_ACCEPTED_UNSAFE_SOURCE')
    }
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      git(['update-index', flag, 'src/app.js'])
      await writeFile(join(directory, 'src', 'app.js'), 'export const safe = false\n')
      if (git(['status', '--porcelain'])) throw new Error('LOCAL_FIXTURE_INDEX_FLAG_NOT_HIDDEN')
      await reject(flag + ' does not hide changed bytes', 'SOURCE_CONTENT_MISMATCH')
      await writeFile(join(directory, 'src', 'app.js'), original)
      git(['update-index', flag === '--assume-unchanged' ? '--no-assume-unchanged' : '--no-skip-worktree', 'src/app.js'])
    }
    for (const path of ['.env.production', 'public/injected.local']) {
      await writeFile(join(directory, path), 'synthetic injection')
      if (git(['status', '--porcelain'])) throw new Error('LOCAL_FIXTURE_IGNORED_FILE_NOT_HIDDEN')
      await reject(path + ' cannot enter source proof', 'SOURCE_EXTRA_INPUT')
      await rm(join(directory, path))
    }
    git(['config', 'core.worktree', join(directory, '.git')])
    await assertSourceTree(options); pass('explicit worktree overrides local core.worktree')
    await writeFile(join(directory, 'src', 'app.js'), 'hidden by local worktree config\n')
    await reject('local core.worktree cannot substitute source', 'SOURCE_CONTENT_MISMATCH')
    git(['config', '--unset', 'core.worktree']); await writeFile(join(directory, 'src', 'app.js'), original)
    await writeFile(join(directory, 'src', 'app.js'), 'replacement tree\n')
    git(['add', '--all']); git(['commit', '-qm', 'Synthetic replacement'])
    const replacement = git(['rev-parse', 'HEAD'])
    git(['replace', expectedSha, replacement]); git(['update-ref', 'HEAD', expectedSha])
    await reject('Git replacement cannot authorize a different tree', 'SOURCE_CONTENT_MISMATCH')
    git(['replace', '-d', expectedSha]); await writeFile(join(directory, 'src', 'app.js'), original)
    await assertSourceTree(options); pass('index state does not replace actual canonical files')
    return Object.freeze({ state: 'passed', scenarios: results.length, results })
  } finally {
    if (dirname(directory) !== parent || !/^xelay-source-proof-probe-/.test(basename(directory))) throw new Error('LOCAL_FIXTURE_CLEANUP_REFUSED')
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run-local-fixtures') { console.error('Explicit --run-local-fixtures is required.'); process.exitCode = 1 }
  else probeRealGitSourceProof().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Local source-proof diagnostic failed.'); process.exitCode = 1 })
}
