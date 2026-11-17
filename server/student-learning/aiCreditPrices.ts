/** Server-owned credit catalogue. 1,000 credits cover 1 USD of accounted model usage. */
export const AI_CREDIT_PACKAGES = Object.freeze([
  Object.freeze({id:'credits_1000',credits:1000,priceUah:99,micros:1000000}),
  Object.freeze({id:'credits_3000',credits:3000,priceUah:249,micros:3000000}),
  Object.freeze({id:'credits_10000',credits:10000,priceUah:749,micros:10000000}),
])
export const AI_CREDIT_REFERENCE=/^xtop_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function aiCreditPackage(id:unknown){return AI_CREDIT_PACKAGES.find(item=>item.id===id)??null}
export function publicAiCreditPackages(){return AI_CREDIT_PACKAGES.map(({id,credits,priceUah})=>({id,credits,priceUah}))}
export function validAiCreditOrder(order:any){
 const pack=aiCreditPackage(order?.package_id)
 return !!pack&&order.product==='ai_credits'&&Number(order.amount)===pack.priceUah&&Number(order.credit_micros)===pack.micros&&order.currency==='UAH'&&order.group_id===null
}
