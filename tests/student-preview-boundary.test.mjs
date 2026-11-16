import test from 'node:test'
import assert from 'node:assert/strict'
import {studentPreviewBlockedPath} from '../scripts/student-preview-boundary.mjs'

test('local preview denies server source, private ledgers, environment and traversal variants', () => {
  for (const path of ['/server/student-learning/maxTutorLocalServer.ts', '/@fs/C:/repo/server/private.ts', '/.env', '/.env.local', '/.git/config', '/private-server/ledger.json', '/local-tutor-private/ledger.json', '/%73erver/key.ts', '/%2573erver/key.ts', '/x/../server/key.ts', '/x%5c..%5csecrets', '/bad%00path', '/bad%ZZ']) assert.equal(studentPreviewBlockedPath(path), true, path)
})

test('own preview assets and same-origin API remain reachable without widening external connections', () => {
  for (const path of ['/.student-workspace-preview.local/index.html', '/src/components/student/MaxTutorAssistant.tsx', '/node_modules/.vite/deps/react.js', '/api/local-max/status', '/api/local-max/run', '/@vite/client', '/src/lib/studentGuides.ts?t=123']) assert.equal(studentPreviewBlockedPath(path), false, path)
})
