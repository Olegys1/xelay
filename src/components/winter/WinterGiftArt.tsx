import { useId } from 'react'
import { ArrowUpRight, Clock3, PauseCircle, Sparkles } from 'lucide-react'
import type { WinterReward } from '../../lib/winterCampaign'
import './winterGifts.css'

export function winterGiftTone(day: number) {
  return (['crimson', 'ivory', 'ice', 'champagne'] as const)[(Math.max(1, day) - 1) % 4]
}

export function WinterGiftBox({ day, opened = false, compact = false }: { day: number; opened?: boolean; compact?: boolean }) {
  const id = 'winter-gift-' + useId().replace(/:/g, '')
  const tone = (day - 1) % 3
  const paper = tone === 0 ? ['#ff8da8', '#f54d79', '#d92c61', '#a92557'] : tone === 1 ? ['#c4efff', '#83d5f6', '#54ade1', '#357da7'] : ['#fffbe5', '#ffedc4', '#f2cd93', '#be8d64']
  const ribbon = tone === 0 ? ['#fff8ce', '#ffe3a0', '#e8b86c', '#ae774e'] : tone === 1 ? ['#ffa6c9', '#f066a1', '#d53d7a', '#a02e68'] : ['#b8eaff', '#75c6ef', '#489dd1', '#367da9']
  return <span className={'winter-giftbox' + (compact ? ' winter-giftbox--compact' : '')} data-opened={opened} aria-hidden="true"><svg className="winter-cartoon-gift" viewBox="0 0 240 240" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id + '-paper'} x1="0" y1="0" x2=".7" y2="1"><stop stopColor={paper[0]}/><stop offset=".55" stopColor={paper[1]}/><stop offset="1" stopColor={paper[2]}/></linearGradient>
      <linearGradient id={id + '-ribbon'} x1="0" y1="0" x2=".8" y2="1"><stop stopColor={ribbon[0]}/><stop offset=".6" stopColor={ribbon[1]}/><stop offset="1" stopColor={ribbon[2]}/></linearGradient>
    </defs>
    <ellipse className="winter-box-shadow" cx="126" cy="216" rx="85" ry="12" fill="#315573" opacity=".13"/>
    <g className="winter-box-base" strokeLinejoin="round" strokeLinecap="round">
      <path d="M177 105 203 96Q216 99 215 114L213 181Q212 196 195 202L177 211Z" fill={paper[2]} stroke={paper[3]} strokeWidth="3"/>
      <path d="M55 101 176 108Q195 109 195 128L194 191Q193 213 172 212L60 207Q40 206 39 186L37 123Q36 101 55 101Z" fill={'url(#' + id + '-paper)'} stroke={paper[3]} strokeWidth="3.2"/>
      <path d="M39 148 195 155V180L40 174Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="2"/>
      <path d="M195 155 214 144V168L194 180Z" fill={ribbon[2]} stroke={ribbon[3]} strokeWidth="2"/>
      <path d="M102 105 131 107 130 210 103 209Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="2.2"/>
      <path d="M50 130V140M49 181Q50 195 65 196M111 122V146" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="5"/>
      <path d="M43 120 193 127" stroke={paper[3]} strokeOpacity=".23" strokeWidth="8"/>
      <path d="M133 111Q158 127 159 153" fill="none" stroke={ribbon[3]} strokeWidth="2"/>
      <g className="winter-box-tag" transform="rotate(8 158 171)"><rect x="135" y="150" width="45" height="46" rx="10" fill="#333253" opacity=".15" transform="translate(1 3)"/><rect x="135" y="150" width="45" height="46" rx="10" fill="#fff9df" stroke="#d7a876" strokeWidth="2"/><circle cx="157" cy="156" r="2" fill="#d7a876"/><text x="157" y="183" textAnchor="middle" fill="#a82a57" fontSize="24" fontWeight="700" letterSpacing="-1.2">{String(day).padStart(2, '0')}</text></g>
    </g>
    <g className="winter-box-lid" strokeLinejoin="round" strokeLinecap="round">
      <path d="M38 88 61 77Q66 75 75 76L205 86Q220 87 219 101L217 109 197 124 41 115Z" fill={paper[0]} stroke={paper[3]} strokeWidth="3.2"/>
      <path d="M43 88 185 96Q201 97 201 112V117Q200 130 185 129L42 119Q29 118 29 106V101Q29 87 43 88Z" fill={'url(#' + id + '-paper)'} stroke={paper[3]} strokeWidth="3.2"/>
      <path d="M201 110 218 99V110L200 124Z" fill={paper[2]}/>
      <path d="M104 92 133 94 132 126 103 124Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="2"/>
      <path d="M45 98 87 101" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="5"/>
      <g className="winter-box-bow">
        <path d="M119 79Q100 91 92 123Q91 128 97 126L108 122 118 129Q122 130 122 123Q120 104 137 86Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="2.6"/>
        <path d="M132 83Q158 91 168 119Q169 124 163 122L152 119 145 129Q140 132 140 125Q138 106 121 88Z" fill={ribbon[1]} stroke={ribbon[3]} strokeWidth="2.6"/>
        <path d="M122 80C106 36 68 24 54 47C38 75 76 94 117 90Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="3.2"/>
        <path d="M118 83C99 78 71 74 68 61C66 52 79 53 91 62" fill="none" stroke={ribbon[3]} strokeOpacity=".5" strokeWidth="3.8"/>
        <path d="M131 81C149 30 187 23 196 49C206 78 171 95 136 90Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="3.2"/>
        <path d="M137 83C157 78 182 71 183 59C183 51 172 54 162 62" fill="none" stroke={ribbon[3]} strokeOpacity=".5" strokeWidth="3.8"/>
        <path d="M61 53Q64 43 75 44M181 44Q189 47 190 56" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="5"/>
        <path d="M120 73Q128 69 137 75Q142 78 140 87L139 94Q135 101 123 97L116 94Q111 89 114 81Z" fill={'url(#' + id + '-ribbon)'} stroke={ribbon[3]} strokeWidth="3"/>
        <path d="M121 80Q126 76 132 79" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="3.4"/>
      </g>
    </g>
  </svg>{compact && <span className="winter-gift-number">{String(day).padStart(2, '0')}</span>}</span>
}

export function winterRewardCategory(reward: WinterReward) {
  return reward.kind === 'credits' ? 'credits' : ['subscription_coupon', 'friend_coupon', 'credit_bonus'].includes(reward.kind) ? 'offer' : 'days'
}
export function winterRewardLabel(reward: WinterReward) {
  return reward.kind === 'credits' ? 'Кредити ШІ' : reward.kind === 'pause' ? 'Пауза' : reward.kind === 'upgrade' ? 'День Макса' : reward.kind === 'extension' ? 'Дні підписки' : reward.kind === 'friend_coupon' ? 'Для друга' : 'Пропозиція'
}
/** Decorative summary. Actual eligibility and amounts come from the server controls below. */
export function WinterBenefitArt({ reward }: { reward: WinterReward }) {
  const category = winterRewardCategory(reward)
  return <div className={'wg-product wg-product--' + category} aria-hidden="true">
    <span className="wg-product-floor"/>
    {category === 'credits' ? <><div className="wg-credit-back"/><div className="wg-credit-glass"><span className="wg-product-brand">Xelay<Sparkles size={16}/></span><span className="wg-credit-value">{reward.amount}</span><span className="wg-product-unit">бонусних кредитів ШІ</span><span className="wg-credit-foot"><i/>ЗИМА У XELAY<span>26 / 27</span></span><span className="wg-credit-shine"/></div></> : category === 'offer' ? <><div className="wg-pass-back"/><div className="wg-offer-pass"><div className="wg-offer-main"><span className="wg-product-brand">Xelay<span>ТВІЙ ПОДАРУНОК</span></span><span className="wg-offer-value">{reward.kind === 'credit_bonus' ? '+' : '−'}{reward.amount}%</span><span className="wg-product-unit">{reward.kind === 'credit_bonus' ? 'до пакета кредитів' : reward.kind === 'friend_coupon' ? 'для друга' : 'на підписку'}</span><span className="wg-offer-rule">Умови подарунка нижче.</span></div><div className="wg-offer-stub"><ArrowUpRight size={26}/><span>БІЛЬШЕ<br/>МОЖЛИВОСТЕЙ</span><i/></div></div></> : <><div className="wg-pack-sheet wg-pack-sheet--back"/><div className="wg-pack-sheet wg-pack-sheet--middle"/><div className="wg-content-pack"><span className="wg-product-brand">Xelay{reward.kind === 'pause' ? <PauseCircle size={18}/> : reward.kind === 'upgrade' ? <Sparkles size={18}/> : <Clock3 size={18}/>}</span><span className="wg-pack-label">ТВІЙ ЗИМОВИЙ БОНУС</span><span className="wg-days-value">{reward.amount}<small>{reward.amount === 1 ? 'день' : 'дні'}</small></span><strong>{reward.kind === 'pause' ? 'Пауза підписки' : reward.kind === 'upgrade' ? 'Можливості Макса' : 'До твоєї підписки'}</strong><span className="wg-pack-bottom">ВИКОРИСТАЙ ДО 28 ЛЮТОГО<ArrowUpRight size={18}/></span></div></>}
  </div>
}
