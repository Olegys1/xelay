import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = new URL('../../', import.meta.url)
const imagePath = 'og-xelay-halloween-20261018.png'
const imageUrl = 'https://www.xelay.ink/' + imagePath
const imageAlt = 'Святковий логотип Xelay KNU з відьомським капелюхом і гарбузиком'
// Pin the approved PNG without making CI depend on ignored local image artifacts.
const approvedImageHash = '70c68b7f02481235eb55515c14aec9fb92d9195671e7b0fc3228c1d5265f710b'
const ordinaryImageHash = '97ff53b518d313fe26563e475e897761be7d957512b7b131dd8c0a99387c3579'
const title = 'Xelay — університетська платформа'
const description = 'Спілкування, новини університету й факультету, навчальні групи, розклад, домашні завдання та семінари — усе поруч у Xelay.'
const read = path => readFile(new URL(path, root), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const attributes = tag => Object.fromEntries([...tag.matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, name, double, single]) => [name, double ?? single]))
function meta(html, name) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => attributes(tag)).filter(tag => tag.property === name || tag.name === name)
  assert.equal(tags.length, 1, 'One unambiguous ' + name)
  return tags[0].content
}
function structuredSite(html) {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs]) => attributes(attrs).type === 'application/ld+json')
  assert.equal(blocks.length, 1, 'One site structured-data block')
  return JSON.parse(blocks[0][2])
}

for (const path of ['index.html', 'dist/index.html']) {
  test(path + ' exposes the exact public PNG, dimensions, type and descriptive alt text before JavaScript runs', async () => {
    const html = await read(path)
    assert.equal(meta(html, 'og:image'), imageUrl)
    assert.equal(meta(html, 'og:image:secure_url'), imageUrl)
    assert.equal(meta(html, 'og:image:width'), '1254')
    assert.equal(meta(html, 'og:image:height'), '1254')
    assert.equal(meta(html, 'og:image:type'), 'image/png')
    assert.equal(meta(html, 'og:image:alt'), imageAlt)
    assert.equal(meta(html, 'twitter:card'), 'summary_large_image')
    assert.equal(meta(html, 'twitter:image'), imageUrl)
    assert.equal(meta(html, 'twitter:image:alt'), imageAlt)
    const site = structuredSite(html)
    assert.equal(site['@context'], 'https://schema.org'); assert.equal(site['@type'], 'WebSite')
    assert.equal(site.image, imageUrl)
    assert.doesNotMatch(html, /og-xelay-knu-20261002\.png|(?:file|blob):|generated_images|AppData[\\/]/)
  })

  test(path + ' retains the ordinary homepage identity, canonical URL and functioning SPA entry', async () => {
    const html = await read(path)
    assert.equal(html.match(/<title>([^<]+)<\/title>/)?.[1], title)
    assert.equal(meta(html, 'description'), description)
    assert.equal(meta(html, 'og:title'), title); assert.equal(meta(html, 'twitter:title'), title)
    assert.equal(meta(html, 'og:description'), description); assert.equal(meta(html, 'twitter:description'), description)
    assert.equal(meta(html, 'og:url'), 'https://www.xelay.ink/')
    const canonical = [...html.matchAll(/<link\b[^>]*>/g)].map(([tag]) => attributes(tag)).filter(tag => tag.rel === 'canonical')
    assert.deepEqual(canonical.map(tag => tag.href), ['https://www.xelay.ink/'])
    const site = structuredSite(html); assert.equal(site.url, 'https://www.xelay.ink/'); assert.equal(site.description, description)
    assert.match(html, /<div id="root"><\/div>/)
    assert.match(html, /<script type="module"[^>]*src="\/(?:src\/main\.tsx|assets\/[^"<>]+\.js)"/)
    assert.match(html, /src="\/theme-init\.js"/)
  })
}

test('the public and built image are identical to the approved 1254-square PNG, while the ordinary artwork remains intact', async () => {
  for (const directory of ['public', 'dist']) {
    const bytes = await readFile(new URL(directory + '/' + imagePath, root))
    assert.equal(hash(bytes), approvedImageHash, directory + ' approved image bytes')
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
    assert.equal(bytes.readUInt32BE(16), 1254); assert.equal(bytes.readUInt32BE(20), 1254)
    assert.ok(bytes.length > 1024 && bytes.length < 5 * 1024 * 1024)
    const ordinary = await readFile(new URL(directory + '/og-xelay-knu-20261002.png', root))
    assert.equal(hash(ordinary), ordinaryImageHash, directory + ' ordinary artwork preserved')
  }
})

test('CSP hashes cover the actual built structured data without allowing unsafe inline script or eval', async () => {
  const config = JSON.parse(await read('vercel.json'))
  const headers = config.headers.find(entry => entry.source === '/(.*)').headers
  const csp = headers.find(header => header.key === 'Content-Security-Policy').value
  assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-(?:inline|eval)/)
  assert.match(csp, /img-src 'self' https:/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(headers.find(header => header.key === 'X-Content-Type-Options').value, 'nosniff')
  const built = await read('dist/index.html')
  for (const [, script] of built.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.ok(csp.includes("'sha256-" + createHash('sha256').update(script).digest('base64') + "'"), 'CSP authorizes the exact built inline bytes')
  }
})
