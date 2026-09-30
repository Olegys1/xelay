import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { formatDistanceToNow } from 'date-fns'

import { Answer } from '../types'
import { DiscussionPanel } from "./DiscussionPanel"
import { uk } from 'date-fns/locale'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { deleteOwnAnswer } from '../lib/communityDeletion'
import { OwnContentDeleteButton } from './OwnContentDeleteButton'

interface AnswerCardProps {
answer: Answer
onDeleted?: (answerId: string, answersCount?: number) => void
deletionDisabled?: boolean
}

export function AnswerCard({
answer,
onDeleted,
deletionDisabled = false,
}: AnswerCardProps) {
const navigate = useNavigate()
const { authUser } = useAuth()
const [deleted, setDeleted] = useState(false)

const deleteAnswer = async () => {
  if (!authUser?.id || authUser.id !== answer.userId) throw { code: '42501' }
  const answersCount = await deleteOwnAnswer(answer.id)
  setDeleted(true)
  onDeleted?.(answer.id, answersCount)
}

const [showDiscussion, setShowDiscussion] =
  useState(false)
const [discussionCount, setDiscussionCount] =
  useState<number | null>(null)

useEffect(() => {
  let isCurrentAnswer = true

  const loadDiscussionCount = async () => {
    const { count, error } = await supabase
      .from('answer_discussions')
      .select('id', { count: 'exact', head: true })
      .eq('answer_id', answer.id)

    if (!isCurrentAnswer) return
    if (error) {
      console.error('Could not load answer discussion count:', error)
      return
    }
    setDiscussionCount(count ?? 0)
  }

  void loadDiscussionCount()
  return () => { isCurrentAnswer = false }
}, [answer.id])

const safeDate =
answer.createdAt ||
new Date().toISOString()

if (deleted) return null

return ( <div className="xelay-card min-w-0 p-4 animate-fade-in sm:p-5"> <div className="flex flex-wrap items-center justify-between gap-2 mb-3"> <div className="flex min-w-0 items-center gap-2">

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
  className="break-words text-sm font-semibold text-foreground cursor-pointer hover:underline"
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
  <p className="break-words text-sm text-foreground leading-relaxed whitespace-pre-wrap">
    {answer.text}
  </p>
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
            className="max-w-full sm:max-w-[320px] rounded-lg border border-border"
          />
        ) : (
          <img
            key={index}
            src={media.url}
            alt=""
            className="max-w-full sm:max-w-[220px] rounded-lg border border-border"
          />
        )
      )
    )}
  </div>
)}

  <div className="mt-4">

  <div className="flex flex-wrap items-center justify-between gap-2">
  <button
    onClick={() =>
      setShowDiscussion(!showDiscussion)
    }
    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
  >
    💬 Обговорення <span className="ml-1 tabular-nums">{discussionCount ?? '…'}</span>
  </button>
  {authUser?.id === answer.userId && <OwnContentDeleteButton kind="answer" compact disabled={deletionDisabled} onDelete={deleteAnswer} />}
  </div>

  {showDiscussion && (
    <DiscussionPanel
      answerId={answer.id}
      onCountChange={setDiscussionCount}
    />
  )}

</div>
</div>


)
}
