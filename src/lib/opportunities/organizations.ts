import type { Company, Opportunity, OrganizationKind } from './types'

export function newOrganization(ownerId: string, kind: OrganizationKind, values: Partial<Company> = {}): Company {
  return {
    id: crypto.randomUUID(), revision: 0, ownerId, kind, name: '', tagline: '', description: '',
    industry: '', city: '', website: '', contactEmail: '', contactName: '', legalName: '',
    registrationCode: '', logo: '', color: kind === 'school' ? '#e6e7f6' : '#f0e2e7',
    verificationNote: '', verificationFile: null, status: 'draft', partner: false,
    reviewNote: '', createdAt: new Date().toISOString(), ...values,
  }
}

export function newOrganizationOffer(company: Company): Opportunity {
  return {
    id: crypto.randomUUID(), revision: 0, companyId: company.id,
    kind: company.kind === 'school' ? 'course' : 'job', title: '', summary: '', description: '',
    requirements: '', benefits: '', city: company.city, format: 'remote', employment: '',
    experience: '', compensation: '', paid: 'unspecified', direction: '', deadline: '', startsAt: '',
    applicationMode: 'internal', externalUrl: '', status: 'draft', reviewNote: '', files: [],
    syllabus: '', instructors: '', schedule: '', createdAt: new Date().toISOString(),
  }
}

export function organizationVerificationIssues(company: Company): string[] {
  const issues: string[] = []
  if (company.description.trim().length < 20) issues.push('Додайте опис організації: від 20 символів.')
  if (company.legalName.trim().length < 2) issues.push('Вкажіть юридичну назву або назву ФОП.')
  if (!/^\d{8}$|^\d{10}$/.test(company.registrationCode.trim())) issues.push('Код ЄДРПОУ — 8 цифр, РНОКПП ФОП — 10 цифр.')
  if (!company.website.trim()) issues.push('Додайте офіційний сайт або сторінку організації.')
  if ((company.verificationNote || '').trim().length < 10) issues.push('Поясніть вашу роль та як підтвердити представництво.')
  return issues
}

export function organizationOfferIssues(offer: Opportunity): string[] {
  const issues: string[] = []
  if (offer.description.trim().length < 20) issues.push('Додайте змістовний опис: від 20 символів.')
  if (!offer.compensation.trim()) issues.push(offer.kind === 'course' ? 'Вкажіть повну вартість або «Безкоштовно».' : 'Вкажіть оплату або прямо зазначте її відсутність.')
  if (offer.kind !== 'course' && offer.paid === 'unspecified') issues.push('Позначте, чи оплачується робота або стажування.')
  if (offer.kind === 'course' && (!(offer.syllabus || '').trim() || !(offer.instructors || '').trim() || !(offer.schedule || '').trim() || !offer.employment.trim())) issues.push('Додайте програму, викладачів, тривалість і розклад курсу.')
  return issues
}
