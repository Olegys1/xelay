// No service key is read here or passed to the media runner. Requires separate
// ignored synthetic session and application-fixture files; default no network.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { STAGING_REF,STAGING_ORIGIN,parseHostedConfiguration,runHostedMediaChecks,validateMediaReceipt } from './hosted-media-checks.mjs'
import { readTest1LocalMode,fixtureClaims,FixtureSetupError,validateTest1Key } from './test1-auth-fixtures.mjs'
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
const reject=(condition)=>{if(condition)throw new FixtureSetupError()}
export function parseSessionArguments(args=[]) {
  const options={execute:false,cleanup:false,cleanupOnly:false,receiptPath:null,sessionPath:null,fixturePath:null}
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute'){reject(options.execute);options.execute=true}
    else if(args[i]==='--cleanup'){reject(options.cleanup);options.cleanup=true}
    else if(args[i]==='--cleanup-only'){reject(options.cleanupOnly||options.cleanup);options.cleanupOnly=true;options.cleanup=true}
    else if(args[i]==='--media-receipt-file'){reject(options.receiptPath||!args[i+1]);options.receiptPath=args[++i]}
    else if(args[i]==='--session-file'){reject(options.sessionPath||!args[i+1]);options.sessionPath=args[++i]}
    else if(args[i]==='--fixture-file'){reject(options.fixturePath||!args[i+1]);options.fixturePath=args[++i]}
    else throw new FixtureSetupError()
  }
  reject(options.execute&&(!options.sessionPath||!options.fixturePath)||options.cleanup&&!options.execute
    ||options.cleanupOnly!==Boolean(options.receiptPath))
  return options
}
export function mediaEnvironmentFromSession(session,fixture) {
  reject(!fields(session,['mode','projectRef','origin','runId','publicKey','users'])||session.mode!=='test1-media-sessions'
    ||session.projectRef!==STAGING_REF||session.origin!==STAGING_ORIGIN||!UUID.test(session.runId||'')
    ||!fields(session.users,['A','B','C'])||Object.keys(session.users).length!==3)
  reject(!fields(fixture,['mode','projectRef','origin','runId','conversationId','chatSpaceId'])||fixture.mode!=='test1-media-fixtures'
    ||fixture.projectRef!==STAGING_REF||fixture.origin!==STAGING_ORIGIN||fixture.runId!==session.runId
    ||!UUID.test(fixture.conversationId||'')||!UUID.test(fixture.chatSpaceId||''))
  const env={XELAY_HOSTED_MEDIA_ANON_KEY:validateTest1Key(session.publicKey,'anon'),
    XELAY_HOSTED_MEDIA_CONVERSATION_ID:fixture.conversationId,XELAY_HOSTED_MEDIA_CHAT_SPACE_ID:fixture.chatSpaceId}
  const ids=new Set()
  for(const who of ['A','B','C']) {
    const user=session.users[who]
    reject(!fields(user,['id','accessToken','expiresAt'])||!UUID.test(user.id||'')||ids.has(user.id))
    const claims=fixtureClaims(user.accessToken)
    reject(claims.sub!==user.id||claims.role!=='authenticated'||claims.iss!==STAGING_ORIGIN+'/auth/v1'
      ||claims.exp!==user.expiresAt||!Number.isFinite(claims.exp)||claims.exp*1000<Date.now()+180000)
    ids.add(user.id);env[`XELAY_HOSTED_MEDIA_USER_${who}_TOKEN`]=user.accessToken
  }
  return env
}
export async function runHostedMediaSession(options,dependencies={}) {
  if(!options.execute)return runHostedMediaChecks({execute:false},dependencies)
  const session=await readTest1LocalMode(options.sessionPath),fixture=await readTest1LocalMode(options.fixturePath)
  const config={...parseHostedConfiguration(mediaEnvironmentFromSession(session,fixture),
    ['--execute',...(options.cleanup?['--cleanup']:[])]),fixtureRunId:session.runId,cleanupOnly:options.cleanupOnly}
  if(options.cleanupOnly) {
    config.cleanupReceipt=await readTest1LocalMode(options.receiptPath)
    validateMediaReceipt(config.cleanupReceipt)
    reject(config.cleanupReceipt.fixtureRunId!==session.runId||config.cleanupReceipt.ownerId!==session.users.A.id
      ||config.cleanupReceipt.conversationId!==fixture.conversationId||config.cleanupReceipt.spaceId!==fixture.chatSpaceId)
  }
  return runHostedMediaChecks(config,dependencies)
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let summary
  try{summary=await runHostedMediaSession(parseSessionArguments(process.argv.slice(2)))}
  catch{summary={checksPassed:0,checksFailed:1,requests:0,fileBytes:0,cleanupPassed:0,cleanupFailed:0,pending:1,buckets:5}}
  console.log(JSON.stringify(summary))
  if(summary.checksFailed||summary.cleanupFailed)process.exitCode=1
}
