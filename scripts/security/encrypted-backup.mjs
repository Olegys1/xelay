// This tool reads data only. pg_restore must be exercised on a separate project.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, open, unlink, rmdir } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const MAGIC = Buffer.from('XELAYB01')
const MANIFEST_PURPOSE = 'xelay-backup-manifest-v2\0'

export function signManifest(payload, password) {
  if (password.length < 20) throw new Error('Use a backup passphrase of at least 20 characters')
  const salt = randomBytes(16).toString('hex')
  const serialized = JSON.stringify(payload)
  if (serialized.length > 4_000_000) throw new Error('Backup inventory exceeds the supported size')
  const mac = createHmac('sha256', scryptSync(password, Buffer.from(salt, 'hex'), 32)).update(MANIFEST_PURPOSE).update(serialized).digest('hex')
  return { version: 2, salt, payload: serialized, mac }
}

export function authenticateManifest(envelope, password) {
  if (password.length < 20 || envelope.version !== 2 || !/^[0-9a-f]{32}$/.test(envelope.salt || '')
    || !/^[0-9a-f]{64}$/.test(envelope.mac || '') || typeof envelope.payload !== 'string' || envelope.payload.length > 4_000_000) throw new Error('Invalid authenticated manifest')
  const expected = createHmac('sha256', scryptSync(password, Buffer.from(envelope.salt, 'hex'), 32)).update(MANIFEST_PURPOSE).update(envelope.payload).digest()
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw new Error('Manifest authentication failed')
  const manifest = JSON.parse(envelope.payload)
  if (manifest.complete !== true || !/^[a-z]{20}$/.test(manifest.project || '') || !Number.isSafeInteger(manifest.storageFiles)
    || manifest.storageFiles < 0 || !Array.isArray(manifest.files) || manifest.files.length !== manifest.storageFiles + 1
    || manifest.files.filter((file) => file.name === 'database.enc').length !== 1
    || new Set(manifest.files.map((file) => file.name)).size !== manifest.files.length
    || manifest.files.some((file) => !/^(database|[0-9a-f]{64})\.enc$/.test(file.name || '') || !/^[0-9a-f]{64}$/.test(file.sha256 || ''))
    || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Backup inventory is incomplete')
  return manifest
}

export async function verifyBackup(folder, password) {
  const manifest = authenticateManifest(JSON.parse(await readFile(resolve(folder, 'manifest.json'), 'utf8')), password)
  const listed = (await readdir(folder)).filter((file) => file.endsWith('.enc')).sort()
  if (JSON.stringify(listed) !== JSON.stringify(manifest.files.map((item) => item.name).sort())) throw new Error('Backup files are missing or unexpected')
  for (const item of manifest.files) if (await verifySealed(resolve(folder, item.name), password) !== item.sha256) throw new Error('Backup integrity check failed')
  return manifest
}

// Explicit, local-only recovery export. Original Storage names stay inside
// payload headers and can never become filesystem paths. No SQL is restored.
export async function exportBackup(folder, password, destination) {
  const manifest = await verifyBackup(folder, password)
  const target = resolve(destination)
  await mkdir(target, {mode: 0o700}) // Fail if it exists, including the backup folder.
  const created = []
  try {
    for (const item of manifest.files) {
      const source = resolve(folder, item.name)
      const output = resolve(target, item.name === 'database.enc' ? 'database.dump' : item.name.replace(/\.enc$/, '.payload'))
      if (dirname(output) !== target) throw new Error('Invalid recovery path')
      await writeFile(output, '', {flag: 'wx', mode: 0o600})
      created.push(output)
      const handle = await open(source, 'r')
      const header = Buffer.alloc(36), tag = Buffer.alloc(16)
      let size
      try { size = (await handle.stat()).size; await handle.read(header,0,36,0); await handle.read(tag,0,16,size-16) }
      finally { await handle.close() }
      if (!header.subarray(0,8).equals(MAGIC)) throw new Error('Invalid recovery header')
      const decipher = createDecipheriv('aes-256-gcm', scryptSync(password,header.subarray(8,24),32),header.subarray(24,36))
      decipher.setAAD(MAGIC); decipher.setAuthTag(tag)
      async function* cleartext() {
        if (size > 52) for await (const chunk of createReadStream(source,{start:36,end:size-17})) yield decipher.update(chunk)
        yield decipher.final()
      }
      await pipeline(Readable.from(cleartext()),createWriteStream(output,{flags:'w',mode:0o600}))
    }
    return { project: manifest.project, storageFiles: manifest.storageFiles }
  } catch (error) {
    // Only exact files created in this new directory are removed; never recurse.
    for (const file of created) if (dirname(file) === target) await unlink(file).catch(() => {})
    await rmdir(target).catch(() => {})
    throw error
  }
}
export async function seal(stream, output, password) {
  if (password.length < 20) throw new Error('Use a backup passphrase of at least 20 characters')
  const salt = randomBytes(16), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password,salt,32), iv)
  cipher.setAAD(MAGIC)
  const destination = createWriteStream(output, { flags: 'wx', mode: 0o600 })
  destination.write(Buffer.concat([MAGIC,salt,iv]))
  await pipeline(stream,cipher,destination,{end:false})
  destination.end(cipher.getAuthTag())
  await new Promise((done,fail) => { destination.on('finish',done); destination.on('error',fail) })
}
export async function verifySealed(file,password) {
  const handle = await open(file,'r')
  const header=Buffer.alloc(36),tag=Buffer.alloc(16)
  let size
  try {
    size=(await handle.stat()).size
    if(size<52) throw new Error('Invalid encrypted backup')
    await handle.read(header,0,36,0); await handle.read(tag,0,16,size-16)
  } finally { await handle.close() }
  if (!header.subarray(0,8).equals(MAGIC)) throw new Error('Invalid encrypted backup')
  const decipher = createDecipheriv('aes-256-gcm',scryptSync(password,header.subarray(8,24),32),header.subarray(24,36))
  decipher.setAAD(MAGIC); decipher.setAuthTag(tag)
  // Verification emits no decrypted data, names, emails, messages, or keys.
  const digest=createHash('sha256').update(header)
  if(size>52) for await(const chunk of createReadStream(file,{start:36,end:size-17})) { digest.update(chunk); decipher.update(chunk) }
  decipher.final()
  return digest.update(tag).digest('hex')
}

async function main() {
  const password = process.env.XELAY_BACKUP_PASSPHRASE || ''
  const mode = process.argv[2]
  const folder = resolve(process.argv[3] || '.security-backups.local')
  if (mode === 'export') {
    if (!process.argv[4]) throw new Error('Provide a new private directory for decrypted recovery files')
    const result = await exportBackup(folder, password, process.argv[4])
    console.log(`Recovery files exported for project ${result.project}: database + ${result.storageFiles} payloads. These files are plaintext; restore only to a separate project first.`)
    return
  }
  if (mode === 'verify') {
    const manifest = await verifyBackup(folder, password)
    console.log(`Authenticated inventory and encrypted integrity verified: ${manifest.files.length} files. Database restore is still required.`)
    return
  }
  if (mode !== 'create') throw new Error('Use create, verify or export with a new private recovery directory')
  const expected = process.env.XELAY_BACKUP_EXPECTED_PROJECT || ''
  const url = process.env.SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const database = new URL(process.env.XELAY_BACKUP_DATABASE_URL || '')
  const databaseHostAllowed = database.hostname === `db.${expected}.supabase.co`
    || (/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(database.hostname) && decodeURIComponent(database.username) === `postgres.${expected}`)
  if (!/^[a-z]{20}$/.test(expected) || new URL(url).protocol !== 'https:' || new URL(url).hostname !== `${expected}.supabase.co` || !key
    || !['postgres:', 'postgresql:'].includes(database.protocol) || !databaseHostAllowed) throw new Error('Backup project identity or credentials are incomplete')
  if (process.env.XELAY_BACKUP_WRITES_QUIESCED !== 'true') throw new Error('Pause application writes and cleanup before the coordinated backup')
  if (password.length < 20) throw new Error('Use a backup passphrase of at least 20 characters')
  await mkdir(dirname(folder),{recursive:true})
  await mkdir(folder, {mode: 0o700}) // Existing backup directories are never overwritten.
  const runtimeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','APPDATA','LOCALAPPDATA'].includes(name.toUpperCase())))
  const pg = spawn(process.env.XELAY_PG_DUMP || 'pg_dump', ['--format=custom','--no-owner','--schema=public','--schema=auth','--schema=storage'], {
    env: { ...runtimeEnv, PGHOST: database.hostname, PGPORT: database.port || '5432', PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password), PGDATABASE: database.pathname.slice(1) || 'postgres', PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env.XELAY_BACKUP_SSL_ROOT_CERT || 'system' }, stdio:['ignore','pipe','pipe'], windowsHide:true,
  })
  // Discard stderr; a provider error could echo a credential-bearing connection.
  pg.stderr.resume()
  const completion = new Promise((done,fail) => { pg.on('error',fail); pg.on('close',(code)=>code===0?done():fail(new Error('pg_dump failed; check database connection locally'))) })
  try { await Promise.all([seal(pg.stdout,resolve(folder,'database.enc'),password),completion]) }
  catch { pg.kill(); throw new Error('Database backup failed; this backup directory is incomplete') }
  const client = createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
  const buckets = await client.storage.listBuckets()
  if (buckets.error) throw new Error('Storage inventory failed; backup is incomplete')
  let files = 0
  for (const bucket of buckets.data || []) {
    const folders = ['']
    while (folders.length) {
      const prefix = folders.pop()
      for (let offset=0;;offset+=100) {
        const listing = await client.storage.from(bucket.id).list(prefix,{limit:100,offset,sortBy:{column:'name',order:'asc'}})
        if (listing.error) throw new Error('Storage inventory failed; backup is incomplete')
        for (const object of listing.data || []) {
          const name = prefix ? `${prefix}/${object.name}` : object.name
          if (!object.id) { folders.push(name); continue }
          const encodedPath = name.split('/').map(encodeURIComponent).join('/')
          const download = await fetch(`${url.replace(/\/$/,'')}/storage/v1/object/authenticated/${encodeURIComponent(bucket.id)}/${encodedPath}`, {
            headers:{apikey:key,authorization:`Bearer ${key}`},signal:AbortSignal.timeout(300000),
          })
          if (!download.ok || !download.body) throw new Error('Storage download failed; backup is incomplete')
          const label = createHash('sha256').update(`${bucket.id}/${name}`).digest('hex')
          // Encrypted object includes its restore locator and original metadata.
          const metadata = Buffer.from(JSON.stringify({bucket:bucket.id,name,metadata:object.metadata})+'\n')
          async function* payload() { yield metadata; for await (const chunk of Readable.fromWeb(download.body)) yield chunk }
          await seal(Readable.from(payload()),resolve(folder,`${label}.enc`),password)
          files++
        }
        if ((listing.data || []).length<100) break
      }
    }
  }
  const inventory = []
  for (const name of (await readdir(folder)).filter((item)=>item.endsWith('.enc')).sort()) inventory.push({name,sha256:await verifySealed(resolve(folder,name),password)})
  await writeFile(resolve(folder,'manifest.json'),JSON.stringify(signManifest({complete:true,project:expected,createdAt:new Date().toISOString(),storageFiles:files,files:inventory},password),null,2),{flag:'wx',mode:0o600})
  console.log(`Backup completed: database + ${files} encrypted Storage files. Verify and test a separate restore.`)
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error('Backup failed or incomplete. Check credentials/runtime locally; no secrets were printed.'); process.exitCode=1 })
}
