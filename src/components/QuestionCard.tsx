import {
  MessageCircle,
  Eye,
  Pin
} from 'lucide-react'

import { Link, useNavigate } from '@tanstack/react-router'

import { useState } from 'react'

import { Question } from '../types'
import { categoryLabel } from '../translations/categories'
import { useAuth } from '../context/AuthContext'
import { deleteOwnQuestion } from '../lib/communityDeletion'
import { OwnContentDeleteButton } from './OwnContentDeleteButton'
interface QuestionCardProps {
  question: Question
  showAnswerButton?: boolean
  onAnswerClick?: () => void
  onDeleted?: (questionId: string) => void
}

export function QuestionCard({
  question,
  showAnswerButton = true,
  onAnswerClick,
  onDeleted,
}: QuestionCardProps) {
  const navigate = useNavigate()
  const { authUser } = useAuth()
  const [deleted, setDeleted] = useState(false)

  const [expanded, setExpanded] =
  useState(false)

const MAX_PREVIEW_LENGTH = 150

  const safeDate =
    (question as any).created_at ||
    (question as any).createdAt ||
    new Date().toISOString()

const content =
  (question as any).content ||
  (question as any).text ||
  (question as any).title ||
  ''

const isLong =
  content.length >
  MAX_PREVIEW_LENGTH

const displayedContent =
  expanded
    ? content
    : isLong
      ? content.slice(
          0,
          MAX_PREVIEW_LENGTH
        ) + '...'
      : content

  const answersCount =
    Number(
      (question as any).answers_count
    ) || 0

  const category =
    (question as any).category ||
    'Інше'

  const authorName =
  (question as any).author_name ||
  'Анонім'

  const authorId =
  (question as any).user_id

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

  const deleteQuestion = async () => {
    if (!authUser?.id || authUser.id !== question.user_id) throw { code: '42501' }
    await deleteOwnQuestion(question.id)
    setDeleted(true)
    onDeleted?.(question.id)
  }

  if (deleted) return null

  return (
    <div className="group relative xelay-card min-w-0 p-4 animate-fade-in transition-colors hover:border-primary/25 sm:p-5">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
<div className="flex items-center gap-2 mb-3 flex-wrap text-xs text-muted-foreground">
  <span className="px-2.5 py-1 rounded-full bg-accent text-accent-foreground">
    {categoryLabel(category)}
  </span>

<span
  onClick={() => {
    if (!authorId) return

    navigate({
      to: '/user/$id',
      params: {
        id: String(authorId),
      },
    })
  }}
  className="relative z-10 min-w-0 cursor-pointer break-words hover:text-primary hover:underline"
>
  • @{authorName.replace('@', '')}
</span>

  <span>
    • {new Date(
      safeDate
      ).toLocaleDateString('uk-UA')}
  </span>
</div>

{content && (
  <>
<div className="flex items-start gap-2">
  {(question as any).is_pinned && (
    <Pin
      size={16}
      className="mt-1 shrink-0"
    />
  )}

  <div className="flex-1">
    <Link
      to="/question/$id"
      params={{ id: String(question.id) }}
      search={{}}
      className="block break-words text-foreground leading-relaxed whitespace-pre-wrap after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2"
    >
      {displayedContent}
    </Link>
  </div>
</div>

    {isLong && (
      <button
        onClick={() =>
          setExpanded(!expanded)
        }
        className="relative z-10 mt-2 text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
      >
        {expanded
          ? 'Згорнути'
          : 'Читати далі'}
      </button>
    )}
  </>
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
            className="max-w-full rounded-lg border border-border cursor-pointer hover:opacity-90 transition-opacity sm:max-w-[220px]"
          />
        )
      )}
    </div>
)}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
  <div className="flex items-center gap-4">

  <div className="flex items-center gap-4 text-sm text-muted-foreground">
    <div className="flex items-center gap-1">
      <MessageCircle size={14} />
      {answersCount}
    </div>

    <div className="flex items-center gap-1">
      <Eye size={14} />
      {(question as any).views || 0}
    </div>
  </div>



</div>
  <div className="relative z-10 flex flex-wrap items-center gap-2">
  {authUser?.id === question.user_id && <OwnContentDeleteButton kind="question" compact onDelete={deleteQuestion} />}
  {showAnswerButton && (
    <button
      onClick={openQuestion}
      className="text-sm font-medium text-primary transition-colors hover:text-primary/75"
    >
      Відповісти
    </button>
  )}
  </div>
</div>
        </div>
      </div>
    </div>
  )
}
