import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { metadataForPath, PRIVATE_SPA_PATHS } from '../../src/lib/seo.ts'
import { seoStaticDocuments } from '../publicSeoHtml.ts'

const root = new URL('../../', import.meta.url)
const requirePackage = createRequire(import.meta.url)
async function load(name, dependencies = {}) {
  const module = { exports: {} }
  const source = await readFile(new URL(name, root), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, console,
    require(name) { if (name in dependencies) return dependencies[name]; if (!name.startsWith('.')) return requirePackage(name); throw Error(`Unexpected dependency ${name}`) },
  })
  return module.exports
}
const campaign = await load('src/lib/winterCampaign.ts')
const { createWinterClock } = await load('src/lib/winterClock.ts', { './winterCampaign': campaign })
const start = Date.parse(campaign.WINTER_STARTS_AT), adventEnd = Date.parse(campaign.WINTER_ADVENT_ENDS_AT), end = Date.parse(campaign.WINTER_DECORATIONS_ENDS_AT)

test('winter direct entry has a private application document, never a404 or public canonical', () => {
  assert.ok(PRIVATE_SPA_PATHS.includes('/winter'))
  const metadata = metadataForPath('/winter?day=12#collection')
  assert.equal(metadata.title, 'Зима в Xelay | Xelay')
  assert.equal(metadata.index, false)
  assert.equal(metadata.notFound, undefined)
  assert.equal(metadata.canonical, undefined)
  const html = seoStaticDocuments('<!doctype html><html><head><title>Old</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>').get('seo/winter.html')
  assert.ok(html)
  assert.match(html, /<title>Зима в Xelay \| Xelay<\/title>/)
  assert.match(html, /content="noindex,follow"/)
  assert.match(html, /src="\/assets\/app.js"/)
  assert.doesNotMatch(html, /Сторінку не знайдено|rel="canonical"/)
})

function clockAt(initial) {
  let now = initial, resume, resumes = 0, removed = 0, notifications = 0
  const timers = new Set()
  const clock = createWinterClock({
    now: () => now,
    schedule(callback, delay) { const timer = { callback, delay }; timers.add(timer); return () => timers.delete(timer) },
    onResume(callback) { resumes++; resume = callback; return () => { removed++; resume = undefined } },
  })
  return {
    clock, timers,
    moveTo(value) { now = value },
    resume() { resume?.() },
    fire() { const timer = [...timers][0]; assert.ok(timer, 'a boundary timer is scheduled'); timer.callback() },
    listen() { return clock.subscribe(() => notifications++) },
    get notifications() { return notifications }, get resumes() { return resumes }, get removed() { return removed },
  }
}

test('one campaign clock changes exactly at Kyiv launch and removes all timers after winter', () => {
  const harness = clockAt(start - 1000)
  const stop = harness.listen()
  assert.equal([...harness.timers][0].delay, 1000)
  assert.equal(campaign.winterDecorationsAvailable(harness.clock.getSnapshot()), false)
  harness.moveTo(start); harness.fire()
  assert.equal(campaign.winterDecorationsAvailable(harness.clock.getSnapshot()), true)
  assert.equal(harness.notifications, 1)
  assert.equal([...harness.timers][0].delay, 2_147_483_600, 'a 31-day wait must not overflow browser timeouts')
  harness.moveTo(adventEnd); harness.fire()
  assert.equal(campaign.winterPhase(harness.clock.getSnapshot()), 'ended')
  assert.equal(campaign.winterDecorationsAvailable(harness.clock.getSnapshot()), true)
  harness.moveTo(end); harness.fire()
  assert.equal(campaign.winterDecorationsAvailable(harness.clock.getSnapshot()), false)
  assert.equal(harness.timers.size, 0)
  stop(); assert.equal(harness.removed, 1)
})

test('menu and decorations share a timer; resuming a sleeping page catches up without polling', () => {
  const harness = clockAt(start - 60_000)
  const stopMenu = harness.listen(), stopDecorations = harness.listen()
  assert.equal(harness.timers.size, 1); assert.equal(harness.resumes, 1)
  stopMenu(); assert.equal(harness.timers.size, 1); assert.equal(harness.removed, 0)
  harness.moveTo(start + 600_000); harness.resume()
  assert.equal(harness.clock.getSnapshot(), start + 600_000)
  assert.equal(harness.timers.size, 1)
  harness.moveTo(end + 100); harness.resume()
  assert.equal(harness.timers.size, 0)
  stopDecorations(); assert.equal(harness.removed, 1)
  harness.moveTo(start - 10)
  const stopAgain = harness.listen()
  assert.equal(harness.clock.getSnapshot(), start - 10)
  assert.equal([...harness.timers][0].delay, 10)
  stopAgain(); assert.equal(harness.timers.size, 0)
})

test('winter graphics are not rendered before launch, during onboarding or on protected work routes', async () => {
  let state = { now: start - 1, decorationsAvailable: false }, suspended = false, ambientRenders = 0
  const components = await load('src/components/winter/WinterExperience.tsx', {
    react: { ...React, lazy: () => () => { ambientRenders++; return React.createElement('div', { 'data-winter-ambient': true }) } },
    '../../context/OnboardingContext': { useOnboarding: () => ({ suspended }) },
    '../../hooks/useWinterCampaign': { useWinterCampaign: () => state },
    '../../lib/winterCampaign': campaign,
  })
  const render = props => renderToStaticMarkup(React.createElement(components.WinterExperience, props))
  assert.equal(render({ pathname: '/' }), '')
  state = { now: start, decorationsAvailable: true }
  for (const pathname of ['/admin', '/admin/review', '/dean', '/business', '/business/document/1', '/auth/callback', '/reset-password']) assert.equal(render({ pathname }), '')
  assert.equal(render({ pathname: '/', blocked: true }), '')
  suspended = true; assert.equal(render({ pathname: '/' }), '')
  assert.equal(ambientRenders, 0)
  suspended = false
  assert.match(render({ pathname: '/' }), /data-winter-ambient/)
  assert.equal(ambientRenders, 1)
  state = { now: end, decorationsAvailable: false }
  assert.equal(render({ pathname: '/' }), '')
})

test('fullscreen, active teacher exams and native or application dialogs suppress global decoration', async () => {
  const { winterDocumentBlocked, WINTER_BLOCKING_SELECTOR } = await load('src/lib/winterBlockers.ts')
  assert.equal(winterDocumentBlocked({ fullscreenElement: null, querySelector: () => null }), false)
  assert.equal(winterDocumentBlocked({ fullscreenElement: {}, querySelector: () => { throw Error('fullscreen already blocks') } }), true)
  assert.equal(winterDocumentBlocked({ fullscreenElement: null, querySelector: selector => selector === WINTER_BLOCKING_SELECTOR ? {} : null }), true)
  // Both real test runners use these shapes: TeachingTestRunner's active screen
  // and MaxTutorQuizWorkspace's native dialog. No test/answer state is modified.
  assert.match(WINTER_BLOCKING_SELECTOR, /\.teaching-test-screen\[data-active="true"\]/)
  assert.match(WINTER_BLOCKING_SELECTOR, /dialog\[open\]/)
  assert.match(WINTER_BLOCKING_SELECTOR, /\[role="dialog"\]\[aria-modal="true"\]/)
})
