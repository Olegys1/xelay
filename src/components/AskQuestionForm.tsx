import { useState, useRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { blink } from '../blink/client'
import { useAuth } from '../context/AuthContext'
import { Question, CATEGORIES } from '../types'
import { AuthModal } from './AuthModal'

interface AskQuestionFormProps {
  /** When set, the category is locked and the selector is hidden */
  lockedCategory?: string
  /** Called after a question is successfully posted */
  onPosted?: (question: Question) => void
}

export function AskQuestionForm({ lockedCategory, onPosted }: AskQuestionFormProps) {
  const { isAuthenticated, blinkUser, xelayUser } = useAuth()
  const [questionText, setQuestionText] = useState('')
  const [category, setCategory] = useState<string>(lockedCategory ?? CATEGORIES[0])
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')
  const [showAuthModal, setShowAuthModal] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isAuthenticated) {
      setShowAuthModal(true)
      return
    }
    if (!questionText.trim()) return
    if (!xelayUser) {
      setShowAuthModal(true)
      return
    }

    setSubmitting(true)
    try {
      const newQ: Question = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: blinkUser!.id,
        authorId: blinkUser!.id,
        authorName: xelayUser.name,
        text: questionText.trim(),
        category: lockedCategory ?? category,
        likes: 0,
        createdAt: new Date().toISOString(),
      }
      await blink.db.xelayQuestions.create(newQ)
      setQuestionText('')
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
      onPosted?.(newQ)
    } catch (err) {
      console.error('[Xelay] Ask error:', err)
      setError('Failed to post question. Please try again.')
      setTimeout(() => setError(''), 4000)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}

      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          ref={textareaRef}
          value={questionText}
          onChange={(e) => setQuestionText(e.target.value)}
          placeholder={
            isAuthenticated
              ? lockedCategory
                ? `Ask a question in ${lockedCategory}...`
                : 'Ask your question...'
              : 'Sign in to ask a question'
          }
          rows={3}
          disabled={!isAuthenticated}
          className="w-full px-4 py-3.5 border border-border rounded-xl bg-background text-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors disabled:opacity-60"
        />

        <div className="flex items-center gap-3">
          {/* Category selector — only shown when not locked */}
          {!lockedCategory && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors cursor-pointer"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting || !questionText.trim() || !isAuthenticated}
            onClick={!isAuthenticated ? () => setShowAuthModal(true) : undefined}
            className="flex items-center gap-2 px-5 py-2.5 bg-foreground text-background font-semibold rounded-lg hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap text-sm xelay-btn"
          >
            {submitting ? (
              <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
            ) : (
              <>Post <ArrowRight size={14} /></>
            )}
          </button>

          {!isAuthenticated && (
            <button
              type="button"
              onClick={() => setShowAuthModal(true)}
              className="text-sm text-foreground underline hover:text-muted-foreground transition-colors whitespace-nowrap"
            >
              Sign in
            </button>
          )}
        </div>

        {success && (
          <p className="text-sm text-foreground font-medium animate-fade-in">
            ✓ Question posted!
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive animate-fade-in">{error}</p>
        )}
      </form>
    </>
  )
}
