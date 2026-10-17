import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read=name=>readFile(new URL('../../'+name,import.meta.url),'utf8')
const source=await read('src/context/ThemeContext.tsx')
const modelSource=await read('src/lib/halloweenTheme.ts')
const compile=value=>ts.transpileModule(value,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText
const start=Date.parse('2026-10-18T09:00:00Z'),end=Date.parse('2026-11-02T22:00:00Z')
const marker='xelay_halloween_2026_theme_choice'

// Execute the real provider's hooks, effects and timers without network or a test DOM dependency.
function provider({now=start-1,values={},dark=false,readBlocked=false,writeBlocked=false,preview=false}={}){
  let time=now,dirty=true,index=0,result,steps=0,nextTimer=1
  const cells=[],effects=[],timers=new Map()
  class Target{
    listeners=new Map()
    addEventListener(key,callback){if(!this.listeners.has(key))this.listeners.set(key,new Set());this.listeners.get(key).add(callback)}
    removeEventListener(key,callback){this.listeners.get(key)?.delete(callback)}
    fire(key,event={}){for(const callback of this.listeners.get(key)||[])callback({type:key,...event})}
  }
  const storage={
    getItem(key){if(readBlocked)throw Error('storage blocked');return values[key]??null},
    setItem(key,value){if(writeBlocked)throw Error('quota exceeded');values[key]=value},
  }
  const system=new Target();system.matches=dark
  const window=new Target();window.localStorage=storage;window.matchMedia=()=>system
  const root={dataset:{theme:dark?'dark':'light',baseTheme:dark?'dark':'light'},style:{},classList:{toggle(){}}}
  const document=new Target();document.documentElement=root;document.visibilityState='visible'
  const equal=(a,b)=>Boolean(a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i])))
  const memo=(make,deps)=>{const slot=index++;if(!cells[slot]||!equal(cells[slot].deps,deps))cells[slot]={deps,value:make()};return cells[slot].value}
  const effect=(run,deps)=>{const slot=index++;if(!cells[slot])cells[slot]={};const cell=cells[slot];if(!equal(cell.deps,deps)){cell.deps=deps;effects.push(()=>{cell.cleanup?.();cell.cleanup=run()})}}
  const React={
    createContext:value=>({Provider:{},initial:value}),
    useState(initial){const slot=index++;if(!cells[slot])cells[slot]={value:typeof initial==='function'?initial():initial};return[cells[slot].value,next=>{const value=typeof next==='function'?next(cells[slot].value):next;if(!Object.is(value,cells[slot].value)){cells[slot].value=value;dirty=true}}]},
    useRef(initial){const slot=index++;if(!cells[slot])cells[slot]={value:{current:initial}};return cells[slot].value},
    useMemo:memo,useCallback:(value,deps)=>memo(()=>value,deps),useEffect:effect,useLayoutEffect:effect,
    useContext:context=>context.initial,
  }
  class Clock extends Date{static now(){return time}}
  const module={exports:{}},model={exports:{}}
  vm.runInNewContext(compile(modelSource),{module:model,exports:model.exports,Date:Clock})
  vm.runInNewContext(compile(source),{
    module,exports:module.exports,window,document,Date:Clock,
    setTimeout(callback,delay){const id=nextTimer++;timers.set(id,{callback,due:time+delay});return id},
    clearTimeout(id){timers.delete(id)},
    require(name){
      if(name==='react')return React
      if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
      if(name==='../lib/halloweenTheme')return model.exports
      if(name.endsWith('.css'))return{}
      throw Error(name)
    },
  })
  const element=preview?module.exports.SeasonalThemePreviewProvider({children:null}):module.exports.ThemeProvider({children:null})
  function flush(){
    steps=0
    while(dirty||effects.length){
      if(++steps>60)throw Error('Provider failed to settle')
      if(dirty){dirty=false;index=0;result=element.type(element.props)}
      while(effects.length)effects.shift()()
    }
  }
  flush()
  return{
    values,root,get value(){return result.props.value},
    choose(theme){result.props.value.setTheme(theme);flush()},
    focus(){window.fire('focus');flush()},
    visible(){document.fire('visibilitychange');flush()},
    storageEvent(key,newValue){if(key===null){for(const name of Object.keys(values))delete values[name]}else if(newValue===null)delete values[key];else values[key]=newValue;window.fire('storage',{key,newValue,storageArea:storage});flush()},
    setSystem(value){system.matches=value;system.fire('change');flush()},
    setFailures(read,write){readBlocked=read;writeBlocked=write},
    advance(next){time=next;for(let pass=0;pass<20;pass++){const due=[...timers.entries()].filter(([,timer])=>timer.due<=time);if(!due.length)break;for(const [id,timer]of due){timers.delete(id);timer.callback()}flush()}flush()},
    unmount(){for(const cell of cells)cell?.cleanup?.()},
  }
}

test('an already-open normal page switches exactly at launch and restores the prior normal theme at expiry',()=>{
  for(const normal of ['light','dark']){
    const app=provider({values:{xelay_theme:normal,xelay_theme_base:normal},now:start-1})
    assert.equal(app.value.theme,normal);assert.equal(app.value.halloweenAvailable,false)
    app.advance(start);assert.equal(app.value.theme,'halloween');assert.equal(app.value.halloweenAvailable,true)
    assert.equal(app.values.xelay_theme_base,normal);assert.equal(app.values[marker],undefined)
    app.advance(end-1);assert.equal(app.value.theme,'halloween')
    app.advance(end);assert.equal(app.value.theme,normal);assert.equal(app.value.halloweenAvailable,false)
    app.unmount()
  }
})

test('an explicit normal choice survives focus, visibility, reload and another tab; choosing Halloween remains possible',()=>{
  const values={xelay_theme:'dark'}
  const app=provider({now:start,values});assert.equal(app.value.theme,'halloween')
  app.choose('light');app.focus();app.visible();assert.equal(app.value.theme,'light')
  assert.equal(JSON.parse(values[marker]).theme,'light')
  const tab=provider({now:start+10,values});assert.equal(tab.value.theme,'light')
  app.choose('dark')
  tab.storageEvent(marker,values[marker]);assert.equal(tab.value.theme,'dark')
  app.choose('halloween');tab.storageEvent(marker,values[marker])
  assert.equal(tab.value.theme,'halloween');assert.equal(tab.values.xelay_theme_base,'dark')
  tab.advance(end);assert.equal(tab.value.theme,'dark')
  app.unmount();tab.unmount()
})

test('blocked reads and writes still preserve an explicit opt-out and the latest normal preference within the page',()=>{
  const app=provider({now:start,dark:true,readBlocked:true,writeBlocked:true})
  assert.equal(app.value.theme,'halloween')
  app.choose('light');app.focus();app.visible();assert.equal(app.value.theme,'light')
  app.choose('halloween');app.focus();assert.equal(app.value.theme,'halloween')
  app.advance(end);assert.equal(app.value.theme,'light')
  app.unmount()
})

test('readable but unwritable storage never overwrites a newer in-memory choice or its normal fallback',()=>{
  const app=provider({now:start,values:{xelay_theme:'halloween',xelay_theme_base:'dark'},writeBlocked:true})
  app.choose('light');app.focus();assert.equal(app.value.theme,'light')
  app.choose('halloween');app.focus();assert.equal(app.value.theme,'halloween')
  app.advance(end);assert.equal(app.value.theme,'light')
  app.unmount()
})

test('a failed storage write retries when storage becomes available without forcing the seasonal default again',()=>{
  const app=provider({now:start,values:{xelay_theme:'dark'},writeBlocked:true})
  app.choose('light');app.focus();assert.equal(app.value.theme,'light')
  app.setFailures(false,false);app.focus()
  assert.equal(app.value.theme,'light');assert.equal(app.values.xelay_theme,'light')
  assert.equal(JSON.parse(app.values[marker]).theme,'light')
  app.focus();assert.equal(app.value.theme,'light')
  app.unmount()
})

test('OS fallback remains live outside the season and an early user switch does not create a seasonal opt-out',()=>{
  const app=provider({now:start-1000})
  assert.equal(app.values.xelay_theme,undefined)
  app.setSystem(true);assert.equal(app.value.theme,'dark')
  app.choose('light');assert.equal(app.values[marker],undefined)
  app.advance(start);assert.equal(app.value.theme,'halloween')
  app.unmount()
})

test('an expired campaign marker cannot change a normal page outside the event',()=>{
  const values={xelay_theme:'dark',[marker]:JSON.stringify({campaign:'halloween-2026',theme:'light',chosenAt:start})}
  const before=provider({now:start-1,values:{...values}});assert.equal(before.value.theme,'dark')
  const after=provider({now:end,values:{...values}});assert.equal(after.value.theme,'dark')
  before.unmount();after.unmount()
})

test('the local preview provider permits all three choices without touching production preference keys',()=>{
  const values={xelay_theme:'dark'}
  const app=provider({now:start-10000,values,preview:true})
  assert.equal(app.value.theme,'halloween');assert.equal(app.value.halloweenAvailable,true)
  app.choose('light');app.focus();assert.equal(app.value.theme,'light')
  app.choose('dark');app.choose('halloween');app.advance(end+1000)
  assert.equal(app.value.theme,'halloween');assert.deepEqual(values,{xelay_theme:'dark'})
  app.unmount()
})
