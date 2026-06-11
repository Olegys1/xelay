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
    (question as any).created_at ||
    (question as any).createdAt ||
    new Date().toISOString()

const content =
  (question as any).content ||
  (question as any).text ||
  (question as any).title ||
  ''

  const likes =
    Number((question as any).likes) || 0

  const answersCount =
    Number(
      (question as any).answers_count
    ) || 0

  const category =
    (question as any).category ||
    'General'

  const authorName =
  (question as any).author_name ||
  'anonymous'

  const openQuestion = () => {
    if (onAnswerClick) {
      onAnswerClick()
    }

    navigate({
      to: '/question/$id',
      params: {
        id: String(question.id),
      },
    })
  }

  return (
    <div className="xelay-card p-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
<div className="flex items-center gap-2 mb-3 flex-wrap text-xs text-muted-foreground">
  <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
    {category}
  </span>

  <span>
    • @{authorName.replace('@', '')}
  </span>

  <span>
    • {new Date(
      safeDate
    ).toLocaleDateString()}
  </span>
</div>

{content && (
  <p className="text-foreground leading-relaxed whitespace-pre-wrap">
    {content}
  </p>
)}
{(question as any).images &&
  (question as any).images.length >
    0 && (
    <div className="flex flex-wrap gap-2 mt-3">
      {(question as any).images.map(
        (
          image: string,
          index: number
        ) => (
          <img
            key={index}
            src={image}
            alt=""
            className="max-w-[220px] rounded-lg border border-border cursor-pointer hover:opacity-90 transition-opacity"
          />
        )
      )}
    </div>
)}
          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1">
                <Heart size={14} />
                {likes}
              </div>

              <div className="flex items-center gap-1">
                <MessageCircle size={14} />
                {answersCount}
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