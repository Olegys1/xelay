import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { CATEGORIES, categoryToSlug } from '../types'
import { CATEGORY_META } from '../lib/categoryMeta'

export function CategoriesPage() {
  const navigate = useNavigate()

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
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight text-foreground mb-2">
            Categories
          </h1>

          <p className="text-muted-foreground text-lg">
            Browse questions by topic and share your expertise
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CATEGORIES.map((cat) => {
            const meta = CATEGORY_META[cat]

            return (
              <button
                key={cat}
                onClick={() => handleCategoryClick(cat)}
                className="xelay-card p-6 text-left group xelay-btn"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {meta?.icon && (
                      <span className="text-xl">
                        {meta.icon}
                      </span>
                    )}

                    <span className="text-base font-bold text-foreground leading-tight">
                      {cat}
                    </span>
                  </div>

                  <span className="text-xs font-medium bg-muted text-muted-foreground px-2.5 py-1 rounded-full shrink-0 ml-2">
                    {loading ? '...' : `${counts[cat] ?? 0} Q`}
                  </span>
                </div>

                <p className="text-sm text-muted-foreground leading-relaxed">
                  {meta?.description ?? ''}
                </p>

                <div className="mt-4 flex items-center gap-1 text-xs font-medium text-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  Browse {cat} →
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </main>
  )
}