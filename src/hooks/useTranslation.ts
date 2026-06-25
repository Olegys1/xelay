import { useLanguage } from '../context/LanguageContext'
import { ui } from '../translations/ui'

export function useTranslation() {
  const { language } = useLanguage()

  const t = (
    key: keyof typeof ui.en
  ) => {
    return (
      ui[language]?.[key] ||
      ui.en[key] ||
      key
    )
  }

  return { t }
}