import { XelayMini } from '../XelayMini'
import type { WinterSymbol } from '../../lib/winterCampaign'
import { WinterHolidayArt } from './WinterHolidayArt'

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
    <img className="winter-mini-hat" src="/images/winter/santa-hat-v1-256.webp" width="256" height="171" alt="" decoding="async" draggable={false}/>
  </span>
}

export function WinterScene({ collected = 0, celebrating = false, compact = false }: { collected?: number; celebrating?: boolean; compact?: boolean }) {
  return <div className={`winter-scene winter-scene--cinematic${compact ? ' winter-scene--compact' : ''}`} data-celebrating={celebrating} aria-label={`Зимова сцена: зібрано ${collected} з 31 подарунка`} role="img">
    <WinterHolidayArt/>
  </div>
}
