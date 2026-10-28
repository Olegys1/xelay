import test from 'node:test'
import assert from 'node:assert/strict'
import{readFile}from'node:fs/promises'
const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'))
const generator=await readFile(new URL('./security/update-headers.mjs',import.meta.url),'utf8')
test('the site and header generator permit only own-origin microphone capture for explicit browser permission',()=>{
 const headers=config.headers.find(rule=>rule.source==='/(.*)').headers
 const policy=headers.find(header=>header.key==='Permissions-Policy').value
 assert.equal(policy,'camera=(self), microphone=(self), geolocation=(), payment=(self "https://secure.wayforpay.com")')
 assert.ok(generator.includes(`'Permissions-Policy': '${policy}'`))
 assert.doesNotMatch(policy,/microphone=\([^)]*(?:\*|https?:)/)
 const csp=headers.find(header=>header.key==='Content-Security-Policy').value
 assert.match(csp,/media-src 'self' https: data: blob:/)
 assert.match(csp,/frame-ancestors 'none'/)
 assert.equal(headers.find(header=>header.key==='X-Frame-Options').value,'DENY')
})
