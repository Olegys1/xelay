import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { GroupPresentationPdfPreview } from '../components/GroupPresentationPdfPreview'
import { loadPrivateDocument } from '../lib/opportunities/privateDocument'

export function PrivateOrganizationDocumentPage({ fileId }: { fileId: string }) {
  const { authUser, isLoading, authReadEpoch, authReadBlocked } = useAuth()
  const [document, setDocument] = useState<{ blob: Blob; name: string; scope: string } | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const scope = `${authUser?.id || ''}:${authReadEpoch}:${fileId}`
  useEffect(() => {
    const controller = new AbortController()
    let hidden = false
    setDocument(null); setError('')
    const clear = () => {
      hidden = true; controller.abort(); setDocument(null)
    }
    // A restored history page must reauthorize instead of showing cached bytes.
    const restore = () => { if (hidden) setRefresh(value => value + 1) }
    window.addEventListener('pagehide', clear); window.addEventListener('pageshow', restore)
    if (authUser && !isLoading && !authReadBlocked) {
      void loadPrivateDocument(fileId, controller.signal).then(result => {
        if (controller.signal.aborted) return
        setDocument({ blob: result.blob, name: result.file.name, scope })
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не вдалося відкрити документ.')
      })
    }
    return () => { clear(); window.removeEventListener('pagehide', clear); window.removeEventListener('pageshow', restore) }
  }, [scope, isLoading, authReadBlocked, refresh])
  const visible = !authReadBlocked && authUser && document?.scope === scope ? document : null
  return <main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-10">
    <Link to="/business" className="mb-8 inline-flex items-center gap-2 text-sm text-primary"><ArrowLeft size={16} />До кабінету</Link>
    <header className="mb-6 flex items-start gap-3"><ShieldCheck className="mt-1 shrink-0 text-primary" size={24} /><div><p className="text-sm text-muted-foreground">Приватний документ організації</p><h1 className="mt-1 break-words text-xl font-semibold">{visible?.name || 'Перегляд документа'}</h1></div></header>
    {isLoading ? <p role="status">Перевіряємо вхід…</p> : !authUser ? <div className="rounded-2xl border border-border p-6"><p>Увійдіть до акаунта власника документа. Пересилання посилання не надає доступу.</p><Link to="/business" className="mt-4 inline-block text-primary underline">Увійти до Xelay</Link><p className="mt-3 text-sm text-muted-foreground">Після входу відкрийте це посилання ще раз.</p></div> : error ? <div role="alert" className="rounded-2xl border border-border p-6"><p>{error}</p><button type="button" className="mt-4 text-primary underline" onClick={() => setRefresh(value => value + 1)}>Перевірити доступ ще раз</button></div> : visible ? <GroupPresentationPdfPreview key={scope} blob={visible.blob} name={visible.name} documentLabel="Документ" /> : <p role="status" className="flex items-center gap-2"><Loader2 size={18} className="animate-spin" />Перевіряємо доступ і відкриваємо PDF…</p>}
  </main>
}
