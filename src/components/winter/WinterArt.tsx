import { useEffect, useId, useRef, useState } from 'react'
import { XelayMini } from '../XelayMini'
import type { WinterSymbol } from '../../lib/winterCampaign'
import { useWinterEffects } from './WinterDecorations'

export function WinterGlyph({ symbol, className = '' }: { symbol: WinterSymbol; className?: string }) {
  return <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={`winter-glyph ${className}`} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {symbol === 'star' && <><path d="m32 8 6.6 15.6L56 26l-13 11.5L46.8 55 32 46l-14.8 9L21 37.5 8 26l17.4-2.4Z" fill="currentColor" fillOpacity=".12"/><path d="m32 19 3 10 10 2-9 6 1 9-5-7-7 3 4-9-5-4 8-1Z" strokeWidth="1"/></>}
    {symbol === 'tree' && <><path d="m32 7-13 18h7L15 39h10L13 52h38L39 39h10L38 25h7Z" fill="currentColor" fillOpacity=".12"/><path d="M32 52v7M25 32l14 4M24 44l15 4"/><circle cx="31" cy="23" r="1.7" fill="currentColor"/><circle cx="34" cy="42" r="1.7" fill="currentColor"/></>}
    {symbol === 'snowflake' && <><path d="M32 6v52M9.5 19l45 26M9.5 45l45-26M25 10l7 7 7-7M25 54l7-7 7 7M10 27l10-3-2-10M54 37l-10 3 2 10M18 50l2-10-10-3M46 14l-2 10 10 3"/><circle cx="32" cy="32" r="6" fill="currentColor" fillOpacity=".15"/></>}
    {symbol === 'bell' && <><path d="M16 43c5-5 5-12 5-19a11 11 0 0 1 22 0c0 7 0 14 5 19l3 5H13Z" fill="currentColor" fillOpacity=".12"/><path d="M28 9a4 4 0 0 1 8 0M27 54a6 6 0 0 0 10 0M25 24v7"/><path d="m45 10 5-5M50 20h6"/></>}
    {symbol === 'mug' && <><path d="M13 25h33v22a9 9 0 0 1-9 9H22a9 9 0 0 1-9-9Z" fill="currentColor" fillOpacity=".12"/><path d="M46 29h5a8 8 0 0 1 0 16h-5M20 18c-6-5 6-7 0-12M31 18c-6-5 6-7 0-12M41 18c-6-5 6-7 0-12"/><path d="m29 34-2 4-5 1 4 4-1 5 4-3 5 3-1-5 4-4-5-1Z"/></>}
    {symbol === 'mitten' && <><path d="M21 46V18a10 10 0 0 1 20 0v12l5-5a5 5 0 0 1 8 6L43 48Z" fill="currentColor" fillOpacity=".12"/><path d="M19 47h25v10H19ZM27 22v6M26 50v4M32 50v4M38 50v4"/></>}
    {symbol === 'gift' && <><path d="M12 28h40v29H12ZM8 20h48v11H8Z" fill="currentColor" fillOpacity=".12"/><path d="M29 20h6v37M32 20C13 21 12 7 21 7c7 0 11 13 11 13Zm0 0C51 21 52 7 43 7c-7 0-11 13-11 13Z"/></>}
    {symbol === 'snowman' && <><ellipse cx="32" cy="46" rx="18" ry="13" fill="currentColor" fillOpacity=".1"/><circle cx="32" cy="23" r="12" fill="currentColor" fillOpacity=".1"/><path d="M18 13h28M24 13V5h16v8M20 34l24 3M41 37l3 12M14 40l-7-8M50 40l7-8M31 23l10 2-10 2"/><circle cx="28" cy="21" r="1" fill="currentColor"/><circle cx="34" cy="21" r="1" fill="currentColor"/><circle cx="32" cy="44" r="1.2" fill="currentColor"/><circle cx="32" cy="51" r="1.2" fill="currentColor"/></>}
    {symbol === 'moon' && <><path d="M45 10A23 23 0 1 0 54 45 25 25 0 0 1 45 10Z" fill="currentColor" fillOpacity=".12"/><path d="m50 17 2 5 5 2-5 2-2 5-2-5-5-2 5-2ZM25 7v7M22 10h6"/></>}
    {symbol === 'heart' && <><path d="M32 53 11 32C-1 18 20 4 32 20 44 4 65 18 53 32Z" fill="currentColor" fillOpacity=".12"/><path d="m19 25 5-3M40 15l3-6M48 20l6-2"/></>}
  </svg>
}

export function WinterMini({ size = 100, celebrating = false, animated = true }: { size?: number; celebrating?: boolean; animated?: boolean }) {
  return <span className="winter-mini" data-animated={animated} data-celebrating={celebrating} style={{ width: size }} aria-hidden="true">
    <XelayMini size={size} animated={animated} celebrating={celebrating}/>
    <svg className="winter-mini-hat" viewBox="0 0 64 44" focusable="false"><path d="M9 35C11 17 22 5 39 7c10 0 16 8 17 17l-11 3c-2-8-8-10-13-9l9 17Z" fill="#9c2448"/><path d="M12 31c11-4 22-3 31 2l-1 8C29 37 20 37 9 39Z" fill="#fff4dc"/><circle cx="55" cy="26" r="7" fill="#fff4dc"/><path d="M18 27c3-8 7-12 14-15" fill="none" stroke="#d2758f" strokeWidth="2" strokeLinecap="round"/></svg>
  </span>
}

export function WinterScene({ collected = 0, celebrating = false, compact = false }: { collected?: number; celebrating?: boolean; compact?: boolean }) {
  const unique = useId().replace(/:/g, '')
  const scene = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const { enabled } = useWinterEffects()
  useEffect(() => {
    let inView = typeof IntersectionObserver === 'undefined'
    const update = () => setVisible(inView && !document.hidden)
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => { inView = Boolean(entry?.isIntersecting); update() })
    if (scene.current) observer?.observe(scene.current)
    document.addEventListener('visibilitychange', update); update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update) }
  }, [])
  const lights = Math.min(15, Math.max(0, collected))
  return <div ref={scene} className={`winter-scene${compact ? ' winter-scene--compact' : ''}`} data-animate={visible && enabled} aria-label={`Зимове містечко: зібрано ${collected} з 31 подарунка`} role="img">
    <svg viewBox="0 0 560 390" aria-hidden="true" focusable="false">
      <defs><radialGradient id={`${unique}-glow`}><stop offset="0" stopColor="#fbd5a0" stopOpacity=".5"/><stop offset="1" stopColor="#fbd5a0" stopOpacity="0"/></radialGradient><linearGradient id={`${unique}-tree`} x1="0" x2="1" y1="0" y2="1"><stop stopColor="#416d60"/><stop offset="1" stopColor="#1d4037"/></linearGradient><linearGradient id={`${unique}-roof`} x1="0" x2="1"><stop stopColor="#713340"/><stop offset="1" stopColor="#9d4d57"/></linearGradient></defs>
      <ellipse cx="295" cy="254" rx="244" ry="129" fill={`url(#${unique}-glow)`}/>
      <g className="winter-scene-stars" fill="currentColor" opacity=".55"><path d="m108 75 2 7 7 2-7 2-2 7-2-7-7-2 7-2Zm305-21 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm49 64 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z"/><circle cx="184" cy="53" r="2"/><circle cx="303" cy="51" r="1.5"/><circle cx="380" cy="101" r="1.7"/><circle cx="138" cy="147" r="1.5"/></g>
      <path d="M57 319c48-33 106-33 159-14 95-55 173-50 289 14-52 45-372 57-448 0Z" className="winter-scene-snow"/>
      <path d="M358 265c-12 17-26 43-31 72" stroke="#c6b9a3" opacity=".35" strokeWidth="14" fill="none"/>
      <g className="winter-scene-house"><path d="M302 186h143v118H302Z" fill="#d7b794"/><path d="M310 194h127v110H310Z" fill="#ccaa88"/><path d="m282 193 89-80 91 80Z" fill={`url(#${unique}-roof)`}/><path d="m279 193 92-85 94 85-11 3-83-72-82 72Z" fill="#f6f0e5"/><path d="M410 125v-25h20v44" fill="#b48b75"/><path d="M405 101h29v8h-29Z" fill="#f5efe3"/>
      <path d="M415 87c-16-14 11-20 0-35" className="winter-scene-smoke"/><path d="M424 84c-13-14 11-20 0-35" className="winter-scene-smoke winter-scene-smoke--late"/>
      <rect x="323" y="215" width="37" height="40" rx="2" fill="#614a48"/><rect x="327" y="219" width="29" height="32" fill="#f8d095" className="winter-scene-window"/><path d="M341.5 219v32M327 235h29" stroke="#9f7555" strokeWidth="3"/>
      <rect x="389" y="215" width="37" height="40" rx="2" fill="#614a48"/><rect x="393" y="219" width="29" height="32" fill="#f8d095" className="winter-scene-window"/><path d="M407.5 219v32M393 235h29" stroke="#9f7555" strokeWidth="3"/>
      <path d="M361 305v-43a14 14 0 0 1 28 0v43Z" fill="#694948"/><circle cx="381" cy="282" r="2" fill="#e7c790"/><path d="M303 303h142" stroke="#f4eee2" strokeWidth="8" strokeLinecap="round"/>
      <path d="M305 199c44 16 88 16 133 0" fill="none" stroke="#46634f" strokeWidth="2"/>{[0,1,2,3,4,5,6,7].map(i=><circle key={i} cx={310+i*17} cy={201+Math.sin(i/7*Math.PI)*9} r="3" fill={i%2?'#f5d49d':'#a9445b'} className="winter-scene-lamp" style={{animationDelay:`${i*.3}s`}}/>)}</g>
      <g className="winter-scene-fir"><path d="M205 318v-38" stroke="#775849" strokeWidth="12"/><path d="m205 81-47 72h24l-45 63h30l-49 72h174l-49-72h30l-45-63h24Z" fill={`url(#${unique}-tree)`}/><path d="m205 80-47 72 18-4 29-43 29 43 18 4Zm-38 94-30 42 26-8m82-34 28 42-25-8M148 245l-30 43 34-10m111-33 29 43-33-10" fill="#e5e9df" opacity=".95"/><path d="M165 178c21 12 48 14 81 10M149 228c31 17 76 23 113 14" stroke="#bda06c" strokeWidth="2" fill="none"/>
      {Array.from({length:15},(_,i)=>{const tier=Math.floor(i/5),x=164+(i%5)*18+(tier===0?13:0),y=160+tier*48+Math.sin(i*1.7)*9;return <circle key={i} cx={x} cy={y} r={i<lights?4.2:2} fill={i<lights?(i%3===0?'#f6d08c':i%3===1?'#bd576a':'#ecdfc1'):'#73907b'} opacity={i<lights?1:.35} className={i<lights?'winter-scene-lamp':''} style={{animationDelay:`${i*.24}s`}}/>})}
      <path d="m205 65 4 9 10 1-7 7 2 10-9-5-9 5 2-10-7-7 10-1Z" fill={collected>=7?'#f4d198':'#bda57e'} className="winter-scene-star"/></g>
      <g transform="translate(92 287)"><ellipse cx="0" cy="22" rx="21" ry="19" fill="#f1eee6"/><circle cy="-5" r="15" fill="#faf4e9"/><path d="m-17 7 32 3-1 6-31-3Z" fill="#a24e64"/><path d="M8 12v18l8 2-3-21" fill="#a24e64"/><circle cx="-5" cy="-8" r="1.5" fill="#5c4b4e"/><circle cx="4" cy="-8" r="1.5" fill="#5c4b4e"/><path d="m1-4 14 3-14 2" fill="#c89055"/><circle cx="-1" cy="23" r="2" fill="#6d6260"/><circle cx="-1" cy="32" r="2" fill="#6d6260"/><path d="M-20 20-33 11m53 9 12-9" stroke="#856b54" strokeWidth="3" strokeLinecap="round"/></g>
      <g transform="translate(247 308)"><rect width="30" height="23" rx="2" fill="#9b4358"/><rect x="12" width="5" height="23" fill="#e5c28f"/><rect x="-2" y="-4" width="34" height="7" rx="2" fill="#b05e70"/><path d="M14-4C0-6 5-16 14-4Zm1 0c14-2 9-12 0 0Z" fill="none" stroke="#e5c28f" strokeWidth="2"/></g>
      <path d="M71 337c111 25 290 22 402-7" stroke="currentColor" opacity=".12" strokeLinecap="round" fill="none"/>
    </svg>
    {!compact && <div className="winter-scene-mini"><WinterMini size={86} celebrating={celebrating}/></div>}
  </div>
}
