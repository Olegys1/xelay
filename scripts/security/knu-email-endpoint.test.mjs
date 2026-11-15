// Isolated endpoint contracts only. Fictional identities, no Auth or mail traffic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as crypto from 'node:crypto'
const read=path=>readFile(new URL('../../'+path,import.meta.url),'utf8')
function load(source,imports,extra={}) {
  const module={exports:{}}
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module,exports:module.exports,Buffer,URL,Date,Error,AbortSignal,console:{error(){throw Error('No diagnostics may contain private mail data')},log(){throw Error('No diagnostics expected')}},
    require:name=>{assert.ok(Object.hasOwn(imports,name),'Unexpected import '+name);return imports[name]},...extra,
  })
  return module.exports
}
const policy=load(await read('src/lib/knuEmailPolicy.ts'),{})
const source=await read('server/knuEmail.ts')
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222'
const email='synthetic.student@knu.ua',origin='https://fictional-app.example'
const flat={verifiedEmail:null,verifiedAt:null,authEmailVerified:false}
const challenge={id,email,expiresAt:'2099-01-01T00:10:00Z',resendAt:'2099-01-01T00:01:00Z'}
const plain=value=>JSON.parse(JSON.stringify(value))
function fixture(options={}) {
  const events=[],env={KNU_EMAIL_VERIFICATION_ENABLED:'true',KNU_EMAIL_AUTH_CONFIRMATION_REVIEWED:'true',
    SUPABASE_URL:'https://fictional-project.example',XELAY_PUBLIC_URL:origin,SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',SUPABASE_ANON_KEY:'synthetic-anon',
    KNU_EMAIL_CODE_SECRET:'synthetic-test-only-hmac-secret-at-least-32-bytes',RESEND_API_KEY:'synthetic-resend',XELAY_EMAIL_FROM:'Xelay <notifications@fictional.example>',...options.env}
  const status={...flat,...options.status}
  const service={auth:{async getUser(token){events.push(['auth',token]);return{data:{user:{id:actor}},error:options.authError||null}},admin:{async getUserById(){return{data:{user:{id:actor,email:'legacy@fictional.example',email_confirmed_at:'2026-01-01T00:00:00Z',...options.user}},error:null}}}},
    async rpc(name,args){events.push(['rpc',name,plain(args)])
      if(options.rpc)return options.rpc(name,args)
      if(name==='xelay_knu_email_prepare')return{data:options.prepare||{ok:true,id},error:null}
      if(name==='xelay_knu_email_delivery')return{data:{ok:true,status:{...status,...(args.p_delivered?{challenge}:{})}},error:null}
      if(name==='xelay_knu_email_challenge')return{data:options.context||{ok:true,email},error:null}
      if(name==='xelay_knu_email_verify')return{data:options.verify||{ok:true,status:{verifiedEmail:email,verifiedAt:'2026-11-03T12:00:00Z',authEmailVerified:false}},error:null}
      throw Error('Unexpected service RPC '+name)
    }}
  const createClient=(_url,key,settings)=>{events.push(['client',key]);return settings.global.headers?{async rpc(name){assert.equal(name,'xelay_knu_email_status');return{data:options.status||flat,error:null}}}:service}
  const api=load(source,{'node:crypto':{...crypto,randomUUID:()=>id,randomInt:()=>123456},'@supabase/supabase-js':{createClient},'../src/lib/knuEmailPolicy.js':policy},{
    process:{env},async fetch(url,init){assert.equal(url,'https://api.resend.com/emails');events.push(['mail',plain(JSON.parse(init.body)),init]);if(options.mailError)throw options.mailError;return new Response(JSON.stringify(options.provider||{id:'synthetic-delivery'}),{status:options.mailStatus||200,headers:{'Content-Type':'application/json'}})},
  })
  async function run(body,patch={}){
    const req={method:body?'POST':'GET',body,...patch,headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json',authorization:'Bearer synthetic-token',...patch.headers}}
    const res={headers:{},setHeader(name,value){this.headers[name]=value},status(value){this.statusCode=value;return this},json(value){this.body=plain(value);return this}}
    await api.handleKnuEmail(req,res);return res
  }
  return{events,env,run}
}
test('default-off and unreviewed confirmation configuration never contact Auth or send mail',async()=>{
  for(const env of[{KNU_EMAIL_VERIFICATION_ENABLED:'false'},{KNU_EMAIL_VERIFICATION_ENABLED:undefined},{KNU_EMAIL_AUTH_CONFIRMATION_REVIEWED:'false'},{KNU_EMAIL_CODE_SECRET:''}]){
    const fx=fixture({env}),res=await fx.run({action:'request',email});assert.equal(res.statusCode,503);assert.equal(res.body.code,'KNU_EMAIL_UNAVAILABLE');assert.equal(fx.events.length,0)
  }
})
test('status uses the current bearer and returns only the own status shape without sending mail',async()=>{
  const fx=fixture({status:{...flat,unexpected_private_digest:'SECRET'}}),res=await fx.run()
  assert.equal(res.statusCode,200);assert.deepEqual(res.body,flat);assert.equal(fx.events.some(([kind])=>kind==='mail'),false)
  assert.match(res.headers['Cache-Control'],/no-store/)
})
test('request reserves a private HMAC challenge, sends one code and activates it only after acceptance',async()=>{
  const fx=fixture(),res=await fx.run({action:'request',email:' Synthetic.Student@KNU.UA '})
  assert.equal(res.statusCode,200);assert.deepEqual(res.body,{...flat,challenge})
  const prepare=fx.events.find(event=>event[1]==='xelay_knu_email_prepare')[2]
  assert.equal(prepare.p_user,actor);assert.equal(prepare.p_email,email);assert.equal(prepare.p_id,id)
  assert.equal(prepare.p_digest,crypto.createHmac('sha256',fx.env.KNU_EMAIL_CODE_SECRET).update(['xelay-knu-v1',actor,email,id,'123456'].join('\n')).digest('hex'))
  assert.equal(fx.events.filter(([kind])=>kind==='mail').length,1)
  const mail=fx.events.find(([kind])=>kind==='mail');assert.deepEqual(mail[1].to,[email]);assert.match(mail[1].text,/123456/)
  assert.equal(mail[2].redirect,'error');assert.equal(mail[2].headers['Idempotency-Key'],`xelay-knu-email/${id}`)
  assert.ok(fx.events.findIndex(([kind])=>kind==='mail')>fx.events.findIndex(event=>event[1]==='xelay_knu_email_prepare'))
  assert.ok(fx.events.findIndex(event=>event[1]==='xelay_knu_email_delivery')>fx.events.findIndex(([kind])=>kind==='mail'))
  assert.doesNotMatch(JSON.stringify(res.body),/123456|synthetic-service|synthetic-resend|digest|code_digest/)
})
test('verify recomputes digest from a private own challenge context and never resends mail',async()=>{
  const fx=fixture(),res=await fx.run({action:'verify',challengeId:id,code:'000123'})
  assert.equal(res.statusCode,200);assert.equal(res.body.verifiedEmail,email)
  const verify=fx.events.find(event=>event[1]==='xelay_knu_email_verify')[2]
  assert.equal(verify.p_digest,crypto.createHmac('sha256',fx.env.KNU_EMAIL_CODE_SECRET).update(['xelay-knu-v1',actor,email,id,'000123'].join('\n')).digest('hex'))
  assert.equal(fx.events.some(([kind])=>kind==='mail'),false)
  assert.doesNotMatch(JSON.stringify(res.body),/000123|synthetic-token|digest/)
})
test('bad domains, extra actor fields, cross-origin and malformed codes fail before Auth or mail',async()=>{
  for(const [body,patch]of[
    [{action:'request',email:'student@knu.ua.attacker.example'},{}],
    [{action:'request',email:'student@faculty.knu.ua'},{}],
    [{action:'request',email:'student@Knu.ua'},{}],
    [{action:'request',email,userId:actor},{}],
    [{action:'verify',challengeId:id,code:'12345'},{}],
    [{action:'verify',challengeId:id,code:123456},{}],
    [{action:'request',email},{headers:{origin:'https://other.example'}}],
    [{action:'request',email},{headers:{'sec-fetch-site':'cross-site'}}],
  ]){const fx=fixture(),res=await fx.run(body,patch);assert.ok([400,401].includes(res.statusCode));assert.equal(fx.events.length,0)}
})
test('unconfirmed, banned or expired actors cannot obtain a challenge',async()=>{
  for(const options of[{user:{email_confirmed_at:null}},{user:{banned_until:'2099-01-01T00:00:00Z'}},{user:{deleted_at:'2026-01-01'}},{authError:{message:'PRIVATE_AUTH_DETAIL'}}]){
    const fx=fixture(options),res=await fx.run({action:'request',email});assert.ok([401,403].includes(res.statusCode));assert.equal(fx.events.some(([kind])=>kind==='mail'||kind==='rpc'),false);assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE_AUTH/)
  }
})
test('rate limits block sending; verified ownership can report a collision without leaking identifiers',async()=>{
  const limited=fixture({prepare:{ok:false,code:'KNU_EMAIL_RATE_LIMIT',retryAfterSeconds:60,private:'SECRET'}}),rate=await limited.run({action:'request',email})
  assert.equal(rate.statusCode,429);assert.equal(rate.body.code,'KNU_EMAIL_RATE_LIMIT');assert.equal(rate.headers['Retry-After'],'60')
  assert.equal(limited.events.some(([kind])=>kind==='mail'),false);assert.doesNotMatch(JSON.stringify(rate.body),/SECRET/)
  const occupied=fixture({verify:{ok:false,code:'KNU_EMAIL_IN_USE',private:'SECRET'}}),conflict=await occupied.run({action:'verify',challengeId:id,code:'123456'})
  assert.equal(conflict.statusCode,409);assert.equal(conflict.body.code,'KNU_EMAIL_IN_USE')
  assert.equal(occupied.events.some(([kind])=>kind==='mail'),false);assert.doesNotMatch(JSON.stringify(conflict.body),/SECRET|123456/)
})
test('rejected or uncertain provider delivery leaves no active challenge or verified status',async()=>{
  for(const options of[{mailStatus:429,provider:{message:'PRIVATE_PROVIDER_DETAIL'}},{mailError:new Error('PRIVATE_PROVIDER_DETAIL')}]){
    const fx=fixture(options),res=await fx.run({action:'request',email})
    assert.equal(res.statusCode,503);assert.equal(fx.events.find(event=>event[1]==='xelay_knu_email_delivery')[2].p_delivered,false)
    assert.equal(res.body.verifiedEmail,undefined);assert.doesNotMatch(JSON.stringify(res.body),/PRIVATE_PROVIDER_DETAIL/)
  }
})
test('foreign, consumed or expired challenge context cannot reach digest consumption',async()=>{
  for(const code of['KNU_EMAIL_CODE_INVALID','KNU_EMAIL_CODE_EXPIRED']){
    const fx=fixture({context:{ok:false,code}}),res=await fx.run({action:'verify',challengeId:id,code:'123456'})
    assert.equal(res.statusCode,400);assert.equal(res.body.code,code);assert.equal(fx.events.some(event=>event[1]==='xelay_knu_email_verify'),false)
  }
})
