import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'

const MAX_PAGES = 1000
const MAX_SIDE = 2000
const MAX_PIXELS = 3_000_000
const MAX_DECODE_PIXELS = 16_000_000
const MAX_OUTPUT_BYTES = 3.5 * 1024 * 1024
const TEXT_COLUMNS = 70
const TEXT_ROWS = 40
const FONT = 'Xelay Material Preview'

const require = createRequire(import.meta.url)
const pdfAssets = dirname(require.resolve('pdfjs-dist/package.json'))
const font = join(pdfAssets, 'standard_fonts', 'LiberationSans-Regular.ttf')
if (!GlobalFonts.registerFromPath(font, FONT)) throw new Error('Protected material font is unavailable')
const assetFolder = name => join(pdfAssets, name).replaceAll('\\', '/') + '/'

function dimensionsAllowed(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width * height <= MAX_DECODE_PIXELS
}

function jpegDimensionsAllowed(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return false
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (offset + 2 > bytes.length || marker === 0xda || marker === 0xd9) return false
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) return false
    if (startOfFrame.has(marker)) {
      return size >= 8 && dimensionsAllowed(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += size
  }
  return false
}

function webpDimensionsAllowed(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false
  let offset = 12
  let hasImage = false
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const data = offset + 8
    offset = data + size + size % 2
    if (offset > bytes.length || kind === 'ANIM' || kind === 'ANMF') return false
    if (kind === 'VP8X') {
      if (size !== 10 || bytes[data] & 2
        || !dimensionsAllowed(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1)) return false
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (hasImage) return false
      hasImage = true
      if (kind === 'VP8 ') {
        if (size < 10 || bytes.readUIntLE(data + 3, 3) !== 0x2a019d
          || !dimensionsAllowed(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff)) return false
      } else {
        if (size < 5 || bytes[data] !== 0x2f) return false
        const dimensions = bytes.readUInt32LE(data + 1)
        if (!dimensionsAllowed((dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1)) return false
      }
    }
  }
  return hasImage && offset === bytes.length
}

function imageDimensionsAllowed(bytes, mime) {
  if (mime === 'image/jpeg') return jpegDimensionsAllowed(bytes)
  if (mime === 'image/webp') return webpDimensionsAllowed(bytes)
  return mime === 'image/png' && bytes.length >= 33 && bytes.readBigUInt64BE(0) === 0x89504e470d0a1a0an
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && dimensionsAllowed(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
}

function textPages(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n')
  const pages = [[]]
  let line = ''
  let columns = 0
  function appendLine() {
    const page = pages[pages.length - 1]
    if (page.length < TEXT_ROWS) page.push(line)
    else {
      if (pages.length >= MAX_PAGES) throw new Error('Text page limit')
      pages.push([line])
    }
    line = ''
    columns = 0
  }
  for (const character of text) {
    if (character === '\n') {
      appendLine()
      continue
    }
    const value = character === '\t' ? '    ' : character
    if (columns + value.length > TEXT_COLUMNS) appendLine()
    line += value
    columns += value.length
  }
  if (line || !pages[0].length) appendLine()
  return pages
}

async function openSource({ kind, mime, bytes }) {
  if (kind === 'text') {
    const pages = textPages(bytes)
    return { kind, pages, count: pages.length }
  }
  if (kind === 'image') {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // Legacy inventory can include images that predate the content scanner.
    // Bound the encoded geometry before handing bytes to the native decoder.
    if (!imageDimensionsAllowed(buffer, mime)) throw new Error('Image dimensions or signature')
    const image = await loadImage(buffer)
    if (!dimensionsAllowed(image.width, image.height)) throw new Error('Image dimensions')
    return { kind, image, count: 1 }
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: bytes, disableAutoFetch: true, disableStream: true, useWorkerFetch: false,
    disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: true,
    maxImageSize: MAX_DECODE_PIXELS, canvasMaxAreaInBytes: MAX_DECODE_PIXELS * 4, verbosity: 0,
    cMapUrl: assetFolder('cmaps'), cMapPacked: true,
    standardFontDataUrl: assetFolder('standard_fonts'),
    iccUrl: assetFolder('iccs'), wasmUrl: assetFolder('wasm'),
  })
  task.onPassword = () => { void task.destroy().catch(() => {}) }
  const document = await task.promise
  if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PAGES) {
    throw new Error('PDF page limit')
  }
  return { kind, document, count: document.numPages }
}

function fit(width, height, maxScale) {
  if (!Number.isFinite(width * height) || width <= 0 || height <= 0) throw new Error('Invalid page dimensions')
  const scale = Math.min(maxScale, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale }
}

function whiteCanvas(width, height) {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  return { canvas, context }
}

function watermarkName(name, limit, fallback) {
  if (typeof name !== 'string') return fallback
  const clean = name.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return Array.from(clean).slice(0, limit).join('') || fallback
}

function watermark(context, width, height, viewerName, authorName) {
  const viewer = 'Xelay · ' + watermarkName(viewerName, 160, 'Учасник Xelay')
  const author = 'Автор · ' + watermarkName(authorName, 120, 'Викладач')
  const size = Math.max(15, Math.min(36, Math.floor(width / 38)))
  const viewerFont = `${size}px "${FONT}"`
  const authorFont = `${Math.max(12, Math.floor(size * 0.72))}px "${FONT}"`
  context.save()
  context.fillStyle = '#143156'
  context.strokeStyle = '#ffffff'
  context.lineWidth = 2
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.translate(width / 2, height / 2)
  context.rotate(-Math.PI / 9)
  const extent = Math.hypot(width, height) / 2
  const maxLabelWidth = Math.max(180, width * 0.8)
  context.font = authorFont
  const authorWidth = context.measureText(author).width
  context.font = viewerFont
  const tileWidth = Math.max(context.measureText(viewer).width, authorWidth)
  const stepX = Math.max(240, Math.min(tileWidth, maxLabelWidth) + 55)
  const stepY = Math.max(100, size * 4)
  const rows = Math.ceil(extent / stepY)
  const columns = Math.ceil(extent / stepX)
  function paintLine(label, font, opacity, offsetY) {
    context.font = font
    context.globalAlpha = opacity
    for (let row = -rows; row <= rows; row++) {
      for (let column = -columns; column <= columns; column++) {
        const x = column * stepX
        const y = row * stepY + offsetY
        context.strokeText(label, x, y, maxLabelWidth)
        context.fillText(label, x, y, maxLabelWidth)
      }
    }
  }
  paintLine(viewer, viewerFont, 0.25, -size * 0.35)
  paintLine(author, authorFont, 0.2, size * 0.65)
  context.restore()
}

async function renderPage(source, pageNumber) {
  if (source.kind === 'pdf') {
    const page = await source.document.getPage(pageNumber)
    try {
      const base = page.getViewport({ scale: 1 })
      const size = fit(base.width, base.height, 2)
      const viewport = page.getViewport({ scale: size.scale })
      const surface = whiteCanvas(Math.max(size.width, 240), Math.max(size.height, 160))
      // PDF.js paints visible annotation appearances onto the canvas by default.
      // This worker does not create the interactive annotation layer.
      await page.render({
        canvas: surface.canvas, viewport, background: '#ffffff',
        transform: [1, 0, 0, 1, (surface.canvas.width - viewport.width) / 2, (surface.canvas.height - viewport.height) / 2],
      }).promise
      return surface
    } finally {
      page.cleanup()
    }
  }
  if (source.kind === 'image') {
    const { image } = source
    const size = fit(image.width, image.height, 1)
    const surface = whiteCanvas(Math.max(size.width, 240), Math.max(size.height, 160))
    surface.context.drawImage(image, (surface.canvas.width - size.width) / 2,
      (surface.canvas.height - size.height) / 2, size.width, size.height)
    return surface
  }
  const surface = whiteCanvas(1480, 1500)
  surface.context.fillStyle = '#182436'
  surface.context.font = `24px "${FONT}"`
  for (const [index, line] of source.pages[pageNumber - 1].entries()) {
    surface.context.fillText(line, 48, 56 + index * 34, surface.canvas.width - 96)
  }
  return surface
}

try {
  const source = await openSource(workerData)
  workerData.bytes = undefined
  // A worker owns one document. The main thread sends one request at a time.
  parentPort.on('message', async ({ page, viewerName, authorName }) => {
    try {
      const { canvas, context } = await renderPage(source, page)
      watermark(context, canvas.width, canvas.height, viewerName, authorName)
      let encoded = await canvas.encode('webp', 88)
      if (encoded.length > MAX_OUTPUT_BYTES) encoded = await canvas.encode('webp', 65)
      if (!encoded.length || encoded.length > MAX_OUTPUT_BYTES) throw new Error('Page payload limit')
      const bytes = new Uint8Array(encoded)
      parentPort.postMessage({ kind: 'page', bytes }, [bytes.buffer])
    } catch {
      parentPort.postMessage({ kind: 'unsupported' })
    }
  })
  parentPort.postMessage({ kind: 'ready', pageCount: source.count })
} catch {
  parentPort.postMessage({ kind: 'unsupported' })
}
