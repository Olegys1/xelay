import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { CATEGORIES } from '../types'
import { CATEGORY_META } from '../lib/categoryMeta'
import { categoryTranslations } from '../translations/categories'
import { ukrainianCount } from '../lib/ukrainian'
import { CategoryIcon } from '../components/CategoryIcon'

export function CategoriesPage() {
  const navigate = useNavigate()
  const categoryLang = categoryTranslations.uk

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

const handleCategoryClick = (cat: string) => {
  navigate({
    to: `/?category=${encodeURIComponent(cat)}`,
  })
}

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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATEGORIES.map((cat) => {
            const meta = CATEGORY_META[cat]

            return (
              <button
                key={cat}
                onClick={() => handleCategoryClick(cat)}
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
              </button>
            )
          })}
        </div>
      </div>
    </main>
  )
}
