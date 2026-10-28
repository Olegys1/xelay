// Accident prevention for synthetic tests, not an OS sandbox for hostile code.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const deny = () => { throw Object.assign(new Error('SECURITY_TEST_OFFLINE: real network and subprocesses are disabled'), { code: 'SECURITY_TEST_OFFLINE' }) }
globalThis.fetch = async () => deny()
globalThis.WebSocket = class { constructor() { deny() } }
for (const target of [http, https]) for (const key of ['get', 'request']) target[key] = deny
net.connect = net.createConnection = deny
net.Socket.prototype.connect = deny
tls.connect = deny
dgram.createSocket = deny
for (const target of [dns, dnsPromises]) for (const key of Object.keys(target)) {
  if (/^(lookup|resolve|reverse)/.test(key) && typeof target[key] === 'function') target[key] = deny
}
// Vite's build needs the installed esbuild executable. This switch is set only
// on the explicit build child; it is never passed to regression test children.
if (process.env.XELAY_SECURITY_CI_BUILD !== 'true') {
  for (const key of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[key] = deny
}
syncBuiltinESMExports()
