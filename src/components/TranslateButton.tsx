import { useState } from 'react'
import { useLanguage } from '../context/LanguageContext'

type Props = {
  original: string
  questionId?: string
  answerId?: string
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  uk: 'Ukrainian',
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  tr: 'Turkish',
  hi: 'Hindi',
  ar: 'Arabic',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
}

export function TranslateButton({
  original,
  questionId,
  answerId,
}: Props) {
  const { language } = useLanguage()

  const [translated, setTranslated] =
    useState<string | null>(null)

  const [loading, setLoading] =
    useState(false)

  async function handleTranslate() {
    if (translated) {
      setTranslated(null)
      return
    }

    setLoading(true)

    try {
      const targetLanguage = LANGUAGE_NAMES[language]

      console.log('Selected language:', language)
      console.log('Target language:', targetLanguage)

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: original,
          targetLanguage: language,
          targetLanguageName: targetLanguage,
          questionId,
          answerId,
        }),
      })

      const data = await response.json()

      console.log('Translation result:', data)

      if (!response.ok) {
        throw new Error(data.error || 'Translation failed')
      }

      setTranslated(data.translation)
    } catch (error) {
      console.error('Translation error:', error)
      setTranslated('Не вдалося перекласти текст.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        onClick={handleTranslate}
        disabled={loading}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      >
        {loading
          ? 'Перекладаємо...'
          : translated
            ? 'Показати оригінал'
            : 'Перекласти'}
      </button>

      {translated && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3">
          <p className="text-sm leading-relaxed">
            {translated}
          </p>
        </div>
      )}
    </div>
  )
}
