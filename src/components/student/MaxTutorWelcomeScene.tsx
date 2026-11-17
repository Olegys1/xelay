import {useEffect,useId,useRef,type ReactNode} from 'react'
import './maxTutorWelcomeScene.css'

export const MAX_TUTOR_WELCOME_SCENE_LIMITS=Object.freeze({points:512,fps:30,maxDpr:1.5,maxWidth:420,maxHeight:320})
type SceneRuntime={
 requestFrame:(callback:FrameRequestCallback)=>number;cancelFrame:(id:number)=>void
 hidden:()=>boolean;reducedMotion:()=>boolean;pixelRatio:()=>number
 onVisibility:(listener:()=>void)=>()=>void;onMotion:(listener:()=>void)=>()=>void
 observeSize:(element:HTMLElement,listener:()=>void)=>()=>void
 observeVisibility?:(element:HTMLElement,listener:(visible:boolean)=>void)=>()=>void
 wine?:readonly[number,number,number]
}

function browserRuntime(host:HTMLElement):SceneRuntime{
 const preference=window.matchMedia('(prefers-reduced-motion: reduce)')
 const accent=window.getComputedStyle(host).getPropertyValue('--mta-accent').trim(),rgb=/^#([a-f\d]{6})$/i.exec(accent)?.[1]
 return{
  ...(rgb?{wine:[parseInt(rgb.slice(0,2),16),parseInt(rgb.slice(2,4),16),parseInt(rgb.slice(4,6),16)] as const}:{}),
  requestFrame:callback=>window.requestAnimationFrame(callback),cancelFrame:id=>window.cancelAnimationFrame(id),
  hidden:()=>document.hidden,reducedMotion:()=>preference.matches,pixelRatio:()=>window.devicePixelRatio||1,
  onVisibility(listener){document.addEventListener('visibilitychange',listener);return()=>document.removeEventListener('visibilitychange',listener)},
  onMotion(listener){preference.addEventListener('change',listener);return()=>preference.removeEventListener('change',listener)},
  observeSize(element,listener){if(typeof ResizeObserver!=='undefined'){const observer=new ResizeObserver(listener);observer.observe(element);return()=>observer.disconnect()}window.addEventListener('resize',listener,{passive:true});return()=>window.removeEventListener('resize',listener)},
  ...(typeof IntersectionObserver==='undefined'?{}:{observeVisibility(element:HTMLElement,listener:(visible:boolean)=>void){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.target===element)listener(entry.isIntersecting&&entry.intersectionRatio>0)},{threshold:0});observer.observe(element);return()=>observer.disconnect()}}),
 }
}

/** A decorative, fixed-size mesh. It never reads account data or starts a network request. */
export function startMaxTutorWelcomeScene(canvas:HTMLCanvasElement,host:HTMLElement,runtime:SceneRuntime=browserRuntime(host)):()=>void{
 const context=canvas.getContext('2d',{alpha:true})
 if(!context)return()=>{}
 const {points:count,fps,maxDpr,maxWidth,maxHeight}=MAX_TUTOR_WELCOME_SCENE_LIMITS,major=64,minor=8
 const mesh=Array.from({length:count},(_,index)=>{const u=index%major/major*Math.PI*2,v=Math.floor(index/major)/minor*Math.PI*2;return{cos:Math.cos(u),sin:Math.sin(u),u,v,x:0,y:0,z:0,size:0,gold:Math.floor(index/major)%4===1}})
 let disposed=false,visible=!runtime.observeVisibility,frame:number|null=null,phase=0,width=0,height=0,dpr=1,aimX=0,aimY=0,tiltX=0,tiltY=0,last:number|null=null,left=0,top=0
 const wine=[.16,.31,.56,.8].map(alpha=>`rgba(${(runtime.wine||[139,48,86]).join(',')},${alpha})`)
 const gold=['rgba(168,127,61,.22)','rgba(174,132,64,.38)','rgba(183,143,77,.65)','rgba(194,157,95,.9)']
 const stops:(()=>void)[]=[]
 function ready(value:boolean){canvas.dataset.ready=value?'true':'false'}
 function shouldRun(){return !disposed&&visible&&!runtime.hidden()&&!runtime.reducedMotion()}
 function draw(){
  context!.clearRect(0,0,width,height)
  tiltX+=(aimX-tiltX)*.055;tiltY+=(aimY-tiltY)*.055
  const scale=Math.min(width/340,height/254),rotation=phase*.12-.3+tiltX*.12,lean=.63+Math.sin(phase*.22)*.13+tiltY*.1
  const cosR=Math.cos(rotation),sinR=Math.sin(rotation),cosL=Math.cos(lean),sinL=Math.sin(lean)
  for(const point of mesh){
   const fold=point.v+point.u*3+phase*.2,radius=91+Math.cos(fold)*17+Math.sin(point.u*3-phase*.28)*4
   const x=radius*point.cos,y=radius*point.sin,z=Math.sin(fold)*19+Math.sin(point.u*3+phase*.23)*12
   const turnedX=x*cosR-y*sinR,turnedY=x*sinR+y*cosR,depth=turnedY*sinL+z*cosL,perspective=370/(370-depth)
   point.x=width/2+(turnedX*perspective+tiltX*3)*scale;point.y=height/2+(turnedY*cosL-z*sinL+tiltY*3)*perspective*scale;point.z=depth;point.size=(.65+(depth+90)/210)*scale
  }
  // Eight fine continuous strands give the point cloud a coherent woven surface.
  for(let strand=0;strand<minor;strand++){
   context!.beginPath()
   for(let at=0;at<=major;at++){const point=mesh[strand*major+at%major];if(at===0)context!.moveTo(point.x,point.y);else context!.lineTo(point.x,point.y)}
   context!.strokeStyle=strand%4===1?'rgba(172,132,63,.24)':'rgba(137,39,78,.16)';context!.lineWidth=.52*scale;context!.stroke()
  }
  // Fixed depth/color buckets avoid allocating particle objects or colors each frame.
  for(let layer=0;layer<4;layer++)for(let color=0;color<2;color++){
   context!.beginPath()
   for(const point of mesh)if(Math.max(0,Math.min(3,Math.floor((point.z+95)/48)))===layer&&Number(point.gold)===color){context!.moveTo(point.x+point.size,point.y);context!.arc(point.x,point.y,point.size,0,Math.PI*2)}
   context!.fillStyle=(color?gold:wine)[layer];context!.fill()
  }
  ready(true)
 }
 function resize(){
  if(disposed)return
  const bounds=host.getBoundingClientRect(),nextWidth=Math.max(1,Math.min(maxWidth,bounds.width)),nextHeight=Math.max(1,Math.min(maxHeight,bounds.height)),nextDpr=Math.max(1,Math.min(maxDpr,runtime.pixelRatio()||1));left=bounds.left;top=bounds.top
  if(width===nextWidth&&height===nextHeight&&dpr===nextDpr)return
  width=nextWidth;height=nextHeight;dpr=nextDpr;canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);context!.setTransform(dpr,0,0,dpr,0,0)
  if(shouldRun())draw()
 }
 function tick(now:number){
  frame=null;if(!shouldRun())return
  if(last===null||now-last>=1000/fps){phase+=last===null?0:Math.min(50,now-last)/1000;last=now;draw()}
  frame=runtime.requestFrame(tick)
 }
 function synchronize(){
  if(shouldRun()){if(frame===null){last=null;frame=runtime.requestFrame(tick)}}else{if(frame!==null)runtime.cancelFrame(frame);frame=null;last=null;if(runtime.reducedMotion())ready(false)}
 }
 function pointer(event:PointerEvent){aimX=Math.max(-1,Math.min(1,(event.clientX-left)/Math.max(1,width)*2-1));aimY=Math.max(-1,Math.min(1,(event.clientY-top)/Math.max(1,height)*2-1))}
 const leave=()=>{aimX=0;aimY=0}
 host.addEventListener('pointermove',pointer,{passive:true});host.addEventListener('pointerleave',leave,{passive:true})
 stops.push(()=>host.removeEventListener('pointermove',pointer),()=>host.removeEventListener('pointerleave',leave),runtime.onVisibility(synchronize),runtime.onMotion(synchronize),runtime.observeSize(host,resize))
 if(runtime.observeVisibility)stops.push(runtime.observeVisibility(host,value=>{visible=value;synchronize()}))
 resize();synchronize()
 return()=>{if(disposed)return;disposed=true;if(frame!==null)runtime.cancelFrame(frame);frame=null;for(const stop of stops)stop();ready(false);canvas.width=1;canvas.height=1}
}

export function MaxTutorWelcomeScene({children,active=true}:{children:ReactNode;active?:boolean}){
 const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),id=useId().replace(/:/g,'')
 useEffect(()=>{if(!active||!host.current||!canvas.current||typeof window==='undefined')return;return startMaxTutorWelcomeScene(canvas.current,host.current)},[active])
 return <div ref={host} className="mtw-scene"><div className="mtw-scene-light" aria-hidden="true"/><canvas ref={canvas} className="mtw-scene-canvas" aria-hidden="true"/><svg className="mtw-scene-static" viewBox="0 0 340 254" fill="none" aria-hidden="true"><defs><linearGradient id={`mtw-wine-${id}`} x1="64" y1="58" x2="286" y2="213" gradientUnits="userSpaceOnUse"><stop stopColor="#b76b87" stopOpacity=".3"/><stop offset=".5" stopColor="#7e2049"/><stop offset="1" stopColor="#c9a36a"/></linearGradient></defs><g stroke={`url(#mtw-wine-${id})`} strokeWidth=".9"><ellipse cx="170" cy="127" rx="108" ry="70" transform="rotate(-19 170 127)"/><ellipse cx="170" cy="127" rx="99" ry="62" transform="rotate(-12 170 127)"/><ellipse cx="170" cy="127" rx="91" ry="76" transform="rotate(12 170 127)"/><ellipse cx="170" cy="127" rx="83" ry="81" transform="rotate(25 170 127)"/><path d="M69 147C42 63 184 20 253 77s31 122-46 132S74 193 69 147Z"/><path d="M78 164C45 98 134 32 211 47s95 89 50 132S111 221 78 164Z"/></g><g fill="#b48c53">{Array.from({length:32},(_,index)=>{const angle=index/32*Math.PI*2;return <circle key={index} cx={170+Math.cos(angle)*101} cy={127+Math.sin(angle)*70} r={index%4===0?1.6:.85} opacity={.25+index%4*.15}/>})}</g></svg><div className="mtw-scene-control">{children}</div></div>
}
