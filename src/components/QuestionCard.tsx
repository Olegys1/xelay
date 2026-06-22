import {
  MessageCircle,
  Heart,
  Eye,
  Pin
} from 'lucide-react'

import { useNavigate } from '@tanstack/react-router'

import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'

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

  const likes =
    Number((question as any).likes) || 0
    

const { authUser } = useAuth()

const [likesCount, setLikesCount] =
  useState(likes)

const [liked, setLiked] =
  useState(false)

const [loadingLike, setLoadingLike] =
  useState(false)

  useEffect(() => {
  const checkLike = async () => {
    if (!authUser) return

    const { data } = await supabase
      .from('question_likes')
      .select('id')
      .eq('question_id', question.id)
      .eq('user_id', authUser.id)
      .maybeSingle()

    setLiked(!!data)
  }

  checkLike()
}, [authUser, question.id])

const handleLike = async () => {
  console.log('QUESTION LIKE CLICKED')

  if (!authUser) return
  if (loadingLike) return

  setLoadingLike(true)

  try {
    if (liked) {
      await supabase
        .from('question_likes')
        .delete()
        .eq('question_id', question.id)
        .eq('user_id', authUser.id)

      const newLikes = Math.max(
        likesCount - 1,
        0
      )

      await supabase
        .from('questions')
        .update({
          likes: newLikes,
        })
        .eq('id', question.id)

      setLikesCount(newLikes)
      setLiked(false)
    } else {
      await supabase
        .from('question_likes')
        .insert({
          question_id: question.id,
          user_id: authUser.id,
        })

      const authorId = (question as any).user_id

      console.log(
        'QUESTION AUTHOR ID:',
        authorId
      )

      console.log(
        'CURRENT USER ID:',
        authUser.id
      )

      const { error: ratingError } =
        await supabase.rpc(
          'increment_profile_rating',
          {
            profile_id: authorId,
          }
        )

      console.log(
        'QUESTION RATING ERROR:',
        ratingError
      )

      if (authorId !== authUser.id) {
  await supabase
  .from('notifications')
  .insert({
    recipient_id: authorId,
    actor_id: authUser.id,
    actor_name: authUser.email,

    type: 'question_like',

    message: 'liked your question',

    question_id: question.id,

    is_read: false,
  })
}

      const newLikes = likesCount + 1

      await supabase
        .from('questions')
        .update({
          likes: newLikes,
        })
        .eq('id', question.id)

      setLikesCount(newLikes)
      setLiked(true)
    }
  } catch (err) {
    console.error(
      'QUESTION LIKE ERROR:',
      err
    )
  } finally {
    setLoadingLike(false)
  }
}

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

  return (
    <div className="xelay-card p-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
<div className="flex items-center gap-2 mb-3 flex-wrap text-xs text-muted-foreground">
  <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
    {category}
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
  className="cursor-pointer hover:underline"
>
  • @{authorName.replace('@', '')}
</span>

  <span>
    • {new Date(
      safeDate
    ).toLocaleDateString()}
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

      <p className="text-foreground leading-relaxed whitespace-pre-wrap">
        {displayedContent}
      </p>
    </div>

    {isLong && (
      <button
        onClick={() =>
          setExpanded(!expanded)
        }
        className="mt-2 text-sm font-medium text-foreground hover:text-muted-foreground transition-colors"
      >
        {expanded
          ? 'Collapse'
          : 'Read more'}
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
            className="max-w-[220px] rounded-lg border border-border cursor-pointer hover:opacity-90 transition-opacity"
          />
        )
      )}
    </div>
)}
          <div className="mt-4 flex items-center justify-between">
  <div className="flex items-center gap-4 text-sm text-muted-foreground">
    <button
      onClick={handleLike}
      disabled={loadingLike}
      className="flex items-center gap-1 hover:text-red-500 transition-colors"
    >
      <Heart
        size={14}
        fill={liked ? 'currentColor' : 'none'}
      />
      {likesCount}
    </button>

    <div className="flex items-center gap-1">
      <MessageCircle size={14} />
      {answersCount}
    </div>

    <div className="flex items-center gap-1">
      <Eye size={14} />
      {(question as any).views || 0}
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