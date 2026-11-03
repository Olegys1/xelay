// Synthetic, inert PDF fixtures. No viewer, active code, network, or real user data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import * as zlib from 'node:zlib'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { uploadValidatorDependencies } from './upload-content-validator-dependencies.mjs'

const root = process.env.XELAY_AUDIT_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const ts = createRequire(join(process.env.XELAY_AUDIT_DEPENDENCY_ROOT || root, 'package.json'))('typescript')
const source = await readFile(join(root, 'server/uploadContentValidation.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true })
assert.deepEqual(compiled.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error), [])
const module = { exports: {} }
vm.runInNewContext(compiled.outputText, {
  module, exports: module.exports, Buffer, Uint8Array, TextDecoder, Error,
  require(name) {
    if (name === 'node:crypto') return crypto
    if (name === 'node:zlib') return zlib
    if (name === 'node:path') return path
    if (Object.hasOwn(uploadValidatorDependencies, name)) return uploadValidatorDependencies[name]
    throw Error('Unexpected dependency ' + name)
  },
})
const { validateUploadContent: validate, UploadContentValidationError: ValidationError } = module.exports
const accept = (bytes, budget) => validate(bytes, 'pdf', 'application/pdf', budget)
const deny = bytes => assert.rejects(accept(bytes), error => error instanceof ValidationError && error.status === 422)

function pdf({ catalog = '<< /Type /Catalog /Pages 2 0 R >>', page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', extras = [], trailer = '' } = {}) {
  const objects = [catalog, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', page, ...extras]
  let value = '%PDF-1.7\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value, 'latin1'))
    value += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(value, 'latin1')
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  value += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(value, 'latin1')
}
function outlined({ head = '<< /Type /Outlines /First 5 0 R /Last 6 0 R /Count 2 >>', first = '<< /Title (First) /Parent 4 0 R /Next 6 0 R /Dest [3 0 R /Fit] >>', second = '<< /Title (Second) /Parent 4 0 R /Prev 5 0 R /Dest [3 0 R /XYZ null 100 null] >>', ...options } = {}) {
  return pdf({ catalog: '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>', extras: [head, first, second], ...options })
}
function ascii85(bytes) {
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const size = Math.min(4, bytes.length - offset)
    let number = 0
    for (let index = 0; index < 4; index++) number = number * 256 + (bytes[offset + index] ?? 0)
    if (!number && size === 4) { result += 'z'; continue }
    const digits = Array(5)
    for (let index = 4; index >= 0; index--) { digits[index] = String.fromCharCode(number % 85 + 33); number = Math.floor(number / 85) }
    result += digits.slice(0, size + 1).join('')
  }
  return result + '~>'
}
function stream(encoded, filter = '[/ASCII85Decode /FlateDecode]', params = '') {
  return `<< /Length ${Buffer.byteLength(encoded, 'latin1')} /Filter ${filter} ${params} >>\nstream\n${encoded}\nendstream`
}
const content = Buffer.from('0 0 m 10 10 l S\n'.repeat(20))
const compressed = zlib.deflateSync(content)
const encoded = ascii85(compressed)

test('empty annotations pass only on a real reachable page, including escaped key names', async () => {
  for (const key of ['Annots', 'Ann#6fts']) {
    const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /${key} [] >>`
    assert.equal((await accept(pdf({ page }))).extension, 'pdf')
  }
  for (const value of ['null', '[null]', '[4 0 R]', '4 0 R']) {
    await deny(pdf({ page: `<< /Type /Page /Parent 2 0 R /Annots ${value} >>`, extras: ['[]'] }))
  }
  await deny(pdf({ extras: ['<< /Type /Page /Annots [] >>'] }))
  await deny(pdf({ extras: ['<< /Annots [] >>'] }))
  await deny(pdf({ page: '<< /Type /Page /Parent 2 0 R /Metadata << /Annots [] >> >>' }))
  await deny(pdf({ trailer: '/Annots []' }))
})

test('ordinary local linked bookmarks pass; incremental, orphan, and nested Prev remain rejected', async () => {
  assert.equal((await accept(outlined())).mime, 'application/pdf')
  assert.equal((await accept(pdf({
    catalog: '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>',
    extras: [
      '<< /Type /Outlines /First 5 0 R /Last 6 0 R /Count 3 >>',
      '<< /Title (First) /Parent 4 0 R /Next 6 0 R /First 7 0 R /Last 7 0 R /Count -1 >>',
      '<< /Title (Second) /Parent 4 0 R /Prev 5 0 R /Dest [3 0 R /Fit] >>',
      '<< /Title (Nested child) /Parent 5 0 R /Dest [3 0 R /FitH 100] >>',
    ],
  }))).extension, 'pdf')
  await deny(outlined({ trailer: '/Prev 0' }))
  await deny(outlined({ trailer: '/Pr#65v 0' }))
  await deny(pdf({ extras: ['<< /Prev 3 0 R >>'] }))
  await deny(pdf({ extras: ['<< /Metadata << /Prev 3 0 R >> >>'] }))
  await deny(pdf({ trailer: '/Info << /Prev 0 >>' }))
})

test('a hidden older revision cannot be accepted by omitting Prev from a replacement xref', async () => {
  const original = pdf()
  const text = original.toString('latin1')
  const offsets = [1, 2, 3].map(id => text.indexOf(`${id} 0 obj`))
  const xref = `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${original.length}\n%%EOF\n`
  await deny(Buffer.concat([original, Buffer.from(xref, 'latin1')]))
})

test('bookmark backreferences cannot hide cycles, sharing, wrong generations, or invalid parents', async () => {
  for (const second of [
    '<< /Title (Second) /Parent 4 0 R /Prev 5 0 R /Next 5 0 R >>',
    '<< /Title (Second) /Parent 4 0 R /Prev 6 0 R >>',
    '<< /Title (Second) /Parent 4 0 R /Prev 5 1 R >>',
    '<< /Title (Second) /Parent 2 0 R /Prev 5 0 R >>',
    '<< /Title (Second) /Parent 4 0 R >>',
  ]) await deny(outlined({ second }))
  await deny(outlined({ first: '<< /Title (First) /Parent 4 0 R /First 5 0 R /Last 5 0 R /Next 6 0 R >>' }))
  await deny(outlined({ first: '<< /Title (First) /Parent 4 0 R /First 6 0 R /Last 6 0 R /Next 6 0 R >>' }))
  await deny(outlined({ head: '<< /Type /Outlines /First 5 0 R /Last 5 0 R >>' }))
  await deny(outlined({ first: '<< /Title (First) /Parent 4 0 R /Next 6 1 R >>' }))
})

test('local bookmark destinations do not permit action dictionaries, script names, or remote targets', async () => {
  for (const extra of [
    '/A << /S /GoTo /D [3 0 R /Fit] >>',
    '/A << /S /JavaScript /JS (inert text only) >>',
    '/A << /S /Java#53cript /J#53 (inert text only) >>',
    '/A << /S /URI /URI (https://example.invalid/) >>',
    '/Dest [2 0 R /Fit]',
    '/Dest [3 1 R /Fit]',
    '/Dest [3 0 R /GoToR]',
    '/Dest [3 0 R /Fit (not a coordinate)]',
  ]) await deny(outlined({ first: `<< /Title (First) /Parent 4 0 R /Next 6 0 R ${extra} >>` }))
})

test('ASCII85 followed by Flate accepts ordinary streams and whitespace without altering identity', async () => {
  for (const value of [encoded, encoded.slice(0, 5) + '\r\n\t ' + encoded.slice(5) + '\n']) {
    const bytes = pdf({ extras: [stream(value)] })
    const result = await accept(bytes)
    assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    assert.equal(result.size, bytes.length)
  }
})

test('ASCII85 and Flate reject malformed terminators, ambiguous encodings, unsupported chains and parameters', async () => {
  for (const value of [encoded.slice(0, -2), encoded + 'ignored', 'z!~>', '!z~>', 'uuuuu~>', '!~>', '<~' + encoded, encoded + '~>']) {
    await deny(pdf({ extras: [stream(value)] }))
  }
  for (const filter of ['[/FlateDecode /ASCII85Decode]', '[/A85 /Fl]', '[/ASCII85Decode /FlateDecode /FlateDecode]', '/ASCII85Decode', '4 0 R']) {
    await deny(pdf({ extras: [stream(encoded, filter)] }))
  }
  for (const params of ['/DecodeParms null', '/DecodeParms [null null]', '/DecodeParms << /Predictor 12 >>']) {
    await deny(pdf({ extras: [stream(encoded, undefined, params)] }))
  }
  const trailing = ascii85(Buffer.concat([compressed, Buffer.from('ignored')]))
  await deny(pdf({ extras: [stream(trailing)] }))
})

test('both ASCII85 intermediate output and inflated streams consume the same shared budget', async () => {
  const one = pdf({ extras: [stream(encoded)] })
  const exact = compressed.length + content.length
  const budget = { remaining: exact }
  await accept(one, budget)
  assert.equal(budget.remaining, 0)
  await assert.rejects(accept(one, { remaining: exact - 1 }), error => error instanceof ValidationError)
  await assert.rejects(accept(one, { remaining: compressed.length - 1 }), error => error instanceof ValidationError)
  await assert.rejects(accept(pdf({ extras: [stream(encoded), stream(encoded)] }), { remaining: exact * 2 - 1 }), error => error instanceof ValidationError)
})

test('ASCII85 zero compression and Flate bombs cannot exceed bounded decoded work', async () => {
  // Four output bytes per z: just one tuple beyond the existing 16 MiB part cap.
  await deny(pdf({ extras: [stream('z'.repeat(4 * 1024 * 1024 + 1) + '~>')] }))
  const bomb = ascii85(zlib.deflateSync(Buffer.alloc(2 * 1024 * 1024)))
  await deny(pdf({ extras: [stream(bomb)] }))
})
