// Actual renderer, PNG assets and CSS; no network or account mutations.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { inflateSync } from 'node:zlib'

const root = new URL('../../', import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const catalog = {}
vm.runInNewContext(compile(await readFile(new URL('src/lib/participantStatus.ts', root), 'utf8')), { exports: catalog })
const component = await readFile(new URL('src/components/ParticipantStatusEmoji.tsx', root), 'utf8')
const css = await readFile(new URL('src/components/ParticipantStatusEmoji.css', root), 'utf8')
function fixture() {
  let cursor = 0, slots = [], key
  const jsx = (type, props, key) => ({ type, props, key })
  const renderer = {}
  vm.runInNewContext(compile(component), {
    exports: renderer,
    require(name) {
      if (name === 'react') return { useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] } }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '../lib/participantStatus') return catalog
      if (name.endsWith('.css')) return {}
      if (name.startsWith('../assets/status/')) return name
      throw new Error(`Unexpected live import ${name}`)
    },
  })
  return {
    renderer,
    render(emoji, extra = {}) {
      let tree = renderer.ParticipantStatusEmoji({ emoji, ...extra })
      if (typeof tree.type === 'function') {
        if (key !== tree.key) { key = tree.key; slots = [] }
        cursor = 0
        tree = tree.type(tree.props)
      }
      return tree
    },
  }
}
function all(tree, type) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(node => all(node, type))
  return [...(tree.type === type ? [tree] : []), ...all(tree.props?.children, type)]
}

test('new sticker tokens are unique, labeled and selectable in the existing sticker group', () => {
  for (const [token, label] of [['sticker:leopard','Леопард'],['sticker:frog','Жабка з сердечками']]) {
    assert.equal(catalog.PARTICIPANT_STATUS_EMOJIS.filter(item => item === token).length, 1)
    assert.equal(catalog.participantStatusEmojiLabel(token), label)
    assert.ok(catalog.PARTICIPANT_STATUS_EMOJI_GROUPS.find(group => group.name === 'Стікери').emojis.includes(token))
  }
  assert.equal(catalog.PARTICIPANT_STATUS_MAX_EMOJIS, 3)
})

test('leopard uses one correctly sized sheet and starts only after the image loads', () => {
  const fx = fixture(), initial = fx.render('sticker:leopard')
  assert.doesNotMatch(initial.props.className, /--running/)
  const image = all(initial, 'img')[0]
  assert.match(image.props.src, /leopard-run-20261016\.png$/)
  assert.equal(image.props.width, 96)
  assert.equal(image.props.height, 48)
  image.props.onLoad()
  assert.match(fx.render('sticker:leopard').props.className, /--running/)
  const pickerImage = all(fx.render('sticker:leopard', { picker: true }), 'img')[0]
  assert.equal(pickerImage.props.width, 128)
  assert.equal(pickerImage.props.height, 64)
})

test('frog stays static after loading and both animals have accessible native error fallbacks', () => {
  for (const [token, label, fallback] of [['sticker:leopard','Леопард','🐆'], ['sticker:frog','Жабка з сердечками','🐸']]) {
    const fx = fixture(), before = fx.render(token)
    assert.equal(before.props.role, 'img')
    assert.equal(before.props['aria-label'], label)
    assert.equal(all(before, 'img').length, 1)
    all(before, 'img')[0].props.onLoad()
    const loaded = fx.render(token)
    if (token === 'sticker:frog') assert.doesNotMatch(loaded.props.className, /--running|--animated/)
    all(loaded, 'img')[0].props.onError()
    const failed = fx.render(token)
    assert.equal(all(failed, 'img').length, 0)
    assert.equal(all(failed, 'span').at(-1).props.children, fallback)
    assert.doesNotMatch(failed.props.className, /--running|--animated/)
    // A different selection remounts failed image state.
    assert.equal(all(fx.render(token === 'sticker:frog' ? 'sticker:leopard' : 'sticker:frog'), 'img').length, 1)
  }
})

test('hippo and Cheburashka retain their previous rendering and decorative status hides duplicate speech', () => {
  const fx = fixture()
  assert.equal(all(fx.render('🦛'), 'img').length, 1)
  const cheb = fx.render('sticker:cheburashka')
  assert.equal(all(cheb, 'img').length, 2)
  for (const image of all(cheb, 'img')) image.props.onLoad()
  assert.match(fx.render('sticker:cheburashka').props.className, /--animated/)
  const decorative = fx.render('sticker:frog', { decorative: true })
  assert.equal(decorative.props['aria-hidden'], true)
  assert.equal(decorative.props.role, undefined)
  const group = fx.renderer.ParticipantStatusEmojis({ status: 'sticker:leopard sticker:frog' })
  assert.match(group.props['aria-label'], /Леопард, Жабка з сердечками/)
  assert.doesNotMatch(group.props['aria-label'], /sticker:/)
})

test('the eight frame animation never interpolates across sheet cells and reduced motion keeps the first frame', () => {
  assert.match(css, /width: 400%/)
  assert.match(css, /height: 200%/)
  assert.match(css, /animation: participant-sticker-run 880ms step-end infinite/)
  for (const percent of ['12.5','25','37.5','50','62.5','75','87.5']) assert.ok(css.includes(`${percent}% { transform:`))
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.participant-status-sticker__leopard\s*\{\s*animation: none !important;\s*transform: translate\(0, 0\)/)
  assert.doesNotMatch(component, /setInterval|setTimeout|requestAnimationFrame/)
})

async function png(name) {
  const data = await readFile(new URL('src/assets/status/' + name, root))
  assert.equal(data.subarray(1, 4).toString(), 'PNG')
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
  assert.equal(data[24], 8)
  assert.equal(data[25], 6)
  const chunks = []
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset)
    if (data.subarray(offset + 4, offset + 8).toString() === 'IDAT') chunks.push(data.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const filtered = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(stride * height)
  const paeth = (a,b,c) => { const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c }
  for (let row = 0; row < height; row++) {
    const filter = filtered[row * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const i = row * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = row ? pixels[i - stride] : 0, c = row && x >= 4 ? pixels[i - stride - 4] : 0
      pixels[i] = (filtered[row * (stride + 1) + 1 + x] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a,b,c) : 0)) & 255
    }
  }
  return { data, width, height, pixels }
}

test('optimized PNGs preserve real transparency and the sheet contains eight distinct visible frames', async () => {
  const leopard = await png('leopard-run-20261016.png'), frog = await png('frog-20261016.png')
  assert.deepEqual([leopard.width, leopard.height], [512, 256])
  assert.deepEqual([frog.width, frog.height], [128, 128])
  assert.ok(leopard.data.length < 140_000)
  assert.ok(frog.data.length < 35_000)
  for (const asset of [leopard, frog]) {
    const alpha = asset.pixels.filter((_, i) => i % 4 === 3)
    assert.ok(alpha.includes(0) && alpha.includes(255))
    assert.equal(asset.pixels[3], 0)
  }
  const frames = []
  for (let frame = 0; frame < 8; frame++) {
    const bytes = []
    for (let y = Math.floor(frame / 4) * 128; y < (Math.floor(frame / 4) + 1) * 128; y++) {
      const x = (frame % 4) * 128
      bytes.push(leopard.pixels.subarray((y * 512 + x) * 4, (y * 512 + x + 128) * 4))
    }
    const pixels = Buffer.concat(bytes)
    assert.ok(pixels.filter((_, i) => i % 4 === 3).some(alpha => alpha > 200))
    frames.push(pixels.toString('base64'))
  }
  assert.equal(new Set(frames).size, 8)
})
