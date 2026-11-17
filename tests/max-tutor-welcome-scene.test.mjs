import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../src/components/student/MaxTutorWelcomeScene.tsx',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
function load(globals={},hooks={}){const module={exports:{}},jsx=(type,props,key)=>({type,props:props||{},key});runInNewContext(compiled,{module,exports:module.exports,Math,Number,Array,Object,parseInt,...globals,require(name){if(name==='react')return{useEffect(){},useId:()=>':static-scene:',useRef:()=>({current:null}),...hooks};if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};assert.equal(name,'./maxTutorWelcomeScene.css');return{}}});return module.exports}
function fixture({reduced=false,noContext=false}={}){
 const callbacks={},frames=new Map(),events=new Map(),styles=[],disconnected=[],state={hidden:false,reduced,dpr:3},bounds={width:300,height:240,left:0,top:0};let serial=0,draws=0,arcs=0
 const context={clearRect(){draws++;arcs=0},setTransform(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){arcs++},fill(){},set fillStyle(value){styles.push(value)}}
 const canvas={dataset:{},width:0,height:0,getContext(){return noContext?null:context}}
 const host={getBoundingClientRect:()=>bounds,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{assert.equal(events.get(name),fn);events.delete(name)}}
 const subscribe=(name,fn)=>{callbacks[name]=fn;return()=>disconnected.push(name)}
 const runtime={requestFrame:fn=>{frames.set(++serial,fn);return serial},cancelFrame:id=>frames.delete(id),hidden:()=>state.hidden,reducedMotion:()=>state.reduced,pixelRatio:()=>state.dpr,onVisibility:fn=>subscribe('visibility',fn),onMotion:fn=>subscribe('motion',fn),observeSize:(_,fn)=>subscribe('size',fn),observeVisibility:(_,fn)=>subscribe('intersection',fn)}
 return{canvas,host,runtime,state,bounds,frames,callbacks,events,styles,disconnected,get draws(){return draws},get arcs(){return arcs},tick(time){assert.equal(frames.size,1,'Only one animation callback may be queued');const[id,fn]=frames.entries().next().value;frames.delete(id);fn(time)}}
}

test('the real welcome mesh waits for visibility and caps points, drawing rate and device pixels',()=>{
 const scene=load(),f=fixture(),dispose=scene.startMaxTutorWelcomeScene(f.canvas,f.host,f.runtime)
 assert.equal(f.frames.size,0);assert.equal(f.draws,0,'An offscreen welcome must not draw')
 assert.equal(f.canvas.width,450);assert.equal(f.canvas.height,360,'DPR3 is capped at1.5')
 f.callbacks.intersection(true);assert.equal(f.frames.size,1)
 f.tick(0);assert.equal(f.draws,1);assert.equal(f.arcs,512);assert.equal(f.canvas.dataset.ready,'true')
 f.tick(16);assert.equal(f.draws,1,'RAF at60Hz must not render more than30fps')
 f.tick(34);assert.equal(f.draws,2);assert.equal(f.arcs,512)
 f.bounds.width=1000;f.bounds.height=800;f.callbacks.size()
 assert.equal(f.canvas.width,630);assert.equal(f.canvas.height,480,'Large accidental layout sizes remain bounded')
 assert.equal(f.frames.size,1);dispose()
})

test('leaving the screen, hiding the document or enabling reduced motion cancels animation, with full cleanup on unmount',()=>{
 const scene=load(),f=fixture(),dispose=scene.startMaxTutorWelcomeScene(f.canvas,f.host,f.runtime)
 f.callbacks.intersection(true);f.tick(100);f.callbacks.intersection(false);assert.equal(f.frames.size,0)
 f.state.hidden=true;f.callbacks.intersection(true);assert.equal(f.frames.size,0)
 f.state.hidden=false;f.callbacks.visibility();assert.equal(f.frames.size,1)
 f.state.reduced=true;f.callbacks.motion();assert.equal(f.frames.size,0);assert.equal(f.canvas.dataset.ready,'false','Static SVG takes over when motion is reduced')
 f.state.reduced=false;f.callbacks.motion();assert.equal(f.frames.size,1)
 dispose();dispose();assert.equal(f.frames.size,0);assert.equal(f.events.size,0)
 assert.deepEqual([...f.disconnected].sort(),['intersection','motion','size','visibility'])
 assert.equal(f.canvas.width,1);assert.equal(f.canvas.height,1,'Canvas backing memory is released')
 const before=f.draws;f.callbacks.visibility();f.callbacks.intersection(true);f.callbacks.size()
 assert.equal(f.draws,before);assert.equal(f.frames.size,0,'Late observer callbacks cannot resurrect the scene')
})

test('initial reduced motion and unavailable canvas retain a static scene without animation work',()=>{
 const scene=load(),reduced=fixture({reduced:true}),stop=scene.startMaxTutorWelcomeScene(reduced.canvas,reduced.host,reduced.runtime)
 reduced.callbacks.intersection(true);assert.equal(reduced.frames.size,0);assert.equal(reduced.draws,0)
 reduced.state.reduced=false;reduced.callbacks.motion();assert.equal(reduced.frames.size,1);stop()
 const unavailable=fixture({noContext:true}),none=scene.startMaxTutorWelcomeScene(unavailable.canvas,unavailable.host,unavailable.runtime)
 assert.equal(unavailable.frames.size,0);assert.equal(unavailable.events.size,0);assert.deepEqual(Object.keys(unavailable.callbacks),[]);none()
 const effects=[],children={type:'button',props:{'aria-label':'Почати навчання з Максом'}}
 const disabled=load({}, {useEffect:fn=>effects.push(fn)})
 const tree=disabled.MaxTutorWelcomeScene({active:false,children});assert.equal(effects[0](),undefined)
 assert.equal(tree.props.children.at(-1).props.children,children,'The real accessible Start button is preserved')
 assert.ok(tree.props.children.some(node=>node.type==='svg'),'Static SVG exists even before hydration')
})

test('the browser adapter reads the theme once and never reads account, storage or network APIs',()=>{
 const f=fixture();let styleReads=0;const documentEvents=new Map(),windowEvents=new Map(),motionEvents=new Map()
 const scene=load({document:{hidden:false,addEventListener:(key,fn)=>documentEvents.set(key,fn),removeEventListener:key=>documentEvents.delete(key)},window:{requestAnimationFrame:f.runtime.requestFrame,cancelAnimationFrame:f.runtime.cancelFrame,devicePixelRatio:2,matchMedia:()=>({matches:false,addEventListener:(key,fn)=>motionEvents.set(key,fn),removeEventListener:key=>motionEvents.delete(key)}),getComputedStyle(){styleReads++;return{getPropertyValue:()=> '#db8ba6'}},addEventListener:(key,fn)=>windowEvents.set(key,fn),removeEventListener:key=>windowEvents.delete(key)}})
 const dispose=scene.startMaxTutorWelcomeScene(f.canvas,f.host)
 f.tick(0);f.tick(40);f.tick(80)
 assert.equal(styleReads,1);assert.ok(f.styles.includes('rgba(219,139,166,0.8)'))
 dispose();assert.equal(documentEvents.size,0);assert.equal(windowEvents.size,0);assert.equal(motionEvents.size,0)
})
