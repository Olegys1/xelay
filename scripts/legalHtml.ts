import { getLegalPage, legalMerchant, type LegalPageKind } from '../src/lib/legal'

const legalLinks: Array<{ kind: LegalPageKind; label: string }> = [
  { kind: 'terms', label: 'Правила та умови' },
  { kind: 'refund-policy', label: 'Повернення коштів' },
  { kind: 'contacts', label: 'Контакти та реквізити' },
]

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!))

const logo = `<svg viewBox="64 122 1655 680" aria-hidden="true" focusable="false"><defs><mask id="brand-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1774" height="887" style="mask-type:alpha"><image href="/images/xelay-header-logo.png" width="1774" height="887"/></mask></defs><g mask="url(#brand-mask)"><rect width="1774" height="887" fill="var(--ink)"/><rect x="700" y="700" width="400" height="187" fill="var(--brand)"/></g></svg>`

function renderFooter(): string {
  const footerNav = legalLinks.map((link) => `<a href="/${link.kind}">${escapeHtml(link.kind === 'terms' ? 'Публічна оферта та умови' : link.label)}</a>`).join('')
  const sameAddress = legalMerchant.registrationAddress === legalMerchant.actualAddress
  const seller = [
    legalMerchant.name && `<p class="footer-seller-name">${escapeHtml(legalMerchant.name)}</p>`,
    legalMerchant.taxId && `<p>РНОКПП (ІПН): ${escapeHtml(legalMerchant.taxId)}</p>`,
    legalMerchant.registrationAddress && `<p>${sameAddress ? 'Юридична та фактична адреса' : 'Юридична адреса'}: ${escapeHtml(legalMerchant.registrationAddress)}</p>`,
    !sameAddress && legalMerchant.actualAddress && `<p>Фактична адреса: ${escapeHtml(legalMerchant.actualAddress)}</p>`,
  ].filter(Boolean).join('')
  const support = [
    legalMerchant.email && `<p><a href="mailto:${escapeHtml(legalMerchant.email)}">${escapeHtml(legalMerchant.email)}</a></p>`,
    legalMerchant.phone && `<p><a href="tel:${escapeHtml(legalMerchant.phone.replace(/[^+\d]/g, ''))}">${escapeHtml(legalMerchant.phone)}</a></p>`,
  ].filter(Boolean).join('')
  return `<footer class="photo-footer"><picture aria-hidden="true"><source type="image/webp" srcset="/images/knu-footer-480.webp 480w, /images/knu-footer-768.webp 768w, /images/knu-footer-1280.webp 1280w" sizes="100vw"><img src="/images/knu-footer.jpg" alt="" width="1280" height="1051" loading="lazy" decoding="async"></picture><div class="footer-inner"><div class="footer-brand-row"><a class="footer-brand" href="/" aria-label="Xelay — на головну">${logo.replaceAll('brand-mask', 'footer-brand-mask')}</a><p class="footer-caption">Спілкування, взаємодопомога та навчання в університетській спільноті.</p></div><div class="footer-grid"><section class="footer-column" aria-labelledby="footer-rules"><h2 id="footer-rules" class="footer-title">Правила та оплата</h2><nav aria-label="Правила платформи та контакти">${footerNav}</nav><p class="footer-note">Оплата карткою через WayForPay. Послуги надаються онлайн.</p></section><section class="footer-column" aria-labelledby="footer-support"><h2 id="footer-support" class="footer-title">Зв’язок та підтримка</h2><address>${support}</address><p class="footer-note">Питання щодо оплати, доступу до платформи та повернення коштів.</p></section><section class="footer-column footer-seller" aria-labelledby="footer-merchant"><h2 id="footer-merchant" class="footer-title">Продавець послуг</h2><div class="footer-details">${seller}</div></section></div><p class="footer-copyright">© ${new Date().getFullYear()} Xelay · Університетська спільнота</p></div></footer>`
}

const footerCss = `
.photo-footer{position:relative;isolation:isolate;overflow:hidden;background:#181418;color:#fff}
.photo-footer picture{position:absolute;inset:0;z-index:-2;pointer-events:none}.photo-footer picture img{display:block;width:100%;height:100%;object-fit:cover;object-position:50% 45%}
.photo-footer:after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(180deg,rgba(24,20,24,.18),rgba(24,20,24,.62) 60%,rgba(24,20,24,.88))}
.photo-footer .footer-inner{display:block;max-width:1152px;padding:36px 24px 28px}.footer-brand-row{display:flex;min-height:104px;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:24px}
.footer-brand{display:inline-flex;flex-shrink:0;align-items:center;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 24px #0003}.footer-brand svg{display:block;width:136px;height:56px}
.photo-footer .footer-caption{max-width:320px;margin:0;border-radius:12px;background:rgba(24,20,24,.85);padding:10px 14px;font-size:14px;line-height:24px;color:#fff}
.footer-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;padding:24px;border:1px solid #ffffff26;border-radius:16px;background:rgba(24,20,24,.95);box-shadow:0 16px 32px #0003}
.photo-footer .footer-column{min-width:0;padding:0;border:0}.photo-footer .footer-title{margin:0 0 16px;font-size:12px;font-weight:600;line-height:16px;letter-spacing:.1em;text-transform:uppercase;color:#ffffffa6}
.photo-footer nav{flex-direction:column;align-items:flex-start;gap:12px;margin:0}.photo-footer a:not(.footer-brand){font-size:14px;line-height:24px;color:#ffffffd9;text-decoration:none}.photo-footer a:hover{text-decoration:underline;color:#fff}.photo-footer a:focus-visible{outline-color:#fff}
.photo-footer address{font-style:normal}.photo-footer address p{margin:0 0 8px}.photo-footer .footer-note{margin:16px 0 0;font-size:12px;line-height:20px;color:#ffffffb3}
.photo-footer .footer-details p{margin:0 0 8px;font-size:12px;line-height:20px;color:#ffffffcc}.photo-footer .footer-details .footer-seller-name{font-size:14px;font-weight:500;line-height:24px;color:#fff}
.photo-footer .footer-copyright{margin:20px 0 0;font-size:12px;line-height:20px;color:#ffffffa6}
@media(min-width:768px){.footer-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.footer-seller{grid-column:span 2}}
@media(min-width:1024px){.photo-footer picture{display:none}.footer-grid{grid-template-columns:minmax(0,.9fr) minmax(0,1fr) minmax(0,1.45fr)}.footer-seller{grid-column:auto}}
@media(max-width:639px){.photo-footer picture{bottom:auto;height:290px}.photo-footer picture img{object-position:50% 40%}.photo-footer:after{background:linear-gradient(180deg,rgba(24,20,24,.12) 0%,rgba(24,20,24,.35) 120px,#181418 290px)}.photo-footer .footer-inner{padding:28px 16px 24px}.footer-brand-row{min-height:132px;flex-direction:column;align-items:flex-start;justify-content:flex-end}.footer-grid{padding:20px}}
`

// Generate complete public HTML from the same content used by React. Payment
// reviewers can read every term and contact detail without JavaScript or auth.
export function renderLegalHtml(kind: LegalPageKind): string {
  const page = getLegalPage(kind)
  const nav = legalLinks.map((link) => `<a href="/${link.kind}"${link.kind === kind ? ' aria-current="page"' : ''}>${escapeHtml(link.label)}</a>`).join('')
  const sections = page.sections.map((section) => `<section><h2>${escapeHtml(section.title)}</h2>${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}${section.items?.length ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}</section>`).join('')
  const contacts = kind === 'contacts' && (legalMerchant.email || legalMerchant.phone)
    ? `<section><h2>Зв’язатися з нами</h2>${legalMerchant.email ? `<p><a href="mailto:${escapeHtml(legalMerchant.email)}">${escapeHtml(legalMerchant.email)}</a></p>` : ''}${legalMerchant.phone ? `<p><a href="tel:${escapeHtml(legalMerchant.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(legalMerchant.phone)}</a></p>` : ''}</section>` : ''
  return `<!doctype html>
<html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(page.title)} · Xelay</title><meta name="description" content="${escapeHtml(page.description)}"><meta name="robots" content="index,follow"><link rel="canonical" href="https://www.xelay.ink/${kind}"><meta name="color-scheme" content="light dark"><link rel="icon" type="image/png" href="/favicon-xelay.png"><link rel="apple-touch-icon" href="/favicon-xelay.png">
<style>
:root{--bg:#faf9fa;--card:#fff;--ink:#242126;--muted:#65606a;--line:#e4dfe5;--brand:#89052c;--tint:#f5edf0;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.75}a{color:var(--brand);text-underline-offset:4px;overflow-wrap:anywhere}a:hover{text-decoration-thickness:2px}a:focus-visible{outline:3px solid var(--brand);outline-offset:4px;border-radius:3px}.topbar{border-bottom:1px solid var(--line);background:var(--card)}.topbar-inner,.footer-inner{max-width:1120px;margin:auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap}.brand{display:inline-flex;width:115px}.brand svg{width:100%;height:48px}.topbar a{text-decoration:none}.account{font-size:14px}.skip{position:absolute;left:20px;top:-100px;padding:10px;background:var(--card);z-index:5}.skip:focus{top:10px}main{max-width:960px;margin:0 auto;padding:32px 24px 56px}.back{font-size:14px}.intro{padding:24px 0 28px}h1{font-size:clamp(27px,4vw,40px);line-height:1.2;letter-spacing:-.035em;margin:12px 0 20px}.description{max-width:720px;color:var(--muted);font-size:17px}.updated{font-size:12px;color:var(--muted)}nav{display:flex;flex-wrap:wrap;gap:12px 24px;margin-top:20px;font-size:14px}nav a[aria-current]{font-weight:700;color:var(--ink)}article{padding:12px 32px;background:var(--card);border:1px solid var(--line);border-radius:20px}section{padding:25px 0;border-bottom:1px solid var(--line)}section:last-child{border:0}h2{font-size:20px;line-height:1.4;margin:0 0 16px}p,li{overflow-wrap:anywhere}section p,section li{color:var(--muted);font-size:15px;white-space:pre-line}section p{margin:12px 0}ul{padding-left:22px}li{padding-left:3px;margin:9px 0}li::marker{color:var(--brand)}.notice{padding:14px 20px;background:var(--tint);border:1px solid var(--line);border-radius:12px;font-size:14px}footer{border-top:1px solid var(--line);background:var(--card)}footer p{font-size:12px;color:var(--muted)}footer nav{margin:0}.copyright{margin:0}.merchant{margin:4px 0 0}
@media(prefers-color-scheme:dark){:root{--bg:#242229;--card:#2e2c34;--ink:#f4f0f4;--muted:#c5bdc9;--line:#45414b;--brand:#f0a2bc;--tint:#382c35}}
@media(max-width:560px){main{padding:24px 16px 36px}article{padding:0 20px}.topbar-inner,.footer-inner{padding:16px 20px;gap:16px}.description{font-size:15px}h2{font-size:18px}nav{gap:10px 18px}.footer-inner{align-items:flex-start;flex-direction:column}}
${footerCss}
</style></head><body><a class="skip" href="#content">Перейти до змісту</a><header class="topbar"><div class="topbar-inner"><a class="brand" href="/" aria-label="Xelay — на головну">${logo}</a><a class="account" href="/subscription">Підписка та тарифи →</a></div></header><main id="content"><a class="back" href="/">← На головну</a><div class="intro"><h1>${escapeHtml(page.title)}</h1><p class="description">${escapeHtml(page.description)}</p><p class="updated">Оновлено: ${escapeHtml(page.updatedAt)}</p><nav aria-label="Правила платформи та контакти">${nav}</nav></div>${legalMerchant.ready ? '' : '<p class="notice">Відомості продавця уточнюються. Прийом оплат ще недоступний.</p>'}<article aria-label="${escapeHtml(page.title)}">${sections}${contacts}</article></main>${renderFooter()}</body></html>`
}

export const legalPageKinds: LegalPageKind[] = ['terms', 'refund-policy', 'contacts']
