import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { normalizeKnuEmail } from '../src/lib/knuEmailPolicy.js'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UNAVAILABLE='Підтвердження пошти КНУ поки недоступне. Ваш звичайний вхід і дані залишаються без змін.'
const ERRORS: Record<string,{status:number;message:string}>={
  AUTH_REQUIRED:{status:401,message:'Увійдіть до свого акаунта Xelay.'},
  EMAIL_CONFIRMATION_REQUIRED:{status:403,message:'Спочатку підтвердьте пошту свого акаунта Xelay.'},
  KNU_EMAIL_INVALID:{status:400,message:'Вкажіть свою корпоративну пошту з точним закінченням @knu.ua.'},
  KNU_EMAIL_IN_USE:{status:409,message:'Ця пошта вже пов’язана з іншим акаунтом. Зверніться до підтримки, щоб зберегти свої дані.'},
  KNU_EMAIL_RATE_LIMIT:{status:429,message:'Коди надсилалися надто часто. Зачекайте перед наступною спробою.'},
  KNU_EMAIL_CODE_INVALID:{status:400,message:'Код неправильний або вже використаний. Перевірте останній лист чи запросіть новий код.'},
  KNU_EMAIL_CODE_EXPIRED:{status:400,message:'Строк дії коду завершився. Запросіть новий код.'},
  KNU_EMAIL_UNAVAILABLE:{status:503,message:UNAVAILABLE},
}
class KnuEmailError extends Error {
  constructor(readonly code:string,readonly retryAfterSeconds?:number) { super((ERRORS[code]||ERRORS.KNU_EMAIL_UNAVAILABLE).message);this.name='KnuEmailError' }
}
type Settings={url:string;origin:string;serviceKey:string;callerKey:string;secret:string;resendKey:string;from:string}
type Status={verifiedEmail:string|null;verifiedAt:string|null;authEmailVerified:boolean;challenge?:{id:string;email:string;expiresAt:string;resendAt:string}}
type Command={action:'request';email:string}|{action:'verify';challengeId:string;code:string}

function configuration():Settings {
  // Neither local preview nor an unset flag can send mail or contact Auth.
  if(process.env.KNU_EMAIL_VERIFICATION_ENABLED!=='true'
    ||process.env.KNU_EMAIL_AUTH_CONFIRMATION_REVIEWED!=='true')throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
  try {
    const url=new URL(process.env.SUPABASE_URL||''),origin=new URL(process.env.XELAY_PUBLIC_URL||'')
    if([url,origin].some(value=>value.protocol!=='https:'||value.username||value.password||value.pathname!=='/'||value.search||value.hash||value.port&&value.port!=='443'))throw Error()
    const serviceKey=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_ROLE||''
    const callerKey=process.env.SUPABASE_ANON_KEY||process.env.VITE_SUPABASE_ANON_KEY||''
    const secret=process.env.KNU_EMAIL_CODE_SECRET||'',resendKey=process.env.RESEND_API_KEY||'',from=process.env.XELAY_EMAIL_FROM||''
    if(!serviceKey||/\s/.test(serviceKey)||!callerKey||/\s/.test(callerKey)
      ||Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>512||/[\r\n\0]/.test(secret)
      ||!resendKey||/\s/.test(resendKey)||!/^Xelay <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(from))throw Error()
    return{url:url.origin,origin:origin.origin,serviceKey,callerKey,secret,resendKey,from}
  }catch{throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')}
}
function client(config:Settings,token?:string):SupabaseClient {
  return createClient(config.url,token?config.callerKey:config.serviceKey,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    global:{...(token?{headers:{Authorization:`Bearer ${token}`}}:{}),fetch:(input,init)=>fetch(input,{...init,
      signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)})},
  })
}
async function actor(req:any,service:SupabaseClient) {
  const header=req.headers?.authorization
  const token=typeof header==='string'&&header.length<=8192?/^Bearer ([^\s]+)$/.exec(header)?.[1]:undefined
  if(!token)throw new KnuEmailError('AUTH_REQUIRED')
  const authenticated=await service.auth.getUser(token)
  if(authenticated.error||!UUID.test(authenticated.data.user?.id||''))throw new KnuEmailError('AUTH_REQUIRED')
  const canonical=await service.auth.admin.getUserById(authenticated.data.user!.id)
  const user=canonical.data.user as(typeof canonical.data.user&{deleted_at?:string|null;banned_until?:string|null})
  if(canonical.error||!user||user.id!==authenticated.data.user!.id||user.deleted_at
    ||user.banned_until&&(!Number.isFinite(Date.parse(user.banned_until))||Date.parse(user.banned_until)>Date.now()))throw new KnuEmailError('AUTH_REQUIRED')
  if(!user.email_confirmed_at)throw new KnuEmailError('EMAIL_CONFIRMATION_REQUIRED')
  return{id:user.id,token}
}
function command(req:any):Command {
  if(typeof req.headers?.['content-type']!=='string'||req.headers['content-type'].split(';',1)[0].trim().toLowerCase()!=='application/json')throw new KnuEmailError('KNU_EMAIL_INVALID')
  const length=req.headers?.['content-length']
  if(length!==undefined&&(typeof length!=='string'||!/^\d+$/.test(length)||Number(length)>2048))throw new KnuEmailError('KNU_EMAIL_INVALID')
  let value:unknown=req.body
  try{if(typeof value==='string'||Buffer.isBuffer(value)){if(Buffer.byteLength(value)>2048)throw Error();value=JSON.parse(value.toString())}
    if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>2048)throw Error()
  }catch{throw new KnuEmailError('KNU_EMAIL_INVALID')}
  const row=value as Record<string,unknown>
  if(row.action==='request'&&Object.keys(row).every(key=>['action','email'].includes(key))){
    const email=normalizeKnuEmail(row.email);if(email)return{action:'request',email}
  }
  if(row.action==='verify'&&Object.keys(row).every(key=>['action','challengeId','code'].includes(key))
    &&typeof row.challengeId==='string'&&UUID.test(row.challengeId)&&typeof row.code==='string'&&/^\d{6}$/.test(row.code)){
    return{action:'verify',challengeId:row.challengeId.toLowerCase(),code:row.code}
  }
  throw new KnuEmailError(row.action==='verify'?'KNU_EMAIL_CODE_INVALID':'KNU_EMAIL_INVALID')
}
function status(value:unknown):Status {
  const row=value as Status
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.authEmailVerified!=='boolean'
    ||!(row.verifiedEmail===null&&row.verifiedAt===null||typeof row.verifiedEmail==='string'&&normalizeKnuEmail(row.verifiedEmail)===row.verifiedEmail&&typeof row.verifiedAt==='string'&&Number.isFinite(Date.parse(row.verifiedAt))))throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
  const result:Status={verifiedEmail:row.verifiedEmail,verifiedAt:row.verifiedAt,authEmailVerified:row.authEmailVerified}
  if(row.challenge){const c=row.challenge;if(!UUID.test(c.id)||normalizeKnuEmail(c.email)!==c.email||![c.expiresAt,c.resendAt].every(date=>typeof date==='string'&&Number.isFinite(Date.parse(date))))throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
    result.challenge={id:c.id,email:c.email,expiresAt:c.expiresAt,resendAt:c.resendAt}}
  return result
}
async function rpc(service:SupabaseClient,name:string,args:Record<string,unknown>) {
  const result=await service.rpc(name,args)
  if(result.error)throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
  const row=result.data as Record<string,any>
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.ok!=='boolean')throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
  if(!row.ok){const code=typeof row.code==='string'&&Object.prototype.hasOwnProperty.call(ERRORS,row.code)?row.code:'KNU_EMAIL_UNAVAILABLE'
    const retry=Number.isSafeInteger(row.retryAfterSeconds)&&row.retryAfterSeconds>0&&row.retryAfterSeconds<=86400?row.retryAfterSeconds:undefined
    throw new KnuEmailError(code,retry)}
  return row
}
function digest(config:Settings,userId:string,email:string,id:string,code:string) {
  return createHmac('sha256',config.secret).update(['xelay-knu-v1',userId,email,id,code].join('\n')).digest('hex')
}
async function sendCode(config:Settings,email:string,id:string,code:string) {
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Authorization:`Bearer ${config.resendKey}`,'Content-Type':'application/json','Idempotency-Key':`xelay-knu-email/${id}`},
    body:JSON.stringify({from:config.from,to:[email],subject:'Код підтвердження пошти КНУ у Xelay',
      text:`Ваш код підтвердження: ${code}\nКод діє 10 хвилин. Не повідомляйте його іншим. Якщо ви не надсилали запит, просто проігноруйте цей лист.`,
      html:`<p>Ваш код підтвердження пошти КНУ:</p><p><strong>${code}</strong></p><p>Код діє 10 хвилин. Не повідомляйте його іншим. Якщо ви не надсилали запит, просто проігноруйте цей лист.</p>`}),
  })
  // Never log provider bodies, email addresses, bearer tokens or codes.
  let accepted=false
  try{const body=await response.json();accepted=response.ok&&typeof body?.id==='string'&&body.id.length>0&&body.id.length<=200}catch{}
  if(!accepted)throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
}

export async function handleKnuEmail(req:any,res:any) {
  res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Vary','Origin, Authorization');res.setHeader('X-Content-Type-Options','nosniff')
  if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Метод не підтримується.',code:'KNU_EMAIL_INVALID'})}
  try{
    const config=configuration()
    if(req.headers?.origin!==undefined&&req.headers.origin!==config.origin
      ||req.method==='POST'&&req.headers?.origin!==config.origin
      ||typeof req.headers?.['sec-fetch-site']==='string'&&req.headers['sec-fetch-site']!=='same-origin')throw new KnuEmailError('AUTH_REQUIRED')
    const action=req.method==='POST'?command(req):null
    const service=client(config),user=await actor(req,service)
    if(!action){const result=await client(config,user.token).rpc('xelay_knu_email_status');if(result.error)throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE');return res.status(200).json(status(result.data))}
    if(action.action==='request'){
      const id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0')
      const prepared=await rpc(service,'xelay_knu_email_prepare',{p_user:user.id,p_id:id,p_email:action.email,p_digest:digest(config,user.id,action.email,id,code)})
      if(prepared.alreadyVerified===true)return res.status(200).json(status(prepared.status))
      if(prepared.id!==id)throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
      try{await sendCode(config,action.email,id,code)}catch{
        try{await rpc(service,'xelay_knu_email_delivery',{p_user:user.id,p_id:id,p_delivered:false})}catch{}
        throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
      }
      const delivered=await rpc(service,'xelay_knu_email_delivery',{p_user:user.id,p_id:id,p_delivered:true})
      return res.status(200).json(status(delivered.status))
    }
    const context=await rpc(service,'xelay_knu_email_challenge',{p_user:user.id,p_id:action.challengeId})
    const email=normalizeKnuEmail(context.email);if(!email)throw new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
    const verified=await rpc(service,'xelay_knu_email_verify',{p_user:user.id,p_id:action.challengeId,p_digest:digest(config,user.id,email,action.challengeId,action.code)})
    return res.status(200).json(status(verified.status))
  }catch(error){
    const known=error instanceof KnuEmailError?error:new KnuEmailError('KNU_EMAIL_UNAVAILABLE')
    const description=ERRORS[known.code]||ERRORS.KNU_EMAIL_UNAVAILABLE
    if(known.retryAfterSeconds)res.setHeader('Retry-After',String(known.retryAfterSeconds))
    return res.status(description.status).json({error:description.message,code:known.code,...(known.retryAfterSeconds?{retryAfterSeconds:known.retryAfterSeconds}:{})})
  }
}
