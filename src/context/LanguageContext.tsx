import {
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'

export type Language =
  | 'en'
  | 'uk'
  | 'pl'
  | 'de'
  | 'fr'
  | 'es'
  | 'it'
  | 'pt'
  | 'tr'
  | 'hi'
  | 'ar'
  | 'zh'
  | 'ja'
  | 'ko'

interface LanguageContextType {
  language: Language

  isDefaultLanguage: boolean

  setLanguage: (
    lang: Language
  ) => void
}

const LanguageContext =
  createContext<LanguageContextType>({
    language: 'en',

    isDefaultLanguage: true,

    setLanguage: () => {},
  })

export function LanguageProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [language, setLanguage] =
    useState<Language>(() => {
      const saved =
        localStorage.getItem(
          'xelay_language'
        )

      return (
        (saved as Language) ||
        'en'
      )
    })

  useEffect(() => {
    localStorage.setItem(
      'xelay_language',
      language
    )
  }, [language])

  const isDefaultLanguage =
    language === 'en'

  return (
    <LanguageContext.Provider
      value={{
        language,
        isDefaultLanguage,
        setLanguage,
      }}
    >
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  return useContext(
    LanguageContext
  )
}

export const LANGUAGES = [
  {
    code: 'en',
    label: 'English',
    flag: '🇺🇸',
  },

  {
    code: 'uk',
    label: 'Українська',
    flag: '🇺🇦',
  },

  {
    code: 'pl',
    label: 'Polski',
    flag: '🇵🇱',
  },

  {
    code: 'de',
    label: 'Deutsch',
    flag: '🇩🇪',
  },

  {
    code: 'fr',
    label: 'Français',
    flag: '🇫🇷',
  },

  {
    code: 'es',
    label: 'Español',
    flag: '🇪🇸',
  },

  {
    code: 'it',
    label: 'Italiano',
    flag: '🇮🇹',
  },

  {
    code: 'pt',
    label: 'Português',
    flag: '🇵🇹',
  },

  {
    code: 'tr',
    label: 'Türkçe',
    flag: '🇹🇷',
  },

  {
    code: 'hi',
    label: 'हिन्दी',
    flag: '🇮🇳',
  },

  {
    code: 'ar',
    label: 'العربية',
    flag: '🇸🇦',
  },

  {
    code: 'zh',
    label: '中文',
    flag: '🇨🇳',
  },

  {
    code: 'ja',
    label: '日本語',
    flag: '🇯🇵',
  },

  {
    code: 'ko',
    label: '한국어',
    flag: '🇰🇷',
  },
] as const