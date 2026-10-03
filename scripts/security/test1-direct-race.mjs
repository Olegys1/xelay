// Prepared isolated integration probe. Default is no network. Only test1's
// existing owned synthetic session/fixture files are accepted; no service key.
// --execute --session-file <owned> --fixture-file <owned>
// Recovery: also --cleanup-only --receipt-file <this probe's durable receipt>.
import { createHash,randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STAGING_REF,STAGING_ORIGIN,parseHostedConfiguration } from './hosted-media-checks.mjs'
import { mediaEnvironmentFromSession } from './run-hosted-media-session.mjs'
import { TEST1_LOCAL_DIRECTORY,readTest1LocalMode,durableTest1Json } from './test1-auth-fixtures.mjs'

const root=fileURLToPath(new URL('../../',import.meta.url))
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODES=new Set(['RACE_CONFIGURATION_INVALID','RACE_REQUEST_DENIED','RACE_REQUEST_LIMIT','RACE_NETWORK_FAILED',
  'RACE_REDIRECT_DENIED','RACE_RESPONSE_INVALID','RACE_CHECK_FAILED','RACE_LOCAL_IO_FAILED','RACE_CLEANUP_SCOPE_DENIED'])
const DB_CODES=new Set(['23505','42501','22023','P0001','PGRST116','54000'])
export class DirectRaceError extends Error {
  constructor(code='RACE_CONFIGURATION_INVALID'){const safe=CODES.has(code)?code:'RACE_CHECK_FAILED';super(safe);this.code=safe}
}
const reject=(value,code='RACE_CONFIGURATION_INVALID')=>{if(value)throw new DirectRaceError(code)}
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
const hash=body=>createHash('sha256').update(body).digest('hex')
export const directRaceBodies=probeId=>{
  reject(!UUID.test(probeId||''))
  return [`Synthetic duplicate send first ${probeId}`,`Synthetic duplicate send second ${probeId}`]
}
const forgedBody=probeId=>`Synthetic forged sender ${probeId}`
export function parseDirectRaceArguments(args=[]) {
  const options={execute:false,cleanupOnly:false,sessionPath:null,fixturePath:null,receiptPath:null}
  for(let index=0;index<args.length;index++) {
    const argument=args[index]
    if(argument==='--execute'){reject(options.execute);options.execute=true}
    else if(argument==='--cleanup-only'){reject(options.cleanupOnly);options.cleanupOnly=true}
    else if(['--session-file','--fixture-file','--receipt-file'].includes(argument)) {
      const field=argument==='--session-file'?'sessionPath':argument==='--fixture-file'?'fixturePath':'receiptPath'
      reject(options[field]||!args[index+1]);options[field]=args[++index]
    } else throw new DirectRaceError()
  }
  reject(options.execute&&(!options.sessionPath||!options.fixturePath)||options.cleanupOnly&&!options.execute
    ||options.cleanupOnly!==Boolean(options.receiptPath))
  return options
}
export function validateDirectRaceReceipt(receipt,config) {
  reject(!fields(receipt,['mode','projectRef','origin','fixtureRunId','probeId','messageId','ownerId','recipientId','outsiderId',
    'conversationId','createdAt','stage','winnerDigest'])||receipt.mode!=='test1-direct-race-owned'
    ||receipt.projectRef!==STAGING_REF||receipt.origin!==STAGING_ORIGIN
    ||['fixtureRunId','probeId','messageId','ownerId','recipientId','outsiderId','conversationId'].some(field=>!UUID.test(receipt[field]||''))
    ||new Set([receipt.ownerId,receipt.recipientId,receipt.outsiderId]).size!==3||!Number.isFinite(Date.parse(receipt.createdAt))
    ||!['prepared','race_pending','race_finished','winner_verified','delete_pending','deleted','cleanup_pending'].includes(receipt.stage)
    ||(receipt.winnerDigest!==null&&!directRaceBodies(receipt.probeId).map(hash).includes(receipt.winnerDigest)),
    'RACE_CLEANUP_SCOPE_DENIED')
  if(config)reject(receipt.fixtureRunId!==config.fixtureRunId||receipt.ownerId!==config.users.A.id
    ||receipt.recipientId!==config.users.B.id||receipt.outsiderId!==config.users.C.id||receipt.conversationId!==config.conversationId,
    'RACE_CLEANUP_SCOPE_DENIED')
  return receipt
}
function exactQuery(url,expected) {
  return [...url.searchParams.keys()].length===Object.keys(expected).length
    &&Object.entries(expected).every(([key,value])=>url.searchParams.get(key)===value)
}
const messageSelect='id,conversation_id,sender_id,recipient_id,body,deleted_at'
export function assertDirectRaceRequest(input,{method='GET',body,who,paired=false}={},receipt) {
  validateDirectRaceReceipt(receipt)
  let url
  try{url=new URL(String(input))}catch{throw new DirectRaceError('RACE_REQUEST_DENIED')}
  reject(url.origin!==STAGING_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.hash||!['A','B','C'].includes(who),
    'RACE_REQUEST_DENIED')
  let allowed=false
  if(url.pathname==='/auth/v1/user')allowed=method==='GET'&&url.search===''
  else if(url.pathname==='/rest/v1/conversations')allowed=method==='GET'&&exactQuery(url,
    {select:'id,user_one_id,user_two_id',id:`eq.${receipt.conversationId}`})
  else if(url.pathname==='/rest/v1/messages'&&method==='GET') {
    const query={select:messageSelect,id:`eq.${receipt.messageId}`,conversation_id:`eq.${receipt.conversationId}`}
    allowed=exactQuery(url,query)||exactQuery(url,{...query,deleted_at:'is.null'})
  } else if(url.pathname==='/rest/v1/messages'&&method==='POST') {
    allowed=who==='B'&&!paired&&url.search===''&&fields(body,['id','conversation_id','sender_id','recipient_id','body'])
      &&body.id===receipt.messageId&&body.conversation_id===receipt.conversationId&&body.sender_id===receipt.ownerId
      &&body.recipient_id===receipt.recipientId&&body.body===forgedBody(receipt.probeId)
  } else if(url.pathname==='/rest/v1/rpc/xelay_send_direct_message') {
    allowed=method==='POST'&&who==='A'&&paired&&url.search===''&&fields(body,['p_message_id','p_conversation_id','p_body','p_reply_to','p_attachments'])
      &&body.p_message_id===receipt.messageId&&body.p_conversation_id===receipt.conversationId
      &&directRaceBodies(receipt.probeId).includes(body.p_body)&&body.p_reply_to===null
      &&Array.isArray(body.p_attachments)&&body.p_attachments.length===0
  } else if(url.pathname==='/rest/v1/rpc/xelay_delete_message') {
    allowed=method==='POST'&&who==='A'&&!paired&&url.search===''&&fields(body,['p_message_id'])&&body.p_message_id===receipt.messageId
  }
  reject(!allowed||method==='GET'&&body!=null,'RACE_REQUEST_DENIED')
}
export function directRaceTransport(config,receipt,fetchImpl=globalThis.fetch) {
  validateDirectRaceReceipt(receipt,config)
  let requests=0,active=0,pairUsed=false,pairActive=false
  const started=Date.now(),headers=who=>({apikey:config.key,Authorization:`Bearer ${config.users[who].token}`,'Content-Type':'application/json'})
  const request=async(who,path,method='GET',body,paired=false)=>{
    const url=STAGING_ORIGIN+path
    assertDirectRaceRequest(url,{method,body,who,paired},receipt)
    reject(active>=(paired?2:1)||pairActive!==paired||requests>=16||Date.now()-started>=60000,'RACE_REQUEST_LIMIT')
    const serialized=body==null?undefined:JSON.stringify(body)
    reject(serialized&&Buffer.byteLength(serialized)>2048,'RACE_REQUEST_LIMIT')
    requests++;active++
    try {
      const response=await fetchImpl(url,{method,headers:headers(who),body:serialized,redirect:'manual',cache:'no-store',
        signal:AbortSignal.timeout(Math.min(8000,60000-(Date.now()-started)))})
      reject(response.status>=300&&response.status<400,'RACE_REDIRECT_DENIED')
      reject(response.url&&new URL(response.url).origin!==STAGING_ORIGIN,'RACE_REDIRECT_DENIED')
      const reader=response.body?.getReader(),chunks=[]
      let bytes=0
      if(reader)for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength
        if(bytes>16384){await reader.cancel();throw new DirectRaceError('RACE_RESPONSE_INVALID')}chunks.push(item.value)}
      let data=null
      try{if(bytes)data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new DirectRaceError('RACE_RESPONSE_INVALID')}
      return {ok:response.ok,httpStatus:response.status,errorCode:response.ok?'None':DB_CODES.has(data?.code)?data.code:'OtherError',data}
    } catch(error) {
      if(error instanceof DirectRaceError)throw error
      throw new DirectRaceError('RACE_NETWORK_FAILED')
    } finally {active--}
  }
  return {
    // Normal callers cannot select the concurrent mode or call the send route.
    request:(who,path,method,body)=>request(who,path,method,body,false),
    racePair:async()=>{
      reject(pairUsed||active!==0,'RACE_REQUEST_LIMIT');pairUsed=true;pairActive=true
      try {
        return await Promise.allSettled(directRaceBodies(receipt.probeId).map(body=>request('A','/rest/v1/rpc/xelay_send_direct_message','POST',
          {p_message_id:receipt.messageId,p_conversation_id:receipt.conversationId,p_body:body,p_reply_to:null,p_attachments:[]},true)))
      } finally {pairActive=false}
    },metrics:()=>({requests}),
  }
}
export function isDuplicateRaceResult(result) {return !result?.ok&&[400,409].includes(result?.httpStatus)&&result?.errorCode==='23505'}
const messagePath=(receipt,live=false)=>'/rest/v1/messages?'+new URLSearchParams({select:messageSelect,id:`eq.${receipt.messageId}`,
  conversation_id:`eq.${receipt.conversationId}`,...(live?{deleted_at:'is.null'}:{})})
const ownedMessage=(message,receipt)=>message?.id===receipt.messageId&&message.conversation_id===receipt.conversationId
  &&message.sender_id===receipt.ownerId&&message.recipient_id===receipt.recipientId
const validWinner=(message,receipt)=>ownedMessage(message,receipt)&&message.deleted_at===null&&directRaceBodies(receipt.probeId).includes(message.body)
const diagnostic=(name,result,passed)=>({checkName:name,passed:Boolean(passed),httpStatus:Number.isInteger(result?.httpStatus)?result.httpStatus:0,
  errorCode:DB_CODES.has(result?.errorCode)||result?.errorCode==='None'?result.errorCode:CODES.has(result?.code)?result.code:'OtherError'})

export async function runTest1DirectRace(options,{fetchImpl=globalThis.fetch,session,fixture,receipt:providedReceipt,
  load=readTest1LocalMode,save=durableTest1Json}={}) {
  const summary={checksPassed:0,checksFailed:0,cleanupPassed:0,cleanupFailed:0,requests:0,pending:1,diagnostics:[]}
  if(!options.execute)return summary
  session=session||await load(options.sessionPath);fixture=fixture||await load(options.fixturePath)
  const config={...parseHostedConfiguration(mediaEnvironmentFromSession(session,fixture),['--execute']),fixtureRunId:session.runId}
  let receipt
  if(options.cleanupOnly)receipt=validateDirectRaceReceipt(providedReceipt||await load(options.receiptPath),config)
  else receipt={mode:'test1-direct-race-owned',projectRef:STAGING_REF,origin:STAGING_ORIGIN,fixtureRunId:session.runId,
    probeId:randomUUID(),messageId:randomUUID(),ownerId:config.users.A.id,recipientId:config.users.B.id,outsiderId:config.users.C.id,
    conversationId:config.conversationId,createdAt:new Date().toISOString(),stage:'prepared',winnerDigest:null}
  const receiptPath=resolve(TEST1_LOCAL_DIRECTORY,`test1-direct-race-receipt-${receipt.probeId}.json`)
  reject(options.cleanupOnly&&resolve(root,options.receiptPath)!==receiptPath,'RACE_CLEANUP_SCOPE_DENIED')
  const persist=async(stage)=>{receipt.stage=stage;validateDirectRaceReceipt(receipt,config);await save(receiptPath,receipt)}
  const transport=directRaceTransport(config,receipt,fetchImpl)
  summary.probeId=receipt.probeId
  let identitiesVerified=false,lastName='prepare'
  const checked=(name,result,condition)=>{lastName=name;summary.diagnostics.push(diagnostic(name,result,condition))
    if(!condition){summary.checksFailed++;throw new DirectRaceError('RACE_CHECK_FAILED')}summary.checksPassed++}
  try {
    if(!options.cleanupOnly)await save(receiptPath,receipt,{initial:true})
    for(const who of ['A','B','C']) {
      const user=await transport.request(who,'/auth/v1/user')
      checked(`auth_${who}`,user,user.ok&&user.data?.id===config.users[who].id&&Boolean(user.data?.email_confirmed_at)
        &&user.data?.app_metadata?.xelay_security_fixture==='media-v1'&&user.data.app_metadata.xelay_security_run_id===session.runId
        &&user.data.app_metadata.xelay_security_label===who)
      const conversation=await transport.request(who,'/rest/v1/conversations?'+new URLSearchParams({select:'id,user_one_id,user_two_id',id:`eq.${receipt.conversationId}`}))
      checked(`conversation_${who}`,conversation,conversation.ok&&Array.isArray(conversation.data)&&(who==='C'?conversation.data.length===0:
        conversation.data.length===1&&[receipt.ownerId,receipt.recipientId].every(id=>
          [conversation.data[0].user_one_id,conversation.data[0].user_two_id].includes(id))))
    }
    identitiesVerified=true
    if(!options.cleanupOnly) {
      await persist('race_pending') // Durable exact message intent before either POST.
      lastName='duplicate_send_pair'
      const results=await transport.racePair(),success=results.filter(item=>item.status==='fulfilled'&&item.value.ok),
        conflicts=results.filter(item=>item.status==='fulfilled'&&isDuplicateRaceResult(item.value))
      for(let index=0;index<2;index++)summary.diagnostics.push(diagnostic(`duplicate_send_result_${index+1}`,
        results[index].status==='fulfilled'?results[index].value:results[index].reason,results[index].status==='fulfilled'
          &&(results[index].value.ok||isDuplicateRaceResult(results[index].value))))
      checked('duplicate_send_one_winner',null,success.length===1&&conflicts.length===1
        &&validWinner(success[0]?.value.data,receipt))
      await persist('race_finished')
      const lookup=await transport.request('A',messagePath(receipt))
      checked('one_persisted_original',lookup,lookup.ok&&Array.isArray(lookup.data)&&lookup.data.length===1
        &&validWinner(lookup.data[0],receipt)&&lookup.data[0].body===success[0].value.data.body)
      receipt.winnerDigest=hash(lookup.data[0].body);await persist('winner_verified')
      const forged=await transport.request('B','/rest/v1/messages','POST',{id:receipt.messageId,conversation_id:receipt.conversationId,
        sender_id:receipt.ownerId,recipient_id:receipt.recipientId,body:forgedBody(receipt.probeId)})
      checked('foreign_sender_denied',forged,!forged.ok&&[401,403].includes(forged.httpStatus)&&forged.errorCode==='42501')
      const recipient=await transport.request('B',messagePath(receipt))
      checked('recipient_original_unchanged',recipient,recipient.ok&&Array.isArray(recipient.data)&&recipient.data.length===1
        &&validWinner(recipient.data[0],receipt)&&hash(recipient.data[0].body)===receipt.winnerDigest)
      const outsider=await transport.request('C',messagePath(receipt))
      checked('nonmember_invisible',outsider,outsider.ok&&Array.isArray(outsider.data)&&outsider.data.length===0)
    }
  } catch(error) {
    if(!(error instanceof DirectRaceError&&error.code==='RACE_CHECK_FAILED')){summary.checksFailed++;summary.diagnostics.push(diagnostic(lastName,error,false))}
  } finally {
    if(identitiesVerified) {
      try {
        // Fresh exact lookup before delete: an unknown race response cannot
        // authorize deleting a row whose original synthetic body is unproven.
        const lookup=await transport.request('A',messagePath(receipt))
        reject(!lookup.ok||!Array.isArray(lookup.data)||lookup.data.length>1,'RACE_CLEANUP_SCOPE_DENIED')
        if(lookup.data.length===1) {
          const message=lookup.data[0]
          if(validWinner(message,receipt)) {
            receipt.winnerDigest=hash(message.body);await persist('delete_pending')
            const deleted=await transport.request('A','/rest/v1/rpc/xelay_delete_message','POST',{p_message_id:receipt.messageId})
            summary.diagnostics.push(diagnostic('cleanup_owned_delete',deleted,deleted.ok))
            reject(!deleted.ok,'RACE_CLEANUP_SCOPE_DENIED');summary.cleanupPassed++
          } else reject(!(ownedMessage(message,receipt)&&message.body===''&&message.deleted_at!==null&&receipt.winnerDigest),'RACE_CLEANUP_SCOPE_DENIED')
          const live=await transport.request('A',messagePath(receipt,true))
          const absent=live.ok&&Array.isArray(live.data)&&live.data.length===0
          summary.diagnostics.push(diagnostic('cleanup_live_absence',live,absent));reject(!absent,'RACE_CLEANUP_SCOPE_DENIED');summary.cleanupPassed++
          const tombstone=await transport.request('A',messagePath(receipt))
          const cleared=tombstone.ok&&Array.isArray(tombstone.data)&&tombstone.data.length===1&&ownedMessage(tombstone.data[0],receipt)
            &&tombstone.data[0].body===''&&typeof tombstone.data[0].deleted_at==='string'&&Number.isFinite(Date.parse(tombstone.data[0].deleted_at))
          summary.diagnostics.push(diagnostic('cleanup_exact_tombstone',tombstone,cleared));reject(!cleared,'RACE_CLEANUP_SCOPE_DENIED');summary.cleanupPassed++
        } else summary.cleanupPassed++
        await persist('deleted')
      } catch(error) {
        summary.cleanupFailed++;summary.diagnostics.push(diagnostic('cleanup_failed',error,false))
        await persist('cleanup_pending').catch(()=>{})
      }
    }
  }
  summary.requests=transport.metrics().requests
  summary.pending=summary.checksFailed||summary.cleanupFailed||!identitiesVerified?1:0
  return summary
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try{summary=await runTest1DirectRace(parseDirectRaceArguments(process.argv.slice(2)))}
  catch(error){summary={checksPassed:0,checksFailed:1,cleanupPassed:0,cleanupFailed:0,requests:0,pending:1,diagnostics:[diagnostic('configuration',error,false)]}}
  console.log(JSON.stringify(summary))
  if(summary.checksFailed||summary.cleanupFailed)process.exitCode=1
}
