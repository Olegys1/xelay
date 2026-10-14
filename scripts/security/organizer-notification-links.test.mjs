// Pure source helpers only. No API calls, accounts, files or mail deliveries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const app = await readFile(new URL('src/App.tsx', root), 'utf8')
const shared = await readFile(new URL('src/components/SharedOrganizer.tsx', root), 'utf8')
const page = await readFile(new URL('src/pages/OrganizerPage.tsx', root), 'utf8')
const sourceFile = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const evaluate = text => vm.runInNewContext(ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText)

function routeValidator() {
  const source = sourceFile('App.tsx', app)
  let expression
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'organizerRoute') {
      const object = node.initializer.arguments[0]
      expression = object.properties.find(property => property.name?.getText(source) === 'validateSearch').initializer.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression)
  return evaluate('(' + expression + ')')
}

function workspaceSelector() {
  const source = sourceFile('SharedOrganizer.tsx', shared)
  const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'initialWorkspaceSelection')
  const declaration = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(source) === 'WORKSPACE_ID'))
  assert.ok(helper); assert.ok(declaration)
  return evaluate(declaration.getText(source) + '\n' + helper.getText(source) + '\ninitialWorkspaceSelection')
}

test('organizer email route accepts only explicit shared view and a canonical UUID', () => {
  const validate = routeValidator()
  const uuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
  assert.equal(validate({ view: 'shared', workspace: uuid }).view, 'shared')
  assert.equal(validate({ view: 'shared', workspace: uuid }).workspace, uuid.toLowerCase())
  for (const view of [undefined, 'personal', 'other', ['shared'], true]) {
    const result = validate({ view, workspace: uuid })
    assert.equal(result.view, undefined); assert.equal(result.workspace, undefined)
  }
  for (const workspace of [undefined, '../other', 'https://other.test/', uuid + '?redirect=https://other.test', [uuid], 123]) {
    const result = validate({ view: 'shared', workspace })
    assert.equal(result.view, 'shared'); assert.equal(result.workspace, undefined)
  }
})

test('initial selection loads a requested workspace only when account overview allows it', () => {
  const select = workspaceSelector()
  const first = { id: '11111111-1111-4111-8111-111111111111' }
  const second = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  const outside = '33333333-3333-4333-8333-333333333333'
  assert.equal(select([first, second], second.id), second.id)
  assert.equal(select([first, second], second.id.toUpperCase()), second.id)
  assert.equal(select([first, second], outside), first.id)
  assert.equal(select([first, second], '../outside'), first.id)
  assert.equal(select([first, second]), first.id)
  assert.equal(select([], outside), null, 'Pending invitation does not authorize a detail lookup')
})

test('initial link is consumed once per account and manual switching preserves dirty guards', () => {
  assert.match(shared, /initialSelection\.current\.consumed = true/)
  assert.match(shared, /if \(!selectedRef\.current\) selectWorkspace\(initialWorkspaceSelection/)
  assert.match(shared, /initialSelection\.current = \{ userId, consumed: false \}/)
  assert.match(shared, /if \(!current\(\)\) return[\s\S]*initialSelection\.current\.consumed/)
  assert.match(page, /key=\{ownerId!\} userId=\{ownerId!\} initialWorkspaceId=\{initialSharedWorkspaceId\}/)
  assert.match(page, /sharedState\.dirty[\s\S]*?return[\s\S]*?setInitialSharedWorkspaceId\(undefined\)[\s\S]*?setView\(key\)/)
  assert.match(page, /setView\(initialView\); setInitialSharedWorkspaceId\(initialWorkspaceId\); setSharedState/)
})
