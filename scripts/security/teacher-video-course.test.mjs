import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const source = read('src/lib/teacherVideoGuides.ts')
const module = { exports: {} }
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, encodeURIComponent, Set,
  require(path) { assert.match(path, /^\.\.\/assets\/guides\/teacher-course-20261104\/0[1-6]\.(mp4|webp)$/); return { __esModule: true, default: path } },
})
const api = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
function storage() { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data } }

test('six ordered lessons and every update point to actual teacher manual sections', () => {
  const manual = JSON.parse(read('public/guides/data/teacher.json'))
  const ids = new Set(manual.sections.map(section => section.id))
  assert.equal(api.TEACHER_VIDEO_GUIDES.length, 6)
  assert.equal(new Set(api.TEACHER_VIDEO_GUIDES.map(guide => guide.id)).size, 6)
  api.TEACHER_VIDEO_GUIDES.forEach((guide, index) => {
    assert.ok(ids.has(guide.manualId), guide.manualId)
    assert.ok(guide.videoUrl.includes(`0${index + 1}.mp4`))
    assert.ok(guide.posterUrl.includes(`0${index + 1}.webp`))
    assert.ok(guide.durationSeconds > 0 && guide.steps.length >= 3)
  })
  api.TEACHER_GUIDE_UPDATES.forEach(update => assert.ok(ids.has(update.manualId), update.manualId))
})

test('progress is account scoped, bounded and ignores unknown catalogue entries', () => {
  const memory = storage(), id = api.TEACHER_VIDEO_GUIDES[0].id
  assert.equal(api.saveTeacherGuideProgress(memory, 'teacher A', { completed: [id, id, 'unknown'], lastLesson: id }), true)
  assert.deepEqual(plain(api.readTeacherGuideProgress(memory, 'teacher A')), { completed: [id], lastLesson: id })
  assert.deepEqual(plain(api.readTeacherGuideProgress(memory, 'teacher B')), { completed: [], lastLesson: null })
  assert.equal(api.saveTeacherGuideProgress(memory, '', { completed: [id], lastLesson: id }), false)
  assert.equal(api.readTeacherGuideProgress({ getItem: () => 'x'.repeat(5000) }, 'A').completed.length, 0)
  assert.equal(api.readTeacherGuideProgress({ getItem: () => '{broken' }, 'A').completed.length, 0)
  assert.equal(api.readTeacherGuideProgress({ getItem: () => '{"completed":[null,4,"unknown"],"lastLesson":"javascript:alert(1)"}' }, 'A').lastLesson, null)
})

test('blocked browser storage leaves viewing available and reports failure honestly', () => {
  const blocked = { getItem() { throw Error('Blocked') }, setItem() { throw Error('Blocked') } }
  assert.deepEqual(plain(api.readTeacherGuideProgress(blocked, 'A')), { completed: [], lastLesson: null })
  assert.equal(api.saveTeacherGuideProgress(blocked, 'A', { completed: [], lastLesson: null }), false)
  assert.equal(api.saveTeacherGuideProgress(undefined, 'A', { completed: [], lastLesson: null }), false)
  assert.equal(api.teacherGuideManualUrl('<script>'), '/guides/#teacher/%3Cscript%3E')
})

test('course media waits for an explicit play and does not fetch six videos on opening a tab', () => {
  const ui = read('src/components/teaching/TeachingVideoGuides.tsx')
  assert.equal((ui.match(/<video\b/g) || []).length, 1)
  assert.match(ui, /playing \? <video/)
  assert.match(ui, /preload="none"/)
  assert.match(ui, /onEnded=\{markDone\}/)
  assert.match(ui, /setPlaying\(false\)/)
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|fetch\(|supabase|innerHTML/)
  const workspace = read('src/components/teaching/TeachingWorkspace.tsx')
  assert.match(workspace, /lazy\(\(\) => import\('\.\/TeachingVideoGuides'\)\)/)
  assert.match(workspace, /<TeachingVideoGuides key=\{userId\}/)
  assert.match(workspace, /workspaceView === 'guides'/)
})

test('all prepared videos and posters exist with realistic file sizes', () => {
  for (let index = 1; index <= 6; index++) {
    const base = `src/assets/guides/teacher-course-20261104/0${index}`
    const size = statSync(new URL(`${base}.mp4`, root)).size
    assert.ok(size > 100000 && size < 25 * 1024 * 1024)
    assert.ok(statSync(new URL(`${base}.webp`, root)).size > 1000)
    const video = readFileSync(new URL(`${base}.mp4`, root))
    assert.ok(video.includes(Buffer.from('avc1')) && video.includes(Buffer.from('mp4a')))
    assert.ok(video.indexOf(Buffer.from('moov')) < video.indexOf(Buffer.from('mdat')))
  }
})
