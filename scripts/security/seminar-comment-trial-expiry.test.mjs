// Exercise the actual asynchronous mutation handler with isolated state setters.
// This is a unit check, not a React render, browser or hosted Auth/RLS check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../src/components/SeminarComments.tsx', import.meta.url), 'utf8')
const tree = ts.createSourceFile('SeminarComments.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const handlers = []
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'runMutation') handlers.push(node.initializer)
  ts.forEachChild(node, visit)
}
visit(tree)
assert.equal(handlers.length, 1)
const names = ['scope', 'latestCanParticipate', 'mutatingScope', 'loading', 'loadError', 'loadedScope',
  'latestData', 'currentUserId', 'latestCanModerate', 'setDeleteId', 'setEditingId', 'setEditBody',
  'setBusy', 'setActionError', 'alive', 'latestScope', 'latestReload', 'latestOnLicenseRequired',
  'licenseRequiredNotice', 'seminarCommentError', 'seminarCommentAccessLost', 'sequence', 'setData',
  'emptyComments', 'setDraft', 'setLoadError', 'refreshPending']
const harnessSource = `export function createHandler(ctx) { const {${names.join(',')}} = ctx; return ${handlers[0].getText(tree)}; }`
const compiled = ts.transpileModule(harnessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { createHandler } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function fixture() {
  const retained = { comments: [{ id: 'own', author_id: 'a', body: 'Retained' }], profiles: {}, hasMore: false, membershipId: 'member' }
  const state = { data: retained, draft: 'Unsent draft', editBody: 'Unsent edit', editingId: 'own', deleteId: 'own', busy: '', actionError: '', loadError: '' }
  let deniedCallbacks = 0, reloads = 0, successful = 0
  const ctx = {
    scope: 'g:s:a', loadedScope: 'g:s:a', loading: false, loadError: '', currentUserId: 'a',
    latestCanParticipate: { current: true }, latestCanModerate: { current: true },
    mutatingScope: { current: null }, alive: { current: true }, latestScope: { current: 'g:s:a' },
    latestData: { current: retained }, sequence: { current: 0 }, refreshPending: { current: false },
    latestReload: { current: async () => { reloads++ } },
    latestOnLicenseRequired: { current: () => { deniedCallbacks++; ctx.latestCanParticipate.current = false } },
    licenseRequiredNotice: 'License ended; retain readable data',
    seminarCommentError: () => 'Denied', seminarCommentAccessLost: (error) => error.code === '42501',
    emptyComments: { comments: [], profiles: {}, hasMore: false, membershipId: null },
  }
  for (const name of ['Data', 'Draft', 'EditBody', 'EditingId', 'DeleteId', 'Busy', 'ActionError', 'LoadError']) {
    const field = name[0].toLowerCase() + name.slice(1)
    ctx[`set${name}`] = (value) => { state[field] = typeof value === 'function' ? value(state[field]) : value }
  }
  return { ctx, state, retained, run: createHandler(ctx), success: () => { successful++ }, counts: () => ({ deniedCallbacks, reloads, successful }) }
}

test('expiry during a comment mutation retains readable snapshot and draft but immediately disables writes', async () => {
  const h = fixture()
  await h.run('add', async () => { throw { code: '42501', message: 'GROUP_LICENSE_REQUIRED' } }, h.success)
  assert.equal(h.state.data, h.retained)
  assert.equal(h.state.draft, 'Unsent draft')
  assert.equal(h.state.editBody, 'Unsent edit')
  assert.equal(h.state.loadError, '')
  assert.equal(h.state.actionError, h.ctx.licenseRequiredNotice)
  assert.equal(h.state.editingId, null)
  assert.equal(h.state.deleteId, null)
  assert.equal(h.state.busy, '')
  assert.equal(h.ctx.mutatingScope.current, null)
  assert.deepEqual(h.counts(), { deniedCallbacks: 1, reloads: 0, successful: 0 })
  let invoked = false
  await h.run('add', async () => { invoked = true }, h.success)
  assert.equal(invoked, false)
})

test('fresh parent billing confirmation restores mutation without a persistent local denial latch', async () => {
  const h = fixture()
  await h.run('add', async () => { throw { code: '42501', message: 'GROUP_LICENSE_REQUIRED' } }, h.success)
  h.ctx.latestCanParticipate.current = true
  await h.run('add', async () => {}, h.success)
  assert.deepEqual(h.counts(), { deniedCallbacks: 1, reloads: 1, successful: 1 })
  assert.equal(h.state.actionError, '')
  assert.equal(h.state.data, h.retained)
})

test('a genuine membership or authorization loss still clears the private snapshot and drafts', async () => {
  for (const message of ['SEMINAR_MEMBER_REQUIRED', 'SEMINAR_AUTH_REQUIRED', 'Permission denied']) {
    const h = fixture()
    await h.run('add', async () => { throw { code: '42501', message } }, h.success)
    assert.equal(h.state.data, h.ctx.emptyComments)
    assert.equal(h.state.draft, '')
    assert.equal(h.state.editBody, '')
    assert.equal(h.state.loadError, 'Denied')
    assert.equal(h.ctx.sequence.current, 1)
    assert.deepEqual(h.counts(), { deniedCallbacks: 0, reloads: 0, successful: 0 })
  }
})

test('a delayed response from a different scope cannot clear its data or revoke its access', async () => {
  const h = fixture()
  await h.run('add', async () => {
    h.ctx.latestScope.current = 'other:seminar:b'
    throw { code: '42501', message: 'GROUP_LICENSE_REQUIRED' }
  }, h.success)
  assert.equal(h.state.data, h.retained)
  assert.equal(h.state.draft, 'Unsent draft')
  assert.deepEqual(h.counts(), { deniedCallbacks: 0, reloads: 0, successful: 0 })
})

test('readonly participation and moderation flags never authorize a forbidden mutation', async () => {
  const h = fixture()
  h.ctx.latestCanParticipate.current = false
  let invoked = 0
  await h.run('add', async () => { invoked++ }, h.success)
  h.ctx.latestCanParticipate.current = true
  h.ctx.latestCanModerate.current = false
  h.ctx.latestData.current = { ...h.retained, comments: [{ id: 'foreign', author_id: 'b', body: 'Foreign' }] }
  await h.run('delete:foreign', async () => { invoked++ }, h.success)
  await h.run('edit:foreign', async () => { invoked++ }, h.success)
  assert.equal(invoked, 0)
  assert.deepEqual(h.counts(), { deniedCallbacks: 0, reloads: 0, successful: 0 })
})
