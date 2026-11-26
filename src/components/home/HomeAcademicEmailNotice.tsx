import { ArrowRight, Mail } from 'lucide-react'
import { isKnuEmail } from '../../lib/academicEmail'

export function HomeAcademicEmailNotice({ email, excluded = false }: { email?: string; excluded?: boolean }) {
  if (!email || excluded || isKnuEmail(email)) return null
  return <section className="hd-academic-email" aria-labelledby="home-academic-email-title">
    <Mail size={20} aria-hidden="true" />
    <div>
      <h2 id="home-academic-email-title">Перейдіть на корпоративну пошту КНУ</h2>
      <p>Готуємо Xelay до роботи з деканатом. Підключіть свою адресу @knu.ua в налаштуваннях профілю. Групи, оцінки, матеріали й підписка залишаться у вашому акаунті.</p>
      <small>Новий акаунт створювати не потрібно. Поточний вхід працює до підтвердження нової адреси.</small>
    </div>
    <a href="/profile">Перейти до профілю<ArrowRight size={16} aria-hidden="true" /></a>
  </section>
}
