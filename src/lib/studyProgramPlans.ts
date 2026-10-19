export type StudyProgramPlanArgs = {
  universitySlug?: string | null
  unitSlug?: string | null
  programName?: string | null
  studyLevel?: string | null
  cohortStartYear?: number | null
}

export type StudyProgramPlanLink = {
  href: string
  label: string
  description: string
  match: 'program' | 'catalog'
}

type PlanLevel = 'bachelor' | 'master'
type ProgramEntry = readonly [name: string, path: string]

const ECONOMICS_BASE = 'https://econom.knu.ua/educational-programs/'
const KNU_CATALOG = 'https://programs.knu.ua/faculties/'
const ECONOMICS_CATALOGS: Readonly<Record<PlanLevel, string>> = {
  bachelor: `${ECONOMICS_BASE}undergraduate_courses/`,
  master: `${ECONOMICS_BASE}master_program/`,
}

// Official pages followed from the faculty's degree/program navigation and
// checked on 2026-10-20. These are HTML structures with course/semester tables,
// descriptions and (where published) admission-year plans; never a guessed PDF.
// Sources: https://econom.knu.ua/educational-programs/undergraduate_courses/
//          https://econom.knu.ua/educational-programs/master_program/
// Every relative path below was opened as an official "Структура програми" page.
const BACHELOR_PROGRAMS: readonly ProgramEntry[] = [
  ['Економіка', 'economic/sp/'],
  ['Економіка (мова навчання англійська/українська) / Economics', 'economics-al/sp/'],
  ['Економіка та економічна політика', 'economics-and-economic-policy-2/sp/'],
  ['Економічна аналітика', 'business-statistics/sp/'],
  ['Економічна кібернетика', 'economic-cybernetics/sp/'],
  ['Міжнародна економіка', 'international-economics/sp/'],
  ['Економіка та управління бізнесом', 'eb/sp/'],
  // Explicit legacy name of this same programme, not a generic suffix rule.
  ['Економіка та управління бізнесом (ЕУБ)', 'eb/sp/'],
  ['Облік і оподаткування', 'oblik_kontr/sp/'],
  ['Фінанси', 'financeb/sp/'],
  ['Менеджмент організацій', 'manag_org/структура-програми/'],
  ['Менеджмент підприємницької діяльності', 'ptl/sp/'],
  ['Маркетинг', 'marketyng/sp/'],
]

const MASTER_PROGRAMS: readonly ProgramEntry[] = [
  ['Економіка та економічна політика', 'eandep/sp/'],
  ['Економіка та політика (мова навчання англійська/українська) / Economics and Politics', 'economics-and-politics/sp/'],
  ['Економічна аналітика', 'economic-analysis-and-statistics/sp/'],
  ['Економічна кібернетика', 'economic-cybernetics/sp/'],
  ['Фінанси публічного сектору / Public Sector Finance (З можливістю подвійного дипломування разом з Норд Університетом, Норвегія)', 'fin_publ_sect/sp/'],
  ['Менеджмент інноваційної діяльності', 'management-of-innovation/структура-програми/'],
  ['Менеджмент підприємницької діяльності', 'manpd/sp/'],
  ['Бізнес-адміністрування і консультування (мова навчання англійська/українська) З можливістю подвійного дипломування з Університетом Мачерата, Італія', 'baikpd/sp/'],
]

// Names alone cannot choose among day/part-time or dual/non-dual variants.
// Keep those in the degree catalogue until the group stores the missing mode.
// Examples verified on 2026-10-20: bachelor financial_business/ versus
// financial_business_extr/; master corporate-finance/ versus corporate-finance-2/,
// menedg_org_admin/ versus management-of-organizations-and-administration-2/,
// oblik_kontr/ versus oblik_kontr-2/; business_consulting_dual/ is explicitly dual.
// Similarly, do not infer "Фінансові інститути та управління ризиками" from a
// differently named legacy "Фінансові інститути та ризик-менеджмент" page.

// Official faculty catalogues checked by following their headings on
// https://infopacket.knu.ua/ on 2026-10-20. These are catalogue fallbacks only,
// not an assertion that a particular programme, degree or cohort was matched.
const KNU_UNIT_CATALOG_IDS: Readonly<Record<string, number>> = {
  physics: 1010,
  psychology: 1011,
  chemistry: 1012,
  philology: 1013,
  'public-administration': 1014,
  'military-institute': 1015,
  philosophy: 1016,
  law: 1017,
  history: 1018,
  'continuing-education': 1019,
  'radio-physics-electronics': 1020,
  'computer-science-cybernetics': 1021,
  'biology-medicine': 1022,
  journalism: 1023,
  'international-relations': 1024,
  'mechanics-mathematics': 1025,
  geography: 1026,
  'information-technology': 1029,
  'high-technologies': 2029,
}

function normalizeProgramName(value: string): string {
  return value.normalize('NFKC').replace(/[’ʼ`]/g, "'").replace(/[‐‑‒–—]/g, '-')
    .trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')
}

function programIndex(entries: readonly ProgramEntry[]): ReadonlyMap<string, string> {
  return new Map(entries.map(([name, path]) => [normalizeProgramName(name), path]))
}

const ECONOMICS_PROGRAMS: Readonly<Record<PlanLevel, ReadonlyMap<string, string>>> = {
  bachelor: programIndex(BACHELOR_PROGRAMS),
  master: programIndex(MASTER_PROGRAMS),
}

function admissionYearHint(cohortStartYear: number | null | undefined): string {
  return typeof cohortStartYear === 'number' && Number.isInteger(cohortStartYear)
    && cohortStartYear >= 1900 && cohortStartYear <= 2199
    ? `Звірте форму навчання та оберіть план для свого року вступу — ${cohortStartYear}.`
    : 'Звірте форму навчання та оберіть план для свого року вступу.'
}

/** Resolve public official sources only; no fetching, user identifiers or access grants. */
export function resolveStudyProgramPlan(args: StudyProgramPlanArgs): StudyProgramPlanLink | null {
  if (args.universitySlug !== 'knu') return null

  const yearHint = admissionYearHint(args.cohortStartYear)
  if (args.unitSlug === 'economics') {
    const level: PlanLevel | null = args.studyLevel === 'bachelor' || args.studyLevel === 'master'
      ? args.studyLevel : null
    const path = level && args.programName
      ? ECONOMICS_PROGRAMS[level].get(normalizeProgramName(args.programName)) : undefined
    if (level && path) {
      const degreePath = level === 'bachelor' ? 'undergraduate_courses/' : 'master_program/'
      return {
        href: `${ECONOMICS_BASE}${degreePath}${path}`,
        label: 'План моєї програми',
        description: `Структура освітньої програми на офіційному сайті економічного факультету КНУ. ${yearHint}`,
        match: 'program',
      }
    }
    return {
      href: level ? ECONOMICS_CATALOGS[level] : ECONOMICS_BASE,
      label: 'Знайти план програми',
      description: `Оберіть свою освітню програму${level === 'bachelor' ? ' бакалаврату' : level === 'master' ? ' магістратури' : ' та рівень навчання'} на офіційному сайті факультету. ${yearHint}`,
      match: 'catalog',
    }
  }

  const facultyId = args.unitSlug && Object.prototype.hasOwnProperty.call(KNU_UNIT_CATALOG_IDS, args.unitSlug)
    ? KNU_UNIT_CATALOG_IDS[args.unitSlug] : undefined
  return {
    href: facultyId ? `https://infopacket.knu.ua/FacultyInfo?faculId=${facultyId}` : KNU_CATALOG,
    label: 'Каталог освітніх програм',
    description: `Оберіть свою освітню програму та рівень навчання в офіційному каталозі КНУ. ${yearHint}`,
    match: 'catalog',
  }
}
