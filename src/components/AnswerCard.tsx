import { useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ThumbsUp } from 'lucide-react'
import { blink } from '../blink/client'
import { Answer } from '../types'
import { StarRating } from './StarRating'
import { starsFromRating } from '../types'
import { useAuth } from '../context/AuthContext'

interface AnswerCardProps {
  answer: Answer
  questionAuthorId: string
  onLiked?: () => void
}

export function AnswerCard({ answer, questionAuthorId, onLiked }: AnswerCardProps) {
  const { blinkUser, xelayUser } = useAuth()
  const [likes, setLikes] = useState(Number(answer.likes) || 0)
  const [liking, setLiking] = useState(false)
  const [hasLiked, setHasLiked] = useState(false)

  const isQuestionAuthor = blinkUser?.id === questionAuthorId
  const isOwnAnswer = blinkUser?.id === answer.authorId

  const handleLike = async () => {
    if (!isQuestionAuthor || isOwnAnswer || hasLiked || liking) return
    setLiking(true)

    // Optimistic update
    setLikes((l) => l + 1)
    setHasLiked(true)

    try {
      // Increment answer likes
      await blink.db.xelayAnswers.update(answer.id, { likes: likes + 1 })

      // Record the like
      await blink.db.xelayAnswerLikes.create({
        id: `al_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: blinkUser!.id,
        answerId: answer.id,
        likerId: blinkUser!.id,
        createdAt: new Date().toISOString(),
      })

      // Increment answer author's rating by 1
      const authorProfiles = await blink.db.xelayUsers.list({
        where: { userId: answer.authorId },
        limit: 1,
      })
      if (authorProfiles && authorProfiles.length > 0) {
        const profile = authorProfiles[0] as { id: string; rating: unknown }
        const newRating = (Number(profile.rating) || 0) + 1
        await blink.db.xelayUsers.update(profile.id, { rating: newRating })
      }

      // Notify the answer author
      if (answer.authorId !== blinkUser!.id) {
        try {
          await blink.db.xelayNotifications.create({
            id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: answer.authorId,
            recipientId: answer.authorId,
            type: 'like',
            message: `${xelayUser?.name || 'Someone'} liked your answer and gave you +1 rating point!`,
            answerId: answer.id,
            isRead: 0,
            createdAt: new Date().toISOString(),
          })
        } catch {
          // Non-critical — don't fail the like action
        }
      }

      onLiked?.()
    } catch (err) {
      console.error('[Xelay] Like failed:', err)
      // Rollback optimistic update
      setLikes((l) => l - 1)
      setHasLiked(false)
    } finally {
      setLiking(false)
    }
  }

  return (
    <div className="xelay-card p-5 animate-fade-in">
      {/* Author row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-foreground text-background flex items-center justify-center text-sm font-bold shrink-0">
            {answer.authorName.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{answer.authorName}</p>
            <StarRating rating={starsFromRating(Number(answer.authorRating) || 0)} size="sm" />
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatDistanceToNow(new Date(answer.createdAt), { addSuffix: true })}
        </span>
      </div>

      {/* Answer text */}
      <p className="text-sm text-foreground leading-relaxed mb-4">{answer.text}</p>

      {/* Like row */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleLike}
          disabled={!isQuestionAuthor || isOwnAnswer || hasLiked || liking}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors xelay-btn ${
            hasLiked
              ? 'bg-foreground text-background border-foreground'
              : isQuestionAuthor && !isOwnAnswer
              ? 'border-border hover:bg-muted text-foreground cursor-pointer'
              : 'border-border text-muted-foreground cursor-not-allowed opacity-50'
          }`}
          title={
            !isQuestionAuthor
              ? 'Only the question author can like answers'
              : isOwnAnswer
              ? 'You cannot like your own answer'
              : hasLiked
              ? 'Already liked'
              : 'Like this answer (+1 rating to author)'
          }
        >
          <ThumbsUp size={12} />
          <span>{likes}</span>
        </button>

        {isQuestionAuthor && !isOwnAnswer && (
          <span className="text-xs text-muted-foreground">
            {hasLiked ? '✓ +1 rating given' : 'Like to give +1 rating'}
          </span>
        )}
      </div>
    </div>
  )
}
