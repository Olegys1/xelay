// Real capture/composition helpers and component callbacks with synthetic media.
// No real camera, upload, account, Supabase, network or provider request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { File } from 'node:buffer'
import vm from 'node:vm'
import ts from 'typescript'

const source=path=>readFile(new URL('../../'+path,import.meta.url),'utf8')
const helperSource=await source('src/lib/dualPhoto.ts')
const componentSource=await source('src/components/DualPhotoCapture.tsx')
const compile=text=>ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
function execute(text,dependencies={},globals={}) {
  const module={exports:{}}
  vm.runInNewContext(compile(text),{exports:module.exports,module,require:name=>{
    assert.ok(Object.hasOwn(dependencies,name),'Unexpected capture dependency: '+name);return dependencies[name]
  },DOMException,AbortController,Blob,File,Date,Promise,setTimeout,clearTimeout,setInterval,clearInterval,...globals})
  return module.exports
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}
const namedError=name=>Object.assign(new Error(name),{name})
function track(facing='environment',deviceId=facing,label=facing) {
  return Object.assign(new EventTarget(),{readyState:'live',label,stops:0,
    getSettings:()=>({facingMode:facing,deviceId}),stop(){this.stops++;this.readyState='ended'}})
}
function stream(videoTrack=track(),audioTracks=[]) {
  return {videoTrack,getVideoTracks:()=>[videoTrack],getAudioTracks:()=>audioTracks,getTracks:()=>[videoTrack,...audioTracks]}
}
function canvasFixture({sizes=[1200],mime='image/jpeg'}={}) {
  const canvases=[]
  const document={createElement(type){assert.equal(type,'canvas');const calls=[]
    const context=Object.fromEntries(['save','restore','translate','scale','drawImage','beginPath','moveTo','arcTo','closePath','clip','stroke','fillRect']
      .map(name=>[name,(...args)=>calls.push([name,...args])]))
    const canvas={width:0,height:0,calls,context,getContext:()=>context,toBlob(callback,type,quality){
      calls.push(['toBlob',type,quality]);const size=sizes.length>1?sizes.shift():sizes[0]
      queueMicrotask(()=>callback(new Blob([new Uint8Array(size)],{type:mime})))
    }}
    canvases.push(canvas);return canvas
  }}
  return {document,canvases}
}
const helper=execute(helperSource)

test('camera requests are video-only, exact-facing first and require two verified opposite cameras',async()=>{
  const calls=[],rear=stream(track('environment','rear')),front=stream(track('user','front'))
  const media={getSupportedConstraints:()=>({facingMode:true}),getUserMedia:async constraints=>{
    calls.push(constraints);return calls.length===1?rear:front
  }}
  const first=await helper.openDualPhotoCamera('environment',undefined,undefined,media)
  const second=await helper.openDualPhotoCamera('user',first.identity,undefined,media)
  assert.equal(first.identity.deviceId,'rear');assert.equal(second.identity.deviceId,'front')
  assert.deepEqual(calls.map(call=>call.audio),[false,false])
  assert.deepEqual(calls.map(call=>call.video.facingMode.exact),['environment','user'])
  helper.stopDualPhotoStream(first.stream);helper.stopDualPhotoStream(second.stream)
  assert.equal(rear.videoTrack.stops,1);assert.equal(front.videoTrack.stops,1)
})

test('an unsupported exact constraint may use a verified ideal fallback but never the same or wrong camera',async()=>{
  for(const facing of ['environment','user']) {
    const calls=[],candidate=stream(track(facing,'verified-'+facing))
    const media={getUserMedia:async constraints=>{calls.push(constraints);if(calls.length===1)throw namedError('OverconstrainedError');return candidate}}
    const result=await helper.openDualPhotoCamera(facing,undefined,undefined,media)
    assert.equal(calls[1].video.facingMode.ideal,facing)
    helper.stopDualPhotoStream(result.stream)
  }
  for(const candidate of [stream(track('environment','rear')),stream(track('user','rear'))]) {
    const media={getSupportedConstraints:()=>({facingMode:true}),getUserMedia:async()=>candidate}
    await assert.rejects(helper.openDualPhotoCamera('user',{facing:'environment',deviceId:'rear',reportedFacing:true},undefined,media),/DUAL_PHOTO_/)
    assert.equal(candidate.videoTrack.stops,1)
  }
  const unlabelled=stream(track(null,'unlabelled','Camera 1'));let attempts=0
  await assert.rejects(helper.openDualPhotoCamera('user',undefined,undefined,{getUserMedia:async()=>{
    if(++attempts===1)throw namedError('OverconstrainedError');return unlabelled
  }}),/CAMERA_UNVERIFIED/)
  assert.equal(unlabelled.videoTrack.stops,1)
  assert.throws(()=>helper.dualPhotoCameraIdentity(track(null,'','Unlabelled camera'),'user',
    {facing:'environment',deviceId:'',reportedFacing:false},true),/CAMERA_UNVERIFIED/)
})

test('permission denial is not retried; late camera results after abort and unexpected microphone tracks are released',async()=>{
  let attempts=0
  await assert.rejects(helper.openDualPhotoCamera('environment',undefined,undefined,{getUserMedia:async()=>{attempts++;throw namedError('NotAllowedError')}}),/NotAllowedError/)
  assert.equal(attempts,1)
  const waiting=deferred(),controller=new AbortController(),late=stream()
  const opening=helper.openDualPhotoCamera('environment',undefined,controller.signal,{getUserMedia:()=>waiting.promise})
  controller.abort();waiting.resolve(late)
  await assert.rejects(opening,error=>error.name==='AbortError')
  assert.equal(late.videoTrack.stops,1)
  const audio=track(undefined,'audio','Microphone'),candidate=stream(track('environment','rear'),[audio])
  const result=await helper.openDualPhotoCamera('environment',undefined,undefined,{getUserMedia:async()=>candidate})
  assert.equal(audio.stops,1)
  helper.stopDualPhotoStream(result.stream)
})

test('unsupported/no-camera failures give usable local explanations without exposing raw device details',async()=>{
  await assert.rejects(helper.openDualPhotoCamera('environment',undefined,undefined,{}),/UNSUPPORTED/)
  assert.match(helper.dualPhotoError(new Error('DUAL_PHOTO_UNSUPPORTED')),/HTTPS/)
  assert.match(helper.dualPhotoError(namedError('NotAllowedError')),/Дозвольте доступ/)
  assert.match(helper.dualPhotoError(namedError('NotFoundError')),/дві різні камери/)
  assert.match(helper.dualPhotoError(namedError('NotReadableError')),/Закрийте інші/)
  assert.doesNotMatch(helper.dualPhotoError(new Error('private-device-secret')),/private-device-secret/)
})

function videoFixture({frameCallback=true,playError=null}={}) {
  const video=Object.assign(new EventTarget(),{srcObject:null,readyState:0,videoWidth:0,videoHeight:0,
    play:async()=>{if(playError)throw playError},pause(){},muted:false,playsInline:false,autoplay:false})
  let nextFrame=null,cancelled=0
  if(frameCallback){video.requestVideoFrameCallback=callback=>{nextFrame=callback;return 1};video.cancelVideoFrameCallback=()=>{cancelled++;nextFrame=null}}
  return {video,get cancelled(){return cancelled},ready(){video.readyState=2;video.videoWidth=720;video.videoHeight=1280;video.dispatchEvent(new Event('loadeddata'))},frame(){const callback=nextFrame;nextFrame=null;callback?.(0,{})}}
}

test('video readiness waits for actual dimensions, playback and a fresh rendered video frame',async()=>{
  const fx=videoFixture(),media=stream();let done=false
  const waiting=helper.waitForDualPhotoVideo(fx.video,media).then(()=>{done=true})
  await flush();assert.equal(done,false)
  assert.equal(fx.video.srcObject,media);assert.equal(fx.video.muted,true);assert.equal(fx.video.playsInline,true)
  fx.ready();await flush();assert.equal(done,false)
  fx.frame();await waiting;assert.equal(done,true)
})

test('video readiness fails on missing frames, rejected playback, stopped camera or abort with timers/listeners cleaned',async()=>{
  const timeout=videoFixture({frameCallback:false})
  await assert.rejects(helper.waitForDualPhotoVideo(timeout.video,stream(),undefined,1),/VIDEO_TIMEOUT/)
  const blocked=videoFixture({playError:namedError('NotAllowedError')})
  await assert.rejects(helper.waitForDualPhotoVideo(blocked.video,stream()),/PLAY_FAILED/)
  const aborted=videoFixture(),controller=new AbortController()
  const pending=helper.waitForDualPhotoVideo(aborted.video,stream(),controller.signal)
  await flush();aborted.ready();await flush();controller.abort()
  await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(aborted.cancelled,1)
  const ended=videoFixture(),endedStream=stream(),waiting=helper.waitForDualPhotoVideo(ended.video,endedStream)
  endedStream.videoTrack.dispatchEvent(new Event('ended'))
  await assert.rejects(waiting,/CAMERA_UNAVAILABLE/)
})

test('center crop preserves aspect ratio and captured frames are bounded without changing their facing identity',()=>{
  const crop=helper.dualPhotoCrop(1920,1080,1200,1600)
  assert.equal(crop.sh,1080);assert.equal(crop.sw,810);assert.equal(crop.sx,555);assert.equal(crop.sy,0)
  assert.throws(()=>helper.dualPhotoCrop(0,1080,1200,1600),/CANVAS_UNAVAILABLE/)
  const fx=canvasFixture(),actual=execute(helperSource,{}, {document:fx.document})
  const frame=actual.captureDualPhotoFrame({readyState:2,videoWidth:3840,videoHeight:2160},'user')
  assert.equal(frame.facing,'user');assert.equal(frame.canvas.width,1600);assert.equal(frame.canvas.height,900)
  assert.throws(()=>actual.captureDualPhotoFrame({readyState:0,videoWidth:0,videoHeight:0},'environment'),/VIDEO_TIMEOUT/)
})

test('collage export is a bounded 3:4 JPEG with a clipped 30% inset, border and intentionally mirrored selfie; swap preserves both images',async()=>{
  for(const selfieMain of [false,true]) {
    const fx=canvasFixture(),actual=execute(helperSource,{}, {document:fx.document})
    const rear={canvas:{width:1920,height:1080,id:'rear'},facing:'environment'},selfie={canvas:{width:720,height:1280,id:'selfie'},facing:'user'}
    const file=await actual.composeDualPhoto(rear,selfie,selfieMain)
    assert.equal(file.type,'image/jpeg');assert.match(file.name,/^xelay-dual-photo-\d+\.jpg$/)
    assert.ok(file.size>0&&file.size<=5*1024*1024)
    const canvas=fx.canvases[0],draws=canvas.calls.filter(call=>call[0]==='drawImage')
    assert.equal(canvas.width,1200);assert.equal(canvas.height,1600)
    assert.equal(draws.length,2)
    assert.equal(draws[0][1].id,selfieMain?'selfie':'rear');assert.equal(draws[1][1].id,selfieMain?'rear':'selfie')
    assert.equal(draws[1][8],360);assert.equal(draws[1][9],480)
    assert.equal(canvas.calls.filter(call=>call[0]==='scale').length,1)
    assert.deepEqual(canvas.calls.find(call=>call[0]==='scale'),['scale',-1,1])
    assert.ok(canvas.calls.some(call=>call[0]==='clip'));assert.ok(canvas.calls.some(call=>call[0]==='stroke'))
    assert.equal(canvas.context.strokeStyle,'#ffffff');assert.equal(canvas.context.lineWidth,8)
  }
})

test('oversized exports retry bounded JPEG qualities then fail, and an abort during encoding never returns a file',async()=>{
  const frame=facing=>({canvas:{width:1200,height:1600},facing})
  const big=canvasFixture({sizes:[5*1024*1024+1]}),actual=execute(helperSource,{}, {document:big.document})
  await assert.rejects(actual.composeDualPhoto(frame('environment'),frame('user')),/TOO_LARGE/)
  assert.equal(big.canvases[0].calls.filter(call=>call[0]==='toBlob').length,5)
  const controller=new AbortController(),fx=canvasFixture()
  const document={createElement(type){const canvas=fx.document.createElement(type),toBlob=canvas.toBlob
    canvas.toBlob=(callback,...args)=>toBlob.call(canvas,blob=>{controller.abort();callback(blob)},...args);return canvas}}
  await assert.rejects(execute(helperSource,{}, {document}).composeDualPhoto(frame('environment'),frame('user'),false,controller.signal),error=>error.name==='AbortError')
})

const textOf=tree=>!tree||typeof tree==='boolean'?'':typeof tree==='string'?tree:Array.isArray(tree)?tree.map(textOf).join(' '):textOf(tree.props?.children)
const nodes=tree=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)]
function componentFixture() {
  const slots=[],effects=[],listeners=new Map(),windowListeners=new Map(),cameras=[],captures=[],compositions=[],countdowns=[],queuedCameras=[],queuedComposition=[]
  let cursor=0,alive=true,tree,closed=0,added=[],accept=true,focusInside=true,controlFocus=0
  const document={visibilityState:'visible',activeElement:null,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)}
  const window={addEventListener:(name,fn)=>windowListeners.set(name,fn),removeEventListener:name=>windowListeners.delete(name)}
  const changed=(old,next)=>!old||old.length!==next.length||old.some((value,index)=>value!==next[index])
  const react={
    useState(value){const index=cursor++;slots[index]??={value:typeof value==='function'?value():value};return[slots[index].value,next=>{assert.ok(alive,'State write after capture unmount');slots[index].value=typeof next==='function'?next(slots[index].value):next}]},
    useRef(value){const index=cursor++;slots[index]??={current:value};return slots[index]},
    useCallback(fn,deps){const index=cursor++;if(changed(slots[index]?.deps,deps))slots[index]={fn,deps};return slots[index].fn},
    useEffect(fn,deps){const index=cursor++;if(changed(slots[index]?.deps,deps)){const previous=slots[index];slots[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();slots[index].cleanup=fn()})}},
  }
  const video={srcObject:null,pause(){},readyState:2,videoWidth:720,videoHeight:1280}
  const helpers={
    openDualPhotoCamera:async(facing,previous,signal)=>{const candidate=stream(track(facing,facing+'-'+cameras.length));cameras.push({facing,previous,signal,stream:candidate})
      const queued=queuedCameras.shift();return queued?await queued.promise:{stream:candidate,identity:{facing,deviceId:facing,reportedFacing:true}}},
    stopDualPhotoStream:helper.stopDualPhotoStream,
    waitForDualPhotoVideo:async(element,media,signal)=>{assert.equal(element,video);element.srcObject=media;if(signal.aborted)throw new DOMException('Cancelled','AbortError')},
    captureDualPhotoFrame:(_video,facing)=>{captures.push(facing);return{facing,canvas:{width:1200,height:1600}}},
    composeDualPhoto:async(rear,selfie,main,signal)=>{compositions.push({rear,selfie,main,signal});const queued=queuedComposition.shift();if(queued)return queued.promise;return new File(['syntheticjpeg'],'dual.jpg',{type:'image/jpeg'})},
    dualPhotoDelay:(ms,signal)=>ms===200?Promise.resolve():new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('Cancelled','AbortError'));signal.addEventListener('abort',abort,{once:true});countdowns.push(()=>{signal.removeEventListener('abort',abort);resolve()})}),
    dualPhotoError:helper.dualPhotoError,
  }
  const revoked=[];let nextUrl=0
  const jsx=(type,props)=>({type,props})
  const component=execute(componentSource,{react,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},
    'lucide-react':Object.fromEntries(['ArrowLeftRight','Camera','Check','Loader2','RotateCcw','ShieldCheck'].map(name=>[name,name])),
    './CommunityChatPrimitives':{ChatDialog:'ChatDialog',chatButton:'button',chatPrimary:'primary'},'../lib/dualPhoto':helpers},
    {document,window,URL:{createObjectURL:()=>`blob:synthetic-${++nextUrl}`,revokeObjectURL:url=>revoked.push(url)}}).DualPhotoCapture
  const props={onCapture:file=>{added.push(file);return accept},onClose:()=>closed++}
  const render=()=>{cursor=0;tree=component(props);for(const node of nodes(tree))if(node.props?.ref){node.props.ref.current=node.type==='video'?video:{
    closest:()=>({contains:()=>focusInside,querySelector:()=>({focus(){controlFocus++;focusInside=true}})}),focus(){throw new Error('Prefer an enabled control recognized by the dialog Tab trap')},
  }}effects.splice(0).forEach(fn=>fn());return tree}
  render()
  return {render,cameras,captures,compositions,queuedCameras,queuedComposition,revoked,document,windowListeners,
    get tree(){return tree},get added(){return added},get closed(){return closed},set accept(value){accept=value},
    get controlFocus(){return controlFocus},focusOutside(){focusInside=false},
    async settle(){await flush();return render()},async click(label){const button=nodes(render()).find(node=>node.type==='button'&&textOf(node).trim()===label);assert.ok(button,'Missing '+label);const result=button.props.onClick();await flush();render();return result},
    async tick(){const next=countdowns.shift();assert.ok(next,'No countdown pending');next();await flush();render()},
    hide(){document.visibilityState='hidden';listeners.get('visibilitychange')?.();render()},
    show(){document.visibilityState='visible';listeners.get('visibilitychange')?.();render()},
    close(){tree.props.onClose();render()},
    unmount(){slots.forEach(slot=>slot?.cleanup?.());alive=false},
  }
}
async function reviewed(fx) {await fx.settle();await fx.click('Зняти подвійне фото');await fx.tick();await fx.tick();await fx.tick();await fx.settle()}

test('one shutter captures rear then distinct front after readiness and three ticks; no callback/upload until explicit add',async()=>{
  const fx=componentFixture();await fx.settle()
  assert.deepEqual(fx.cameras.map(camera=>camera.facing),['environment'])
  const openingVideo=nodes(fx.tree).find(node=>node.type==='video')
  assert.equal(openingVideo.props.muted,true);assert.equal(openingVideo.props.playsInline,true)
  await fx.click('Зняти подвійне фото')
  assert.deepEqual(fx.captures,['environment']);assert.equal(fx.cameras[0].stream.videoTrack.stops,1)
  assert.deepEqual(fx.cameras.map(camera=>camera.facing),['environment','user'])
  assert.equal(fx.cameras[1].previous.deviceId,'environment')
  await fx.tick();await fx.tick();assert.equal(fx.captures.length,1)
  await fx.tick();await fx.settle()
  assert.deepEqual(fx.captures,['environment','user']);assert.equal(fx.cameras[1].stream.videoTrack.stops,1)
  assert.equal(fx.added.length,0);assert.match(textOf(fx.tree),/Перевірте обидва кадри/)
  const button=nodes(fx.tree).find(node=>node.type==='button'&&textOf(node).trim()==='Додати до повідомлення')
  button.props.onClick();button.props.onClick()
  assert.equal(fx.added.length,1);assert.equal(fx.added[0].type,'image/jpeg');assert.equal(fx.closed,0)
  fx.unmount();assert.equal(fx.revoked.length,1)
})

test('review supports swap and retake; a rejected attachment stays review without auto-close or a stuck busy state',async()=>{
  const fx=componentFixture();await reviewed(fx)
  await fx.click('Поміняти кадри');assert.equal(fx.compositions.at(-1).main,true);assert.equal(fx.revoked.length,1)
  fx.accept=false;await fx.click('Додати до повідомлення')
  assert.equal(fx.closed,0);assert.match(textOf(fx.tree),/Перевірте кількість і розмір вкладень/)
  const add=nodes(fx.tree).find(node=>node.type==='button'&&textOf(node).trim()==='Додати до повідомлення')
  assert.equal(add.props.disabled,false)
  await fx.click('Перезняти');assert.equal(fx.cameras.at(-1).facing,'environment')
  assert.equal(fx.revoked.length,2);fx.unmount()
})

test('replacing a focused review control restores focus to an enabled dialog control while composing',async()=>{
  const fx=componentFixture();await reviewed(fx)
  const waiting=deferred();fx.queuedComposition.push(waiting);fx.focusOutside()
  await fx.click('Поміняти кадри')
  assert.equal(fx.controlFocus,1)
  waiting.resolve(new File(['swapped'],'swapped.jpg',{type:'image/jpeg'}));await fx.settle()
  assert.match(textOf(fx.tree),/Перевірте обидва кадри/)
  fx.unmount()
})

test('closing/unmounting/backgrounding stops active tracks and countdown, never captures or emits a late photo',async()=>{
  for(const action of ['close','unmount','hide']) {
    const fx=componentFixture();await fx.settle();await fx.click('Зняти подвійне фото')
    const front=fx.cameras[1].stream
    fx[action]();await flush()
    assert.equal(front.videoTrack.stops,1);assert.equal(fx.captures.length,1);assert.equal(fx.added.length,0)
    if(action==='hide'){assert.match(textOf(fx.tree),/Зйомку призупинено/);fx.show();assert.equal(fx.cameras.length,2)}
    if(action!=='unmount')fx.unmount()
  }
})

test('a camera resolving after close is immediately released and cannot replace the visible session',async()=>{
  const fx=componentFixture();await fx.settle();fx.hide();fx.show()
  const pending=deferred(),late=stream(track('environment','late'))
  fx.queuedCameras.push(pending)
  await fx.click('Почати зйомку знову')
  fx.close();pending.resolve({stream:late,identity:{facing:'environment',deviceId:'late',reportedFacing:true}})
  await flush();assert.equal(late.videoTrack.stops,1);assert.equal(fx.added.length,0)
  fx.unmount()
})

test('a late previous camera cannot replace a newer session after background and explicit restart',async()=>{
  const fx=componentFixture();await fx.settle();fx.hide();fx.show()
  const pending=deferred(),late=stream(track('environment','late'))
  fx.queuedCameras.push(pending);await fx.click('Почати зйомку знову')
  fx.hide();fx.show();await fx.click('Почати зйомку знову')
  const active=fx.cameras.at(-1).stream
  pending.resolve({stream:late,identity:{facing:'environment',deviceId:'late',reportedFacing:true}})
  await fx.settle()
  assert.equal(late.videoTrack.stops,1);assert.equal(active.videoTrack.stops,0)
  assert.match(textOf(fx.tree),/Зніміть те, що перед вами/)
  fx.unmount();assert.equal(active.videoTrack.stops,1)
})

test('two rapid shutter callbacks start a single rear/front sequence',async()=>{
  const fx=componentFixture();await fx.settle()
  const shutter=nodes(fx.tree).find(node=>node.type==='button'&&textOf(node).trim()==='Зняти подвійне фото')
  shutter.props.onClick();shutter.props.onClick();await fx.settle()
  assert.deepEqual(fx.captures,['environment']);assert.equal(fx.cameras.length,2)
  fx.unmount();await flush()
})

test('an export resolving after unmount cannot create an object URL, update state or call attachment callbacks',async()=>{
  const fx=componentFixture();await fx.settle();await fx.click('Зняти подвійне фото')
  const waiting=deferred();fx.queuedComposition.push(waiting)
  await fx.tick();await fx.tick();await fx.tick()
  fx.unmount();waiting.resolve(new File(['late'],'late.jpg',{type:'image/jpeg'}));await flush()
  assert.equal(fx.revoked.length,0);assert.equal(fx.added.length,0)
})

test('capture UI does not import any upload/database service and keeps opening video visible for mobile frame callbacks',()=>{
  assert.doesNotMatch(componentSource,/supabase|fetch\(|upload|sendMessage\(/)
  assert.match(componentSource,/phase === 'openingRear' \|\| phase === 'rear' \|\| phase === 'openingFront'/)
  assert.match(componentSource,/ChatDialog title="Подвійне фото" onClose=\{close\}/)
})
