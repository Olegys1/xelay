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
    language: 'uk',

    isDefaultLanguage: true,

    setLanguage: () => {},
  })

export function LanguageProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [language, setLanguage] = useState<Language>('uk')

  useEffect(() => {
    localStorage.setItem(
      'xelay_language',
      language
    )
  }, [language])

  const isDefaultLanguage =
    language === 'uk'

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
