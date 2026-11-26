import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read=name=>readFile(new URL('../../'+name,import.meta.url),'utf8')
const source=await read('src/context/ThemeContext.tsx')
const modelSource=await read('src/lib/halloweenTheme.ts')
const dailySource=await read('src/lib/dailyTheme.ts')
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
  const module={exports:{}},model={exports:{}},daily={exports:{}}
  vm.runInNewContext(compile(modelSource),{module:model,exports:model.exports,Date:Clock})
  vm.runInNewContext(compile(dailySource),{module:daily,exports:daily.exports,Date:Clock,require:()=>model.exports})
  vm.runInNewContext(compile(source),{
    module,exports:module.exports,window,document,Date:Clock,
    setTimeout(callback,delay){const id=nextTimer++;timers.set(id,{callback,due:time+delay});return id},
    clearTimeout(id){timers.delete(id)},
    require(name){
      if(name==='react')return React
      if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
      if(name==='../lib/halloweenTheme')return model.exports
      if(name==='../lib/dailyTheme')return daily.exports
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
    values,root,timers,get value(){return result.props.value},
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

const pref='xelay_theme_preference_v2'
const at=(hour,minute=0)=>new Date(2026,10,26,hour,minute,0,0).getTime()
test('new and existing users start in auto; old choices migrate once',()=>{
  for(const saved of [undefined,'light','dark','halloween']){
    const app=provider({now:at(6,59),values:{xelay_theme:saved}})
    assert.equal(app.value.preference,'auto');assert.equal(app.value.theme,'dark')
    app.advance(at(7));assert.equal(app.value.theme,'light')
    app.advance(at(19));assert.equal(app.value.theme,'dark')
    assert.equal(app.timers.size,1)
    app.unmount();assert.equal(app.timers.size,0)
  }
})
test('manual choice survives reload, night and future opens until auto is selected',()=>{
  const values={},app=provider({now:at(20),values})
  app.choose('light');app.focus();app.visible()
  assert.equal(app.value.theme,'light');assert.equal(values[pref],'light')
  app.advance(at(23));assert.equal(app.value.theme,'light')
  const reloaded=provider({now:at(23),values});assert.equal(reloaded.value.theme,'light')
  reloaded.choose('auto');assert.equal(reloaded.value.theme,'dark');assert.equal(reloaded.value.preference,'auto')
  app.unmount();reloaded.unmount()
})
test('cross-tab preferences and resumed tabs reconcile',()=>{
  const app=provider({now:at(12)})
  app.storageEvent(pref,'dark');assert.equal(app.value.theme,'dark')
  app.storageEvent(pref,'auto');assert.equal(app.value.theme,'light')
  app.advance(at(20));app.visible();assert.equal(app.value.theme,'dark')
  app.storageEvent(pref,'light');assert.equal(app.value.theme,'light')
  app.storageEvent(null,null);assert.equal(app.value.theme,'dark');assert.equal(app.value.preference,'auto')
  app.unmount()
})
test('blocked or full storage preserves a manual choice in memory and retries safely',()=>{
  for(const readBlocked of [true,false]){
    const app=provider({now:at(20),readBlocked,writeBlocked:true})
    app.choose('light');app.focus();app.visible();assert.equal(app.value.theme,'light')
    app.setFailures(false,false);app.focus()
    assert.equal(app.value.theme,'light');assert.equal(app.values[pref],'light')
    app.unmount()
  }
})
test('auto uses local time, not the OS light/dark setting',()=>{
  const app=provider({now:at(12),dark:true})
  assert.equal(app.value.theme,'light')
  app.setSystem(false);app.setSystem(true);assert.equal(app.value.theme,'light')
  app.advance(at(20));assert.equal(app.value.theme,'dark')
  app.unmount()
})
test('expired seasonal preference falls back to auto and cannot be reselected',()=>{
  const app=provider({now:at(12),values:{[pref]:'halloween'}})
  assert.equal(app.value.theme,'light');assert.equal(app.value.halloweenAvailable,false)
  app.choose('dark');app.choose('halloween');assert.equal(app.value.theme,'dark')
  app.unmount()
})
test('explicit seasonal theme expires at its boundary',()=>{
  const app=provider({now:start,values:{[pref]:'halloween'}})
  assert.equal(app.value.theme,'halloween')
  app.advance(end)
  const hour=new Date(end).getHours()
  assert.equal(app.value.theme,hour>=7&&hour<19?'light':'dark')
  app.unmount()
})
test('isolated preview does not write real preferences',()=>{
  const values={[pref]:'dark'},app=provider({now:at(12),values,preview:true})
  assert.equal(app.value.theme,'halloween');assert.equal(app.value.halloweenAvailable,true)
  app.choose('light');app.choose('dark');app.choose('halloween');app.advance(end+1000)
  assert.equal(app.value.theme,'halloween');assert.deepEqual(values,{[pref]:'dark'})
  app.unmount()
})
