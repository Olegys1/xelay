export {AI_CREDIT_TERMS_VERSION} from './aiCreditTerms'
export type AiCreditPackageId='credits_1000'|'credits_3000'|'credits_10000'
export type AiCreditPackage={id:AiCreditPackageId;credits:number;priceUah:number}
export type AiCreditWallet={balanceCredits:number;reservedCredits:number;debtCredits:number}
export type AiCreditOrder={id:string;order_reference:string;package_id:AiCreditPackageId;amount:number;currency:'UAH';mode:'live'|'test';status:'pending'|'approved'|'declined'|'expired'|'refunded'|'voided';created_at:string;approved_at:string|null}
export type AiCreditStatus={checkoutAvailable:boolean;mode:'live'|'test'|'disabled';eligible:boolean;packages:AiCreditPackage[];wallet:AiCreditWallet|null;orders:AiCreditOrder[]}
export type AiCreditCheckout={mode:'live'|'test';orderReference:string;checkout:{action:'https://secure.wayforpay.com/pay';fields:Record<string,string|number|string[]|number[]>}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const fields=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(v,key))
const number=(v:unknown,max=1000000000):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max
const date=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))
const invalid=():never=>{throw Error('Invalid AI credit response')}
export function validAiCreditPackageId(v:unknown):v is AiCreditPackageId{return ['credits_1000','credits_3000','credits_10000'].includes(String(v))}
export function validAiCreditReference(v:unknown):v is string{return typeof v==='string'&&/^xtop_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)}
export function parseAiCreditWallet(v:unknown):AiCreditWallet{
 if(!object(v)||!fields(v,['balanceCredits','reservedCredits','debtCredits'])||!Object.values(v).every(item=>number(item)))return invalid()
 return v as AiCreditWallet
}
export function parseAiCreditStatus(v:unknown):AiCreditStatus{
 if(!object(v)||!fields(v,['checkoutAvailable','mode','eligible','packages','wallet','orders'])||typeof v.checkoutAvailable!=='boolean'||typeof v.eligible!=='boolean'||!['live','test','disabled'].includes(String(v.mode))||!Array.isArray(v.packages)||v.packages.length!==3||!Array.isArray(v.orders)||v.orders.length>20)return invalid()
 const seen=new Set<string>(),packages:AiCreditPackage[]=[]
 for(const p of v.packages){if(!object(p)||!fields(p,['id','credits','priceUah'])||!validAiCreditPackageId(p.id)||seen.has(p.id)||p.credits!==Number(p.id.slice(8))||!number(p.priceUah,100000)||p.priceUah<=0||Math.round(p.priceUah*100)!==p.priceUah*100)return invalid();seen.add(p.id);packages.push(p as AiCreditPackage)}
 const wallet=v.wallet===null?null:parseAiCreditWallet(v.wallet)
 if(v.eligible&&wallet===null||v.mode==='disabled'&&v.checkoutAvailable)return invalid()
 const orders:AiCreditOrder[]=[]
 for(const o of v.orders){if(!object(o)||!fields(o,['id','order_reference','package_id','amount','currency','mode','status','created_at','approved_at'])||typeof o.id!=='string'||!/^[a-f0-9-]{36}$/.test(o.id)||!validAiCreditReference(o.order_reference)||!validAiCreditPackageId(o.package_id)||!number(o.amount,100000)||o.amount<=0||o.currency!=='UAH'||!['live','test'].includes(String(o.mode))||!['pending','approved','declined','expired','refunded','voided'].includes(String(o.status))||!date(o.created_at)||!(o.approved_at===null||date(o.approved_at)))return invalid();orders.push(o as AiCreditOrder)}
 return {checkoutAvailable:v.checkoutAvailable,mode:v.mode as AiCreditStatus['mode'],eligible:v.eligible,packages,wallet,orders}
}
export function parseAiCreditCheckout(v:unknown):AiCreditCheckout{
 if(!object(v)||!fields(v,['mode','orderReference','checkout'])||!['live','test'].includes(String(v.mode))||!validAiCreditReference(v.orderReference)||!object(v.checkout)||!fields(v.checkout,['action','fields'])||v.checkout.action!=='https://secure.wayforpay.com/pay'||!object(v.checkout.fields))return invalid()
 const f=v.checkout.fields
 if(Object.keys(f).length>40||Object.entries(f).some(([k,item])=>!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(k)||!(Array.isArray(item)?item.length<=8&&item.every(x=>typeof x==='number'&&Number.isFinite(x)||typeof x==='string'&&x.length<=2000):typeof item==='number'&&Number.isFinite(item)||typeof item==='string'&&item.length<=2000))||f.orderReference!==v.orderReference||f.currency!=='UAH'||!number(f.amount,100000)||f.amount<=0||f.regularMode!=='none')return invalid()
 return v as AiCreditCheckout
}
export function parseAiCreditReconcile(v:unknown):{checked:boolean;retryAfter:number}{
 if(!object(v)||!fields(v,['checked','retryAfter'])||typeof v.checked!=='boolean'||!Number.isInteger(v.retryAfter)||!number(v.retryAfter,3600)||v.retryAfter<1)return invalid()
 return v as {checked:boolean;retryAfter:number}
}
