import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const nativeRequire = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const cache = new Map()
let coachProps

// Render the real dashboard, selectors, safe conference normalization and icons.
// Only DOM-dependent coach mounting and CSS are omitted from this SSR fixture.
function load(relativePath) {
  const path = resolve(root, relativePath)
  if (cache.has(path)) return cache.get(path).exports
  const module = { exports: {} }
  cache.set(path, module)
  const source = readFileSync(path, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { module, exports: module.exports, URL, require(id) {
    if (id.endsWith('.css')) return {}
    if (id === './HomeGuideCoach') return { HomeGuideCoach(props) { coachProps = props; return null } }
    if (!id.startsWith('.')) return nativeRequire(id)
    const target = resolve(dirname(path), id)
    const extension = id.endsWith('HomeIcons') ? '.tsx' : '.ts'
    return load(target + extension)
  } }, { filename: path })
  return module.exports
}

const { HomeDashboard } = load('src/components/home/HomeDashboard.tsx')
const noop = () => {}
const guide = { available: true, open: false, step: 0, showOffer: true, start: noop, setStep: noop, pause: noop, finish: noop }
const group = { id: 'synthetic-group', name: 'Synthetic group', program: 'Synthetic programme', studyYear: 1, academicYear: '2026/2027', status: 'accepted', learning: true, teachingSubjectIds: ['synthetic-subject'], gradingSubjectIds: ['synthetic-subject'], permissions: ['schedule', 'homework', 'materials', 'members', 'assignments', 'grades'] }
const internalHref = '/groups/synthetic-group?tab=schedule'

function fixture(options = {}) {
  const { conference, role = 'student', groups = [group], status = 'ready' } = options
  const onJoinLesson = Object.hasOwn(options, 'onJoinLesson') ? options.onJoinLesson : noop
  const data = { role, displayName: 'Synthetic person', initials: 'SP', clockIso: '2026-10-29T10:00:00+02:00', contexts: role === 'teacher' ? ['teaching'] : ['learning'], teachingVerified: role === 'teacher', status, participantCount: 0, groups,
    lessons: [{ id: 'synthetic-lesson', groupId: group.id, subjectId: 'synthetic-subject', subject: 'Synthetic subject', context: role === 'teacher' ? 'teaching' : 'learning', date: '2026-10-29', startsAt: '09:40', endsAt: '11:00', type: 'Лекція', href: internalHref, conference }], tasks: [], updates: [], publications: [], community: [], news: [] }
  coachProps = undefined
  const html = renderToStaticMarkup(React.createElement(HomeDashboard, { data, onJoinLesson, homeGuide: guide }))
  const joinTags = [...html.matchAll(/<(a|button)\b([^>]*\bdata-home-guide="join"[^>]*)>/g)]
  return { html, joinTags, coach: coachProps }
}

test('the real homepage emits a native external meeting link, never the internal group destination', () => {
  const href = 'https://zoom.us/j/123456789?pwd=synthetic'
  for (const onJoinLesson of [noop, undefined]) {
    const result = fixture({ conference: { href }, onJoinLesson })
    assert.equal(result.joinTags.length, 1)
    const [_, tag, attributes] = result.joinTags[0]
    assert.equal(tag, 'a')
    assert.ok(attributes.includes(`href="${href}"`))
    assert.ok(attributes.includes('target="_blank"'))
    assert.match(attributes, /rel="[^"]*noopener[^"]*noreferrer/)
    assert.ok(!attributes.includes('/groups/'))
    assert.ok(result.coach.steps.some(step => step.target === 'join'))
  }
})

test('identifier-only and leading-zero passcode-only access render a button without inventing a provider URL', () => {
  for (const conference of [{ meetingId: '123 456 789' }, { passcode: '000067' }]) {
    const result = fixture({ conference })
    assert.equal(result.joinTags.length, 1)
    assert.equal(result.joinTags[0][1], 'button')
    assert.doesNotMatch(result.joinTags[0][2], /\bhref=/)
    assert.ok(result.coach.steps.some(step => step.target === 'join'))
  }
})

test('missing, unsafe or unavailable meeting access produces no misleading join control or hint', () => {
  for (const input of [
    {}, { conference: {} }, { conference: { href: internalHref } },
    { conference: { href: 'javascript:alert(1)' } },
    { conference: { meetingId: '123 456 789' }, onJoinLesson: undefined },
    { conference: { passcode: '000067' }, onJoinLesson: undefined },
  ]) {
    const result = fixture(input)
    assert.equal(result.joinTags.length, 0)
    assert.ok(!result.coach.steps.some(step => step.target === 'join'))
  }
})

test('every teacher hint references an actual dashboard target, without student question or team distribution', () => {
  const result = fixture({ role: 'teacher', conference: { href: 'https://meet.google.com/synthetic-meet' }, groups: [group, { ...group, id: 'second-group' }] })
  assert.ok(result.coach.steps.some(step => step.target === 'group'))
  assert.ok(result.coach.steps.some(step => step.target === 'management'))
  for (const step of result.coach.steps) assert.ok(result.html.includes(`data-home-guide="${step.target}"`), `Missing teacher target: ${step.target}`)
  const copy = result.coach.steps.map(step => step.title + ' ' + step.text).join(' ')
  assert.doesNotMatch(copy, /семінар|розподіл|доповнювач|бронюван|команд|реєстрац/i)
})

test('loading, errors and accounts without groups keep hints aligned with real visible state', () => {
  const loading = fixture({ status: 'loading' })
  assert.equal(loading.coach.ready, false)
  for (const input of [{ status: 'error' }, { groups: [] }]) {
    const result = fixture(input)
    assert.equal(result.coach.steps.length, 1)
    assert.equal(result.coach.steps[0].target, 'empty')
    assert.ok(result.html.includes('data-home-guide="empty"'))
  }
})
