import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import postcss from 'postcss'

function load(path, imports = {}, globals = {}) { const module = { exports: {} }; runInNewContext(ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { module, exports: module.exports, Intl, Date, Error, ...globals, require(name) { assert.ok(name in imports, name); return imports[name] } }); return module.exports }
const plans = load('src/lib/teacherPlans.ts')
const icon = () => null
const catalogueImports = { react: React, 'react/jsx-runtime': jsxRuntime, 'lucide-react': new Proxy({}, { get: () => icon }), '../LegalLinks': { CheckoutLegalConsent: ({ checked }) => React.createElement('input', { type: 'checkbox', readOnly: true, checked }) }, '../../lib/billing': { createTeacherPlanCheckout() { throw Error('No checkout during render') }, openHostedCheckout() { throw Error('No hosted checkout during render') } }, '../../lib/legal': { legalMerchant: { ready: true } }, '../../lib/teacherPlans': plans, './teacherSubscriptions.css': {} }
const { TeacherSubscriptionCatalogue } = load('src/components/teaching/TeacherSubscriptionCatalogue.tsx', catalogueImports)
const configuration = { checkoutAvailable: true, mode: 'test', subscriptionAudience: 'teacher', teacherPlansAvailable: true, teacherPlanPrices: { teacher_start: 199, teacher_plus: 499, teacher_max: 999 } }
const render = config => renderToStaticMarkup(React.createElement(TeacherSubscriptionCatalogue, { userId: 'synthetic-owner', configuration: config, loading: false, onLogin() {} }))

test('teacher catalogue has exactly three practical tiers, format-specific file limits and no public dollar budgets', () => {
  const html = render(configuration)
  for (const price of ['199','499','999']) assert.match(html, new RegExp('>' + price + '<'))
  assert.equal((html.match(/class="tsc-plan(?: is-selected)?"/g) || []).length, 3)
  assert.match(html, /PDF і текст — до 100 МБ/); assert.match(html, /PDF і текст — до 150 МБ/); assert.match(html, /PDF і текст — до 200 МБ/)
  assert.match(html, /Для інших підтримуваних форматів ліміт становить 50 МБ/); assert.match(html, /поки не обмежуємо/)
  assert.doesNotMatch(html, /\$|USD|історією версій|безлімітн/i)
})
test('a student browsing teacher plans cannot buy them, while free teaching and gifted access remain explicit', () => {
  const html = render({ ...configuration, subscriptionAudience: 'student' })
  assert.match(html, /Ці тарифи для акаунтів, зареєстрованих як викладач/)
  assert.match(html, /Що доступно без підписки/)
  assert.match(html, /Ручна перевірка, публікація результатів і повторні спроби/)
  assert.match(html, /class="tsc-primary" disabled=""/)
  const active = render({ ...configuration, teacherPlan: { id: 'teacher_plus', startsAt: '2026-11-17T12:00:00Z', expiresAt: '2026-12-17T12:00:00Z' } })
  assert.match(active, /Оплачене й подароване раніше не зникає/)
})
test('a legacy teacher without an immutable audience row can reach server-authorized checkout without being labelled a student', () => {
  for (const subscriptionAudience of [undefined, 'unresolved']) {
    const html = render({ ...configuration, subscriptionAudience })
    assert.doesNotMatch(html, /Ці тарифи для акаунтів, зареєстрованих як викладач|Оформлення ще недоступне/)
    assert.match(html, /Оформлення тарифу Плюс/)
  }
})

test('illustration loops pause outside the viewport, on a hidden page and when reduced motion is requested', () => {
  const effects = [], documentListeners = new Map(), preferenceListeners = new Map()
  const scenes = Array.from({ length: 4 }, () => ({ dataset: { inview: 'false' } })), section = { dataset: {}, querySelectorAll: () => scenes }
  const preference = { matches: false, addEventListener: (name, fn) => preferenceListeners.set(name, fn), removeEventListener: name => preferenceListeners.delete(name) }
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) }
  let callback, disconnected = false
  const observed = []
  class Observer { constructor(fn) { callback = fn } observe(scene) { observed.push(scene) } disconnect() { disconnected = true } }
  const { TeacherSubscriptionCatalogue: Component } = load('src/components/teaching/TeacherSubscriptionCatalogue.tsx', { ...catalogueImports, react: { ...React, useRef: initial => initial === null ? { current: section } : React.useRef(initial), useEffect: fn => effects.push(fn) } }, { window: { matchMedia: () => preference }, document, IntersectionObserver: Observer })
  const html = renderToStaticMarkup(React.createElement(Component, { userId: 'synthetic-owner', configuration, loading: false, onLogin() {} }))
  assert.equal((html.match(/data-teacher-motion=/g) || []).length, 4)
  assert.match(html, /data-motion-enabled="false"/)
  const cleanup = effects.at(-1)()
  assert.equal(observed.length, 4); assert.equal(section.dataset.motionEnabled, 'true')
  callback([{ target: scenes[0], isIntersecting: true }, { target: scenes[1], isIntersecting: false }])
  assert.equal(scenes[0].dataset.inview, 'true'); assert.equal(scenes[1].dataset.inview, 'false')
  document.visibilityState = 'hidden'; documentListeners.get('visibilitychange')(); assert.equal(section.dataset.motionEnabled, 'false')
  document.visibilityState = 'visible'; preference.matches = true; preferenceListeners.get('change')(); assert.equal(section.dataset.motionEnabled, 'false')
  preference.matches = false; preferenceListeners.get('change')(); assert.equal(section.dataset.motionEnabled, 'true')
  cleanup(); assert.equal(disconnected, true); assert.equal(section.dataset.motionEnabled, 'false'); assert.equal(documentListeners.size, 0); assert.equal(preferenceListeners.size, 0)
})

test('all decorative keyframes use only compositor properties and reduced motion removes the loops', () => {
  const sheet = postcss.parse(readFileSync(new URL('../src/components/teaching/teacherSubscriptions.css', import.meta.url), 'utf8'))
  let keyframes = 0, reduced = false
  sheet.walkAtRules(/keyframes$/, rule => { keyframes++; rule.walkDecls(declaration => assert.ok(['transform','opacity'].includes(declaration.prop), 'Compositor property: ' + declaration.prop)) })
  sheet.walkAtRules('media', rule => { if (!rule.params.includes('prefers-reduced-motion')) return; rule.walkDecls('animation', declaration => { if (declaration.value === 'none' && declaration.important) reduced = true }) })
  assert.ok(keyframes >= 4); assert.equal(reduced, true)
})
