import { useCallback, useEffect, useState } from 'react'
import { UsefulToolsCatalog } from '../components/partners/UsefulToolsCatalog'
import { loadPartnerTools, type PartnerTool } from '../lib/partnerTools'

export function UsefulToolsPage() {
  const [tools, setTools] = useState<PartnerTool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const retry = useCallback(() => setReload(value => value + 1), [])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void loadPartnerTools().then(rows => { if (active) setTools(rows) }).catch(() => { if (active) setError('Перевірте з’єднання та повторіть спробу.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reload])
  return <UsefulToolsCatalog tools={tools} loading={loading} error={error} onRetry={retry} />
}
