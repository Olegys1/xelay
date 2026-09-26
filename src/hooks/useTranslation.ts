import { ui } from '../translations/ui'

export function useTranslation() {
  const t = (
    key: keyof typeof ui.uk
  ) => {
    return ui.uk[key] || key
  }

  return { t }
}
