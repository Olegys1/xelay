import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const video = '/assets/study-group-guide-20261017-test.mp4'
const poster = '/assets/study-group-guide-20261017-test.webp'
function load(source, imports) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, URL, require(name) {
    if (name in imports) return imports[name]
    assert.ok(['react', 'react/jsx-runtime', 'lucide-react'].includes(name), name)
    return require(name)
  } })
  return module.exports
}
const guides = load(await read('src/lib/studyGroupVideoGuides.ts'), {
  '../assets/guides/study-group-guide-20261017.mp4': { __esModule: true, default: video },
  '../assets/guides/study-group-guide-20261017.webp': { __esModule: true, default: poster },
})
const context = { groupId: 'group-a', loadedGroupId: 'group-a', userId: 'head', representativeId: 'head', approvedDeputyIds: ['deputy'] }

test('guides are available to the representative and accepted appointed deputies', () => {
  assert.equal(guides.canViewStudyGroupVideoGuides(context), true)
  assert.equal(guides.canViewStudyGroupVideoGuides({ ...context, userId: 'deputy', memberStatus: 'accepted' }), true)
  for (const memberStatus of ['pending', 'rejected', 'removed', undefined])
    assert.equal(guides.canViewStudyGroupVideoGuides({ ...context, userId: 'deputy', memberStatus }), false)
  assert.equal(guides.canViewStudyGroupVideoGuides({ ...context, userId: 'member', memberStatus: 'accepted' }), false)
  assert.equal(guides.canViewStudyGroupVideoGuides({ ...context, userId: 'deputy', memberStatus: 'accepted', approvedDeputyIds: [] }), false)
})

test('missing authentication and stale or different group data do not expose the guides tab', () => {
  for (const change of [{ userId: undefined }, { userId: '' }, { groupId: '' }, { loadedGroupId: undefined }, { loadedGroupId: 'other-group' }])
    assert.equal(guides.canViewStudyGroupVideoGuides({ ...context, ...change }), false)
})

test('catalogue contains the supplied guide and only safe first-party media references', () => {
  assert.equal(guides.STUDY_GROUP_VIDEO_GUIDES.length, 1)
  assert.equal(guides.STUDY_GROUP_VIDEO_GUIDES[0].videoUrl, video)
  assert.equal(guides.STUDY_GROUP_VIDEO_GUIDES[0].posterUrl, poster)
  assert.match(guides.STUDY_GROUP_VIDEO_GUIDES[0].description, /6 хв 13 с/)
  for (const url of [video, poster, 'https://example.test/video.mp4']) assert.ok(guides.safeStudyGroupGuideMediaUrl(url))
  for (const url of [null, '', '//example.test/video.mp4', 'javascript:alert(1)', 'http://example.test/video.mp4', '/bad\\path', 'https://user:pass@example.test/video.mp4'])
    assert.equal(guides.safeStudyGroupGuideMediaUrl(url), null)
})

test('real guide component renders an on-demand inline player and deputy-appropriate shortcuts', async () => {
  const { createElement } = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const { StudyGroupVideoGuides } = load(await read('src/components/StudyGroupVideoGuides.tsx'), { '../lib/studyGroupVideoGuides': guides })
  for (const canManageDeputies of [true, false]) {
    const html = renderToStaticMarkup(createElement(StudyGroupVideoGuides, { onNavigate() {}, canManageDeputies }))
    assert.match(html, /Відеогайди для старост і заступників/)
    assert.match(html, /<video[^>]*controls=""[^>]*playsInline=""[^>]*preload="none"/)
    assert.ok(html.includes(`src="${video}"`))
    assert.ok(html.includes(`poster="${poster}"`))
    assert.equal(html.includes('Призначити заступників'), canManageDeputies)
    assert.ok(!html.includes('autoPlay'))
    assert.ok(!html.includes('lg:grid-cols-2'))
    assert.ok(!html.includes('Відео готуємо'))
  }
})

test('group page uses current membership for guide access and does not grant editing permissions', async () => {
  const page = await read('src/pages/StudyGroupsPage.tsx')
  assert.match(page, /const canViewGuides = canViewStudyGroupVideoGuides\(\{/)
  assert.match(page, /memberStatus: members\.find\(\(member\) => member\.user_id === authUser\?\.id\)\?\.status, approvedDeputyIds/)
  assert.match(page, /<StudyGroupVideoGuides onNavigate=\{openGroupSection\} canManageDeputies=\{isRepresentative\}/)
  assert.match(page, /const canEditHomework = groupCanEdit && hasContentPermission\('homework'\)/)
  assert.match(await read('src/components/StudyGroupGuide.tsx'), /if \(leader \|\| deputy\) steps\.push\(\{ id: 'guides'/)
})

test('published MP4 stays compact and has its playback index before video data', async () => {
  const path = new URL('src/assets/guides/study-group-guide-20261017.mp4', root)
  assert.ok((await stat(path)).size < 25_000_000)
  const bytes = await readFile(path)
  let position = 0
  const atoms = []
  while (position + 8 <= bytes.length) {
    let length = bytes.readUInt32BE(position)
    const type = bytes.toString('ascii', position + 4, position + 8)
    if (length === 1) length = Number(bytes.readBigUInt64BE(position + 8))
    if (!length) length = bytes.length - position
    assert.ok(length >= 8 && position + length <= bytes.length)
    atoms.push(type)
    position += length
  }
  assert.ok(atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'))
  assert.ok(bytes.includes(Buffer.from('avc1')))
  assert.ok(bytes.includes(Buffer.from('mp4a')))
})
