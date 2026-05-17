import { useNavigate } from '@tanstack/react-router'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center px-6">
        <p className="text-6xl font-bold text-foreground mb-4">404</p>
        <h1 className="text-xl font-semibold text-foreground mb-2">Page not found</h1>
        <p className="text-muted-foreground mb-6">The page you're looking for doesn't exist.</p>
        <button
          onClick={() => navigate({ to: '/' })}
          className="px-5 py-2.5 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 transition-colors text-sm"
        >
          Go Home
        </button>
      </div>
    </main>
  )
}
