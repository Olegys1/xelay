export const SPEF_CATEGORY = 'IT'

type ParliamentResource = { title: string; href?: string }

const knuParliaments = new Map<string, ParliamentResource>([
  ['geography', { title: 'СПГФ', href: 'https://geo.knu.ua/studentske-zhyttya/studentskyj-parlament/' }],
  ['history', { title: 'СПІФ', href: 'https://history.knu.ua/studentskij-parlament/' }],
  ['mechanics-mathematics', { title: 'Студпарламент мехмату', href: 'https://t.me/spmmf' }],
  ['information-technology', { title: 'СП ФІТ', href: 'https://fit.knu.ua/governments' }],
  ['computer-science-cybernetics', { title: 'СП факультету кібернетики', href: 'https://csc.knu.ua/uk/student-life' }],
  ['psychology', { title: 'СПФП', href: 'https://psy.knu.ua/students/stud-parlament/info' }],
  ['radio-physics-electronics', { title: 'СП РЕКС', href: 'https://rex.knu.ua/for-students/student-organizations/' }],
  ['sociology', { title: 'Студпарламент факультету соціології', href: 'https://www.sociology.knu.ua/uk/studparliament' }],
  ['physics', { title: 'Студпарламент фізфаку', href: 'https://t.me/SPfizik' }],
  ['philosophy', { title: 'СПФФ', href: 'https://philosophy.knu.ua/study/student-government' }],
  ['chemistry', { title: 'СПХФ', href: 'https://chem.knu.ua/ua/students_self_government/' }],
  ['military-institute', { title: 'Курсантська рада', href: 'https://viknu.mil.gov.ua/about.html' }],
  ['state-guard-management', { title: 'СП ІУДОУ' }],
  ['high-technologies', { title: 'Студпарламент ННІВТ' }],
  ['geology', { title: 'Студпарламент ННІ «Інститут геології»' }],
  ['journalism', { title: 'Студпарламент ННІЖ', href: 'https://ktm.journ.knu.ua/studentam/' }],
  ['international-relations', { title: 'Рада студентів ННІМВ' }],
  ['law', { title: 'СП ННІП', href: 'https://law.knu.ua/info/studentske-samovriaduvannia/' }],
  ['philology', { title: 'СПННІФ', href: 'https://philology.knu.ua/studentam/samovriaduvannia/studentskyy-parlament-spnnif/' }],
  ['public-administration', { title: 'СП ННІ ПУДС', href: 'https://ipacs.knu.ua/?lang=ukr&page=374&tip=dop&tipn=Page' }],
  ['biology-medicine', { title: 'СП ННЦ «ІБМ»', href: 'https://biomed.knu.ua/students-postgraduates/self-government/studential-parliament/chief.html' }],
])

export type FacultyParliament =
  | { kind: 'spef' }
  | { kind: 'external'; title: string; href: string }
  | { kind: 'news'; title: string }

export function facultyParliament(universitySlug: string, unit: { slug: string; name: string }): FacultyParliament {
  if (universitySlug === 'knu' && unit.slug === 'economics') return { kind: 'spef' }

  const resource = universitySlug === 'knu' ? knuParliaments.get(unit.slug) : undefined
  if (resource?.href) return { kind: 'external', title: resource.title, href: resource.href }
  return { kind: 'news', title: resource?.title ?? `Студентське самоврядування · ${unit.name}` }
}
