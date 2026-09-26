import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'

import { Answer } from '../types'
import { TranslateButton } from "./TranslateButton"
import { DiscussionPanel } from "./DiscussionPanel"
import { uk } from 'date-fns/locale'

interface AnswerCardProps {
answer: Answer
}

export function AnswerCard({
answer,
}: AnswerCardProps) {
const navigate = useNavigate()

const [showDiscussion, setShowDiscussion] =
  useState(false)

const safeDate =
answer.createdAt ||
new Date().toISOString()

return ( <div className="xelay-card p-5 animate-fade-in"> <div className="flex items-center justify-between mb-3"> <div className="flex items-center gap-2">

      <div
  onClick={() =>
    navigate({
      to: '/user/$id',
      params: {
        id: String(answer.authorId),
      },
    })
  }
  className="w-8 h-8 rounded-full overflow-hidden bg-muted flex items-center justify-center text-sm font-bold shrink-0 cursor-pointer"
>

        {(answer as any).author_avatar ? (
          <img
            src={(answer as any).author_avatar}
            alt={answer.authorName}
            className="w-full h-full object-cover"
          />
        ) : (
          answer.authorName
            ?.charAt(0)
            ?.toUpperCase() || '?'
        )}

      </div>

      <div>
        <p
  onClick={() =>
    navigate({
      to: '/user/$id',
      params: {
        id: String(answer.authorId),
      },
    })
  }
  className="text-sm font-semibold text-foreground cursor-pointer hover:underline"
>
  {answer.authorName}
</p>

      </div>
    </div>

    <span className="text-xs text-muted-foreground shrink-0">
      {formatDistanceToNow(
        new Date(safeDate),
        {
          addSuffix: true,
          locale: uk,
        }
      )}
    </span>
  </div>

<div className="mb-4">
  <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
    {answer.text}
  </p>

  <TranslateButton
  original={answer.text}
  answerId={answer.id}
/>
</div>

{(answer.images ?? []).length > 0 && (
  <div className="flex flex-wrap gap-2 mb-4">
    {(answer.images ?? []).map(
      (media, index) => (
        media.type === 'video' ? (
          <video
            key={index}
            src={media.url}
            controls
            className="max-w-[320px] rounded-lg border border-border"
          />
        ) : (
          <img
            key={index}
            src={media.url}
            alt=""
            className="max-w-[220px] rounded-lg border border-border"
          />
        )
      )
    )}
  </div>
)}

  <div className="mt-4">

  <button
    onClick={() =>
      setShowDiscussion(!showDiscussion)
    }
    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
  >
    💬 Обговорення
  </button>

  {showDiscussion && (
    <DiscussionPanel
      answerId={answer.id}
    />
  )}

</div>
</div>


)
}
