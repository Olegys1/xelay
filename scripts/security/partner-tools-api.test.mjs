import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as crypto from 'node:crypto'
import * as net from 'node:net'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const code=ts.transpileModule(await readFile(new URL('../../server/partnerTools.ts',import.meta.url),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
}).outputText
const module={exports:{}}
runInNewContext(code,{module,exports:module.exports,Buffer,URL,AbortSignal,process:{env:{}},require(name){
  if(name==='node:crypto')return crypto
  if(name==='node:net')return net
  if(name==='@supabase/supabase-js')return {createClient(){throw Error('Network is forbidden in isolated tests')}}
  throw Error('Unexpected import '+name)
}})
const {collectPartnerClick,partnerClickOriginAllowed,partnerClickIdentity,partnerClickPayload,partnerClickService}=module.exports
const id=randomUUID(), secret='synthetic-test-only-secret-'.repeat(3)
const env={NODE_ENV:'production',VERCEL_ENV:'production',SUPABASE_SERVICE_ROLE_KEY:secret}
const request=(extra={})=>({method:'POST',headers:{host:'www.xelay.ink',origin:'https://www.xelay.ink',
  'sec-fetch-site':'same-origin','content-type':'application/json','user-agent':'Mozilla/5.0 Chrome/140.0'},
  socket:{remoteAddress:'192.0.2.20'},body:{toolId:id,source:'catalog'},...extra})
const response=()=>({headers:{},statusCode:0,body:null,setHeader(k,v){this.headers[k.toLowerCase()]=v},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}})

test('click endpoint accepts only same-origin JSON POST and drops automated/prefetch traffic before persistence',async()=>{
  let calls=0
  const service={async rpc(){calls++;return {data:{counted:true},error:null}}}
  for(const req of [request({method:'GET'}),request({method:'OPTIONS'}),request({headers:{...request().headers,origin:'https://evil.example'}}),
    request({headers:{...request().headers,host:'evil.example'}}),request({headers:{...request().headers,origin:''}}),
    request({headers:{...request().headers,'sec-fetch-site':'cross-site'}}),request({body:{toolId:id,source:'catalog',destination:'https://evil.example'}}),
    request({body:{toolId:'invalid',source:'home'}}),request({body:{toolId:id,source:'unknown'}}),
    request({headers:{...request().headers,'content-type':'text/plain'}}),request({body:'x'.repeat(1025)})]){
    const res=response();await collectPartnerClick(req,res,{service,env});assert.ok(res.statusCode>=400)
    assert.equal(res.headers['cache-control'],'no-store, private');assert.equal(res.headers['set-cookie'],undefined)
  }
  assert.equal(calls,0)
  for(const [k,v] of [['user-agent','TelegramBot'],['user-agent','Mozilla/5.0 HeadlessChrome'],['purpose','prefetch'],['sec-purpose','prefetch;prerender']]){
    const res=response();await collectPartnerClick(request({headers:{...request().headers,[k]:v}}),res,{service,env})
    assert.equal(res.statusCode,200);assert.equal(res.body.counted,false);assert.equal(res.headers['set-cookie'],undefined)
  }
  assert.equal(calls,0)
  const res=response();await collectPartnerClick(request(),res,{service,env})
  assert.equal(res.statusCode,200);assert.equal(res.body.counted,true);assert.equal(calls,1)
  assert.match(res.headers['set-cookie'],/HttpOnly; SameSite=Lax; Secure$/)
  assert.equal(res.headers['referrer-policy'],'no-referrer')
  assert.equal(Object.keys(res.body).join(','),'counted')
})

test('anonymous browser identity distinguishes campus students, refreshes cookies and survives midnight; network pseudonyms rotate daily',()=>{
  const req=request();const now=new Date('2026-11-12T12:00:00Z')
  const first=partnerClickIdentity(req,secret,now,env)
  const second=partnerClickIdentity(req,secret,now,env)
  assert.notEqual(first.fingerprint,second.fingerprint)
  assert.equal(first.networkFingerprint,second.networkFingerprint)
  const cookie=first.cookie.split(';')[0]
  const repeat=partnerClickIdentity(request({headers:{...req.headers,cookie}}),secret,now,env)
  assert.equal(repeat.fingerprint,first.fingerprint);assert.equal(repeat.cookie,first.cookie)
  const next=partnerClickIdentity(request({headers:{...req.headers,cookie}}),secret,new Date('2026-11-13T00:00:00Z'),env)
  assert.equal(next.fingerprint,first.fingerprint);assert.notEqual(next.networkFingerprint,first.networkFingerprint)
  assert.match(first.fingerprint,/^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(first).includes('192.0.2.20'),false)
  assert.equal(first.cookie.includes(secret),false)
  const forged=partnerClickIdentity(request({headers:{...req.headers,cookie:cookie.replace(/.$/,'!')}}),secret,now,env)
  assert.ok(forged.cookie);assert.notEqual(forged.fingerprint,first.fingerprint)
  const spoof=partnerClickIdentity(request({headers:{...req.headers,cookie,'x-forwarded-for':'198.51.100.9'}}),secret,now,env)
  assert.equal(spoof.networkFingerprint,first.networkFingerprint)
  const trusted=partnerClickIdentity(request({headers:{...req.headers,cookie,'x-forwarded-for':'198.51.100.9'}}),secret,now,{...env,VERCEL:'1'})
  assert.notEqual(trusted.networkFingerprint,first.networkFingerprint)
  const ignored=partnerClickIdentity(request({headers:{...req.headers,cookie}}),secret,now,env,randomUUID())
  assert.equal(ignored.fingerprint,first.fingerprint)
})

test('parallel first clicks share an anonymous browser id before the signed cookie response arrives',async()=>{
  const browserId=randomUUID(), fingerprints=new Set(), cookies=new Set();let counted=0
  const service={async rpc(_name,args){const duplicate=fingerprints.has(args.p_fingerprint);fingerprints.add(args.p_fingerprint);if(!duplicate)counted++;return {data:{counted:!duplicate},error:null}}}
  const responses=await Promise.all(Array.from({length:20},async()=>{
    const res=response();await collectPartnerClick(request({body:{toolId:id,source:'catalog',browserId}}),res,{env,service});cookies.add(res.headers['set-cookie']);return res
  }))
  assert.equal(counted,1);assert.equal(cookies.size,1);assert.equal(fingerprints.size,1)
  assert.equal(responses.filter(r=>r.body.counted).length,1)
  const bad=response();await collectPartnerClick(request({body:{toolId:id,source:'home',browserId:'not-an-anonymous-uuid'}}),bad,{env,service});assert.equal(bad.statusCode,400)
})

test('collector forwards only bounded identifiers and hides backend details on failure',async()=>{
  let captured
  const req=request();const res=response()
  await collectPartnerClick(req,res,{env,now:new Date('2026-11-12T12:00:00Z'),service:{async rpc(name,args){captured={name,args};return {data:{counted:false},error:null}}}})
  assert.equal(res.statusCode,200);assert.equal(res.body.counted,false)
  assert.equal(captured.name,'xelay_record_partner_click')
  assert.equal(captured.args.p_tool_id,id);assert.equal(captured.args.p_source,'catalog')
  assert.deepEqual(Object.keys(captured.args).sort(),['p_fingerprint','p_network_fingerprint','p_source','p_tool_id'])
  assert.match(captured.args.p_fingerprint,/^[a-f0-9]{64}$/)
  for(const result of [{error:{message:'a synthetic database secret'},data:null},{error:null,data:{}},null]){
    const failure=response();await collectPartnerClick(req,failure,{env,service:{async rpc(){if(result===null)throw Error('private failure');return result}}})
    assert.equal(failure.statusCode,503);assert.equal(failure.headers['set-cookie'],undefined)
    assert.equal(JSON.stringify(failure.body).includes('secret'),false);assert.equal(JSON.stringify(failure.body).includes('private'),false)
  }
  const missing=response();await collectPartnerClick(req,missing,{env:{},service:{async rpc(){throw Error('must not execute')}}})
  assert.equal(missing.statusCode,503)
})

test('local and deployment origins are narrowly scoped, and hostile JSON cannot smuggle destinations',()=>{
  assert.equal(partnerClickOriginAllowed(request(),env),true)
  assert.equal(partnerClickOriginAllowed(request({headers:{...request().headers,host:'branch.vercel.app',origin:'https://branch.vercel.app'}}),
    {VERCEL_ENV:'preview',VERCEL_URL:'branch.vercel.app'}),true)
  assert.equal(partnerClickOriginAllowed(request({headers:{...request().headers,host:'other.vercel.app',origin:'https://other.vercel.app'}}),
    {VERCEL_ENV:'preview',VERCEL_URL:'branch.vercel.app'}),false)
  assert.equal(partnerClickOriginAllowed(request({headers:{...request().headers,host:'localhost:3113',origin:'http://localhost:3113'}}),{NODE_ENV:'development'}),true)
  assert.equal(partnerClickOriginAllowed(request({headers:{...request().headers,host:'localhost:3113',origin:'http://localhost:3113'}}),env),false)
  assert.throws(()=>partnerClickPayload(request({body:'{"toolId":"'+id+'","source":"home","__proto__":{"trusted":true}}'})))
  assert.equal(partnerClickPayload(request({body:Buffer.from(JSON.stringify({toolId:id,source:'home'}))})).source,'home')
  assert.throws(()=>partnerClickService({SUPABASE_URL:'http://localhost',SUPABASE_SERVICE_ROLE_KEY:secret}))
})
