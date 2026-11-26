import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import {renderToStaticMarkup} from 'react-dom/server'

const read=name=>readFile(new URL('../../'+name,import.meta.url),'utf8')
const modelSource=await read('src/lib/halloweenTheme.ts')
const modelModule={exports:{}}
vm.runInNewContext(ts.transpileModule(modelSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:modelModule,exports:modelModule.exports})
const model=modelModule.exports
const start=Date.parse('2026-10-18T09:00:00Z'),end=Date.parse('2026-11-02T22:00:00Z')
const bootstrap=await read('public/theme-init.js')
const plain=value=>JSON.parse(JSON.stringify(value))
const choice=(theme,chosenAt=start+1)=>JSON.stringify({campaign:'halloween-2026',theme,chosenAt})

test('Halloween theme is available only in its agreed Kyiv interval, with an exclusive end',()=>{
  assert.equal(model.HALLOWEEN_THEME_START,start);assert.equal(model.HALLOWEEN_THEME_END,end)
  for(const time of [start-1,0,end,end+1,NaN,Infinity])assert.equal(model.isHalloweenThemeAvailable(time),false)
  for(const time of [start,start+1,Date.parse('2026-10-31T12:00:00Z'),end-1])assert.equal(model.isHalloweenThemeAvailable(time),true)
  assert.equal(model.nextHalloweenThemeBoundary(start-1),start)
  assert.equal(model.nextHalloweenThemeBoundary(start),end)
  assert.equal(model.nextHalloweenThemeBoundary(end),null)
})

test('the launch overrides old normal preferences once; an explicit seasonal choice then wins',()=>{
  for(const time of [start-1,start,end-1,end]){
    const active=time>=start&&time<end
    assert.deepEqual(plain(model.resolveSavedTheme('dark','light',false,time)),{theme:active?'halloween':'dark',base:'dark'})
    assert.deepEqual(plain(model.resolveSavedTheme('light','dark',true,time)),{theme:active?'halloween':'light',base:'light'})
    assert.deepEqual(plain(model.resolveSavedTheme(null,null,true,time)),{theme:active?'halloween':'dark',base:'dark'})
    assert.deepEqual(plain(model.resolveSavedTheme('invalid',null,false,time)),{theme:active?'halloween':'light',base:'light'})
    for(const base of ['dark','light']){
      assert.deepEqual(plain(model.resolveSavedTheme('halloween',base,false,time)),{theme:active?'halloween':base,base})
      assert.deepEqual(plain(model.resolveSavedTheme('halloween',base,false,time,choice('light'))),{theme:active?'light':base,base:active?'light':base})
    }
  }
})

test('seasonal choices are specific to the 2026 campaign and cannot be recorded before launch',()=>{
  for(const value of [null,'bad','{}',choice('light',start-1),choice('dark',end),choice('bad'),JSON.stringify({campaign:'halloween-2027',theme:'light',chosenAt:start}),choice('dark',start+.5)])assert.equal(model.parseHalloweenThemeChoice(value),null)
  for(const theme of ['light','dark','halloween'])assert.equal(model.parseHalloweenThemeChoice(choice(theme)).theme,theme)
  assert.equal(model.resolveSavedTheme('light',null,false,start,choice('light',start-1)).theme,'halloween')
})

function runBootstrap({saved=null,base=null,dark=false,now=start,blocked=false,writeBlocked=false,mediaBlocked=false,selected=null,preference=null,details=false}={}){
  const root={dataset:{},style:{},classList:{toggle(name,value){root.className=name;root.dark=value}}}
  const values={xelay_theme:saved,xelay_theme_base:base,xelay_halloween_2026_theme_choice:selected,xelay_theme_preference_v2:preference}
  class Clock extends Date {static now(){return now}}
  vm.runInNewContext(bootstrap,{
    document:{documentElement:root},Date:Clock,
    matchMedia(){if(mediaBlocked)throw Error('unavailable');return{matches:dark}},
    localStorage:{getItem(key){if(blocked)throw Error('blocked');return values[key]??null},setItem(key,value){if(blocked||writeBlocked)throw Error('blocked');values[key]=value}}
  })
  const presentation={theme:root.dataset.theme,dark:root.dark,colorScheme:root.style.colorScheme}
  return details?{presentation,values,base:root.dataset.baseTheme}:presentation
}


test('prepaint agrees with preference resolver at all daily and seasonal boundaries',async()=>{
  const daily={exports:{}}
  vm.runInNewContext(ts.transpileModule(await read('src/lib/dailyTheme.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:daily,exports:daily.exports,require:()=>model,Date})
  const times=[start,end,...[0,6,7,12,18,19,23].map(hour=>new Date(2026,10,26,hour).getTime())]
  for(const now of times)for(const preference of [null,'auto','light','dark','halloween','bad'])for(const saved of ['dark','light','halloween']){
    const expected=daily.exports.resolveThemePreference(daily.exports.parseThemePreference(preference),now)
    assert.deepEqual(runBootstrap({now,preference,saved}),{theme:expected,dark:expected!=='light',colorScheme:expected==='light'?'light':'dark'})
  }
  for(const hour of [6,7,18,19,23]){
    const now=new Date(2026,10,26,hour).getTime(),expected=hour>=7&&hour<19?'light':'dark'
    assert.equal(runBootstrap({now,blocked:true}).theme,expected)
    const boundary=daily.exports.nextDailyThemeBoundary(now)
    assert.ok(boundary>now);assert.ok(boundary-now<=24*60*60*1000)
    assert.equal(new Date(boundary).getMinutes(),0)
    assert.ok([7,19].includes(new Date(boundary).getHours()))
  }
})
test('prepaint respects the new manual preference and ignores legacy resolved theme',()=>{
  const now=new Date(2026,10,26,12).getTime()
  assert.equal(runBootstrap({now,saved:'dark'}).theme,'light')
  const result=runBootstrap({now,preference:'dark',details:true})
  assert.equal(result.presentation.theme,'dark');assert.equal(result.values.xelay_theme_preference_v2,'dark')
  assert.equal(runBootstrap({now,preference:'dark',writeBlocked:true}).theme,'dark')
})
test('production uses real time and the visual fixture stays isolated',async()=>{
  const provider=await read('src/context/ThemeContext.tsx'),entry=await read('src/main.tsx')
  assert.match(provider,/visibilitychange/);assert.match(provider,/'focus', reconcile/);assert.match(provider,/'storage', handleStorage/)
  assert.match(provider,/if \(previewTheme\) return/);assert.match(provider,/storageWriteFailed/)
  assert.doesNotMatch(provider+bootstrap,/import\.meta\.env|location\.|URLSearchParams/)
  assert.doesNotMatch(entry,/SeasonalThemePreviewProvider/);assert.match(entry,/<ThemeProvider>/)
})
const toggleSource=await read('src/components/ThemeToggle.tsx')
let themeState={theme:'light',halloweenAvailable:false,toggleTheme(){},setTheme(){}}
const toggleModule={exports:{}}
vm.runInNewContext(ts.transpileModule(toggleSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{
  module:toggleModule,exports:toggleModule.exports,
  require(name){
    if(name==='react')return React;if(name==='react/jsx-runtime')return jsx
    if(name==='react-dom')return{createPortal(){throw Error('A closed selector must not open a portal')}}
    if(name==='lucide-react')return{Check:()=>null,Moon:()=>null,Sun:()=>null,SunMoon:()=>null}
    if(name==='../context/ThemeContext')return{useTheme:()=>themeState}
    throw Error(name)
  }
})


test('theme selector offers a menu year-round with an automatic option',()=>{
  for(const theme of ['light','dark']){
    themeState={...themeState,theme,preference:'auto',halloweenAvailable:false}
    const html=renderToStaticMarkup(React.createElement(toggleModule.exports.ThemeToggle,{showCaption:true}))
    assert.match(html,/type="button"/);assert.match(html,/Обрати тему оформлення/)
    assert.match(html,/aria-haspopup="menu"/);assert.match(html,/aria-expanded="false"/)
    assert.doesNotMatch(html,/role="menu"/)
  }
})
test('the seasonal selector starts closed, is compact and supports keyboard focus without a full-screen modal',()=>{
  themeState={...themeState,theme:'halloween',halloweenAvailable:true}
  const html=renderToStaticMarkup(React.createElement(toggleModule.exports.ThemeToggle))
  assert.match(html,/aria-haspopup="menu"/);assert.match(html,/aria-expanded="false"/)
  assert.match(html,/Обрати тему оформлення/);assert.doesNotMatch(html,/role="menu"/)
  assert.match(toggleSource,/role="menuitemradio"/);assert.match(toggleSource,/aria-checked=/)
  for(const key of ['ArrowUp','ArrowDown','Home','End','Tab','Escape'])assert.ok(toggleSource.includes("'"+key+"'"))
  assert.match(toggleSource,/Math\.min\(304, window\.innerWidth - 16\)/)
  assert.match(toggleSource,/focus\(\{ preventScroll: true \}\)/)
  assert.match(toggleSource,/document\.addEventListener\('keydown', escape, true\)/)
  assert.match(toggleSource,/document\.removeEventListener\('pointerdown', outside, true\)/)
  assert.doesNotMatch(toggleSource,/aria-modal|body\.style\.overflow|inset-0/)
})

test('the greeting can reuse the real selector with a visible text trigger',()=>{
  themeState={...themeState,theme:'halloween',halloweenAvailable:true}
  const html=renderToStaticMarkup(React.createElement(toggleModule.exports.ThemeToggle,{textLabel:'Змінити тему'}))
  assert.match(html,/aria-label="Змінити тему"/);assert.match(html,/aria-haspopup="menu"/);assert.match(html,/>Змінити тему<\/span>/)
})

test('seasonal logo preserves the original brand mask, normal artwork and KNU label',async()=>{
  const logo=await read('src/components/XelayLogo.tsx'),hat=await read('src/components/halloween/HalloweenHat.tsx'),css=await read('src/styles/halloween-theme.css')
  assert.match(logo,/href="\/images\/xelay-header-logo.png"/);assert.match(logo,/mask=\{`url\(#\$\{maskId\}\)`\}/)
  for(const name of ['xelay-logo-standard-light','xelay-logo-standard-dark','xelay-logo-seasonal'])assert.ok(logo.includes(name))
  assert.match(logo,/<linearGradient/);assert.match(logo,/x="700" y="700" width="400" height="187" fill="#C6A9E5"/)
  assert.match(css,/\.xelay-logo-seasonal\s*\{\s*display: none/);assert.match(css,/:root\[data-theme='halloween'\] \.xelay-logo-seasonal/)
  assert.match(hat,/aria-hidden="true" focusable="false"/)
})

function hslToRgb(h,s,l){
  s/=100;l/=100
  const f=n=>{const k=(n+h/30)%12,a=s*Math.min(l,1-l);return l-a*Math.max(-1,Math.min(k-3,9-k,1))}
  return[f(0),f(8),f(4)]
}
const luminance=rgb=>rgb.map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((total,v,i)=>total+v*[.2126,.7152,.0722][i],0)
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}

test('seasonal reading text and actions meet normal text contrast and all palette overrides are scoped',async()=>{
  const css=await read('src/styles/halloween-theme.css')
  const palette=Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(\d+) (\d+)% (\d+)%;/g)].map(([,key,h,s,l])=>[key,hslToRgb(+h,+s,+l)]))
  for(const [fg,bg] of [['foreground','background'],['card-foreground','card'],['muted-foreground','card'],['muted-foreground','popover'],['primary-text','card'],['primary-foreground','primary'],['accent-foreground','accent']]){
    assert.ok(contrast(palette[fg],palette[bg])>=4.5,fg+' on '+bg+' must be readable')
  }
  assert.match(css,/:root\.dark\[data-theme='halloween'\]/)
  assert.doesNotMatch(css,/pointer-events:\s*none|position:\s*fixed|animation:\s*\w+|content:\s*['"]/)
  assert.match(css,/prefers-reduced-motion/)
})
