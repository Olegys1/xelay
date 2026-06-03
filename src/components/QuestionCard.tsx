import {
  MessageCircle,
  Heart,
} from 'lucide-react'

import { useNavigate } from '@tanstack/react-router'

import { Question } from '../types'

interface QuestionCardProps {
  question: Question
  showAnswerButton?: boolean
  onAnswerClick?: () => void
}

export function QuestionCard({
  question,
  showAnswerButton = true,
  onAnswerClick,
}: QuestionCardProps) {
  const navigate = useNavigate()

  const safeDate =
    question.created_at ||
    new Date().toISOString()

  const openQuestion = () => {
    if (onAnswerClick) {
      onAnswerClick()
    }

    navigate({
      to: '/question/$id',
      params: {
        id: question.id,
      },
    })
  }

  return (
    <div className="xelay-card p-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
              {question.category}
            </span>

            <span className="text-xs text-muted-foreground">
              {new Date(
                safeDate
              ).toLocaleDateString()}
            </span>
          </div>

          <p className="text-foreground leading-relaxed whitespace-pre-wrap">
            {question.content}
          </p>

          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Heart size={14} />
                {question.likes || 0}
              </div>

              <div className="flex items-center gap-1">
                <MessageCircle size={14} />
                {question.answers_count || 0}
              </div>
            </div>

            {showAnswerButton && (
              <button
                onClick={openQuestion}
                className="text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
              >
                Answer
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}