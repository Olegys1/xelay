import { useState, useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { UsersRound } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { CATEGORIES, categoryToSlug } from '../types'
import { CATEGORY_META } from '../lib/categoryMeta'
import { categoryTranslations } from '../translations/categories'
import { ukrainianCount } from '../lib/ukrainian'
import { CategoryIcon } from '../components/CategoryIcon'
import { FacultyParliamentLink } from '../components/FacultyParliamentLink'
import { useFacultyParliament } from '../hooks/useFacultyParliament'
import { SPEF_CATEGORY } from '../lib/facultyParliament'
import { HalloweenPumpkin } from '../components/halloween/HalloweenPumpkin'

export function CategoriesPage() {
  const categoryLang = categoryTranslations.uk
  const parliament = useFacultyParliament()

  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const { data, error } = await supabase
          .from('questions')
          .select('category')

        if (error) {
          console.error(error)
          return
        }

        const countMap: Record<string, number> = {}

        CATEGORIES.forEach((cat) => {
          countMap[cat] = 0
        })

        ;(data || []).forEach((q: any) => {
          if (q.category) {
            countMap[q.category] = (countMap[q.category] || 0) + 1
          }
        })

        setCounts(countMap)
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    fetchCounts()
  }, [])


  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8 sm:px-6 sm:py-12">
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
            Спільнота
          </h1>

          <p className="text-muted-foreground text-lg">
            Обговорюйте теми та діліться досвідом з університетською спільнотою.
          </p>
        </div>

        <HalloweenPumpkin pumpkinId="questions" perch="right" className="mb-3" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATEGORIES.map((cat) => {
            if (cat === SPEF_CATEGORY && parliament?.kind !== 'spef') {
              return parliament && <FacultyParliamentLink key={cat} entry={parliament}
                className="xelay-card min-w-0 p-5 text-left group xelay-btn sm:p-6">
                <div className="mb-3 flex items-start gap-2">
                  <UsersRound size={24} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 break-words text-base font-bold leading-snug">{parliament.title}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {parliament.kind === 'external' ? 'Сторінка студентського самоврядування вашого підрозділу' : 'Новини вашого підрозділу в Xelay'}
                </p>
              </FacultyParliamentLink>
            }
            const meta = CATEGORY_META[cat]

            return (
              <Link
                key={cat}
                to="/category/$slug"
                params={{ slug: categoryToSlug(cat) }}
                className="xelay-card min-w-0 p-5 text-left group xelay-btn sm:p-6"
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
  <CategoryIcon category={cat} className="h-8 w-8 text-xl" />
  <span className="min-w-0 break-words text-base font-bold text-foreground leading-snug">
  {categoryLang[cat]?.title || cat}
  </span>
</div>

                </div>

                <p className="text-sm text-muted-foreground leading-relaxed">
                  {
  categoryLang[cat]?.description ||
  meta?.description ||
  ''
}
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs font-medium">
                  <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
                    {loading ? '…' : ukrainianCount(counts[cat] ?? 0, ['запитання', 'запитання', 'запитань'])}
                  </span>
                  <span className="text-primary">Відкрити →</span>
                </div>
              </Link>
            )
          })}
        </div>
      </div>
    </main>
  )
}
