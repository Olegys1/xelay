import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { supabase } from '../lib/supabase'
import { CATEGORIES, categoryToSlug } from '../types'
import { CATEGORY_META } from '../lib/categoryMeta'
import { useLanguage } from '../context/LanguageContext'
import { categoryTranslations } from '../translations/categories'

const STUDENT_CATEGORIES = [
  'Career Launch',
  'Skills vs Degree',
  'Internships & Side Projects',
  'Team Up & Collaborations',
  'Mastermind Groups',
]

export function CategoriesPage() {
  const navigate = useNavigate()
  const { language } = useLanguage()

const categoryLang =
  categoryTranslations[
    language as keyof typeof categoryTranslations
  ] || categoryTranslations.en

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
            {
  language === 'uk'
    ? 'Категорії'
    : language === 'hi'
    ? 'श्रेणियाँ'
    : 'Categories'
}
          </h1>

          <p className="text-muted-foreground text-lg">
            {
  language === 'uk'
    ? 'Переглядайте питання за темами та діліться своїм досвідом'
    : language === 'hi'
    ? 'विषयों के अनुसार प्रश्न देखें और अपना अनुभव साझा करें'
    : 'Browse questions by topic and share your expertise'
}
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
                  <div className="flex items-center gap-2 flex-wrap">
  {meta?.icon && (
    <span className="text-xl">
      {meta.icon}
    </span>
  )}

  <span className="text-base font-bold text-foreground leading-tight">
    {categoryLang[cat]?.title || cat}
  </span>

  {STUDENT_CATEGORIES.includes(cat) && (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
      🎓 {
  language === 'uk'
    ? 'СТУДЕНТИ'
    : language === 'hi'
    ? 'छात्र'
    : 'STUDENTS'
}
    </span>
  )}
</div>

                  <span className="text-xs font-medium bg-muted text-muted-foreground px-2.5 py-1 rounded-full shrink-0 ml-2">
                    {loading ? '...' : `${counts[cat] ?? 0} Q`}
                  </span>
                </div>

                <p className="text-sm text-muted-foreground leading-relaxed">
                  {
  categoryLang[cat]?.description ||
  meta?.description ||
  ''
}
                </p>

                <div className="mt-4 flex items-center gap-1 text-xs font-medium text-foreground opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  {
  language === 'uk'
    ? `Переглянути ${
        categoryLang[cat]?.title || cat
      } →`
    : language === 'hi'
    ? `${
        categoryLang[cat]?.title || cat
      } देखें →`
    : `Browse ${
        categoryLang[cat]?.title || cat
      } →`
}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </main>
  )
}