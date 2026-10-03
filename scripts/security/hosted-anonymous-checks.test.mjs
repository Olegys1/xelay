import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN } from './hosted-media-checks.mjs'
import { ANONYMOUS_CHECKS,parseAnonymousConfiguration,assertAnonymousRequest,classifyAnonymousResponse,
  runAnonymousChecks } from './hosted-anonymous-checks.mjs'
const jwt=(role='anon',ref=STAGING_REF,exp=Math.floor(Date.now()/1000)+1000)=>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({role,ref,exp})).toString('base64url')}.offline-signature`
const config=async()=>parseAnonymousConfiguration({XELAY_HOSTED_ANON_KEY:jwt()},['--execute'])

test('anonymous hosted checks default to zero requests without key or mode file reads',async()=>{
  let calls=0
  const result=await runAnonymousChecks(await parseAnonymousConfiguration({},[]),{fetchImpl:()=>{calls++;throw Error('unexpected')}})
  assert.equal(calls,0);assert.equal(result.requests,0);assert.equal(result.pending,1)
  assert.equal((await parseAnonymousConfiguration({},['--mode-file','unavailable.json'])).execute,false)
})
test('configuration accepts only isolated test1 public credentials and no foreign mode path',async()=>{
  assert.equal((await config()).origin,STAGING_ORIGIN)
  for(const key of [jwt('service_role'),jwt('authenticated'),jwt('anon','production'),jwt('anon',STAGING_REF,1),'sb_secret_never_use_service_credentials']) {
    await assert.rejects(parseAnonymousConfiguration({XELAY_HOSTED_ANON_KEY:key},['--execute']),/CONFIGURATION_INVALID/)
  }
  await assert.rejects(parseAnonymousConfiguration({XELAY_HOSTED_ANON_REF:'production'},[]),/CONFIGURATION_INVALID/)
  await assert.rejects(parseAnonymousConfiguration({},['--execute','--mode-file','../elsewhere.json']),/CONFIGURATION_INVALID/)
  await assert.rejects(parseAnonymousConfiguration({},['--execute','--password','ignored']),/CONFIGURATION_INVALID/)
})
test('explicit ignored mode file accepts exact project/public key only and rejects unexpected credential fields',async()=>{
  const directory=fileURLToPath(new URL('../../.security-audit.local/',import.meta.url))
  await mkdir(directory,{recursive:true})
  const temporary=await mkdtemp(join(directory,'anonymous-check-offline-'))
  const path=join(temporary,'mode.json')
  const mode={mode:'test1-anonymous-readonly',projectRef:STAGING_REF,origin:STAGING_ORIGIN,publicKey:jwt()}
  try {
    await writeFile(path,JSON.stringify(mode))
    assert.equal((await parseAnonymousConfiguration({},['--execute','--mode-file',path])).key,mode.publicKey)
    await assert.rejects(parseAnonymousConfiguration({XELAY_HOSTED_ANON_KEY:jwt()},['--execute','--mode-file',path]),/CONFIGURATION_INVALID/)
    await writeFile(path,JSON.stringify({...mode,userToken:'offline-secret'}))
    await assert.rejects(parseAnonymousConfiguration({},['--execute','--mode-file',path]),/CONFIGURATION_INVALID/)
    await writeFile(path,JSON.stringify({...mode,projectRef:'production'}))
    await assert.rejects(parseAnonymousConfiguration({},['--execute','--mode-file',path]),/CONFIGURATION_INVALID/)
  } finally {await unlink(path);await rmdir(temporary)}
})
test('request guard permits exactly named GET checks, not arbitrary routes, mutations, filters or hosts',()=>{
  assert.equal(ANONYMOUS_CHECKS.length,20)
  for(const check of ANONYMOUS_CHECKS)assertAnonymousRequest(STAGING_ORIGIN+check.path)
  for(const url of ['https://production.supabase.co/rest/v1/profiles?select=email&limit=1',
    STAGING_ORIGIN+'/auth/v1/signup',STAGING_ORIGIN+'/rest/v1/rpc/xelay_create_checkout',
    STAGING_ORIGIN+'/rest/v1/profiles?select=email&limit=1000'])assert.throws(()=>assertAnonymousRequest(url),/REQUEST_DENIED/)
  assert.throws(()=>assertAnonymousRequest(STAGING_ORIGIN+ANONYMOUS_CHECKS[0].path,{method:'POST'}),/REQUEST_DENIED/)
  assert.throws(()=>assertAnonymousRequest(STAGING_ORIGIN+ANONYMOUS_CHECKS[0].path,{body:'sensitive'}),/REQUEST_DENIED/)
})
test('response classification treats public profile RPC as legitimate and empty private rows are no ACL proof',()=>{
  const profile=ANONYMOUS_CHECKS.find(check=>check.id==='public_profile_contract')
  assert.equal(classifyAnonymousResponse(profile,200,[]).passed,true)
  const closed=ANONYMOUS_CHECKS.find(check=>check.id==='profile_email_closed')
  assert.equal(classifyAnonymousResponse(closed,200,[]).passed,false)
  assert.equal(classifyAnonymousResponse(closed,401,{code:'42501'}).passed,true)
  assert.equal(classifyAnonymousResponse(closed,404,{code:'PGRST205'}).hidden,true)
  assert.equal(classifyAnonymousResponse(closed,500,{code:'42501'}).passed,false)
  assert.equal(classifyAnonymousResponse(closed,404,{code:'42703'}).passed,false)
  assert.equal(classifyAnonymousResponse(closed,401,{code:'invalid_jwt'}).passed,false)
})
test('mock complete suite is sequential and reports counts/status/code without records, PII or credentials',async()=>{
  const secret='synthetic-private-email@example.test'
  let calls=0,active=false
  const fake=async(url,init)=>{
    assert.equal(active,false);active=true
    assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store')
    const check=ANONYMOUS_CHECKS[calls++]
    assert.equal(url,STAGING_ORIGIN+check.path)
    active=false
    if(check.expected==='closed')return new Response(JSON.stringify({code:'42501',message:secret,details:init.headers.apikey}),{status:401})
    if(check.expected==='settings')return new Response(JSON.stringify({disable_signup:false,external:{}}))
    if(check.expected==='catalog')return new Response(JSON.stringify([{id:'synthetic-catalog-id'}]))
    return new Response('[]')
  }
  const result=await runAnonymousChecks(await config(),{fetchImpl:fake})
  assert.equal(calls,20);assert.equal(result.checksPassed,20);assert.equal(result.checksFailed,0);assert.equal(result.pending,0)
  assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('offline-signature'),false)
})
test('redirects and raw network errors stop without following or leaking, and body size is bounded',async()=>{
  let calls=0
  const redirected=await runAnonymousChecks(await config(),{fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://foreign.test/token'}})}})
  assert.equal(calls,1);assert.equal(redirected.checksFailed,1);assert.equal(redirected.results[0].errorCode,'RESPONSE_REDIRECT_DENIED')
  const failed=await runAnonymousChecks(await config(),{fetchImpl:async()=>{throw Error('private-email@example.test and token')}})
  assert.equal(failed.results[0].errorCode,'REQUEST_FAILED');assert.equal(JSON.stringify(failed).includes('private-email'),false)
  const large=await runAnonymousChecks(await config(),{fetchImpl:async()=>new Response(' '.repeat(65537))})
  assert.equal(large.results[0].errorCode,'RESPONSE_LIMIT')
})
