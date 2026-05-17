import { formatDistanceToNow } from 'date-fns'
import { MessageCircle } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { Question } from '../types'
import { StarRating } from './StarRating'
import { starsFromRating } from '../types'

interface QuestionCardProps {
  question: Question
  authorRating?: number
  onAnswerClick?: () => void
  showAnswerButton?: boolean
}

export function QuestionCard({
  question,
  authorRating = 0,
  onAnswerClick,
  showAnswerButton = true,
}: QuestionCardProps) {
  const navigate = useNavigate()

  const handleClick = () => {
    navigate({ to: '/question/$id', params: { id: question.id } })
  }

  return (
    <article
      className="xelay-card p-5 cursor-pointer"
      onClick={handleClick}
    >
      {/* Category + timestamp */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium px-2.5 py-1 bg-muted text-muted-foreground rounded-full uppercase tracking-wider">
          {question.category}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(question.createdAt), { addSuffix: true })}
        </span>
      </div>

      {/* Question text */}
      <p className="text-base font-medium text-foreground leading-relaxed mb-4 line-clamp-3">
        {question.text}
      </p>

      {/* Author + action */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-foreground shrink-0">
            {question.authorName.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-xs font-medium text-foreground">{question.authorName}</p>
            <StarRating rating={starsFromRating(authorRating)} size="sm" />
          </div>
        </div>

        {showAnswerButton && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAnswerClick ? onAnswerClick() : handleClick()
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-full hover:bg-muted transition-colors xelay-btn"
          >
            <MessageCircle size={13} />
            Answer
          </button>
        )}
      </div>
    </article>
  )
}
