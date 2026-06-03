import { useState, useEffect } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ThumbsUp } from 'lucide-react'

import { supabase } from '../lib/supabase'
import { Answer } from '../types'
import { StarRating } from './StarRating'
import { starsFromRating } from '../types'
import { useAuth } from '../context/AuthContext'

interface AnswerCardProps {
answer: Answer
questionAuthorId: string
onLiked?: () => void
}

export function AnswerCard({
answer,
questionAuthorId,
onLiked,
}: AnswerCardProps) {
const { authUser } = useAuth()

const [likes, setLikes] = useState(
Number(answer.likes) || 0
)

const [liking, setLiking] = useState(false)

const [hasLiked, setHasLiked] =
useState(false)

const isOwnAnswer =
authUser?.id === answer.authorId

const safeDate =
answer.createdAt ||
new Date().toISOString()

useEffect(() => {
const checkLike = async () => {
if (!authUser) return

  const { data } = await supabase
    .from('answer_likes')
    .select('id')
    .eq('answer_id', answer.id)
    .eq('user_id', authUser.id)
    .maybeSingle()

  setHasLiked(!!data)
}

checkLike()

}, [authUser, answer.id])

const handleLike = async () => {
if (
!authUser ||
isOwnAnswer ||
hasLiked ||
liking
) {
return
}

setLiking(true)

try {
  const { error: likeError } =
    await supabase
      .from('answer_likes')
      .insert({
        answer_id: answer.id,
        user_id: authUser.id,
      })

  if (likeError) {
    throw likeError
  }

  const newLikes = likes + 1
  console.log(
  'answer.id =',
  answer.id
)

const { data: checkAnswer } =
  await supabase
    .from('answers')
    .select('*')
    .eq('id', answer.id)

console.log(
  'Found answer:',
  checkAnswer
)

const { data, error: updateError } =
  await supabase
    .from('answers')
    .update({
      likes: newLikes,
    })
    .eq('id', answer.id)
    .select()

console.log(
  'UPDATE RESULT:',
  data,
  updateError
)

if (updateError) {
  throw updateError
}

const { data: profile } = await supabase
  .from('profiles')
  .select('rating')
  .eq('id', answer.authorId)
  .single()

const currentRating =
  Number(profile?.rating || 0)

const { error: ratingError } =
  await supabase.rpc(
    'increment_profile_rating',
    {
      profile_id: answer.authorId,
    }
  )

console.log(
  'RATING ERROR:',
  ratingError
)
    await supabase
  .from('notifications')
  .insert({
    recipient_id: answer.authorId,
    actor_id: authUser.id,
    actor_name: authUser.email || 'Someone',
    type: 'like',
    message: `${authUser.email || 'Someone'} liked your answer`,
    answer_id: answer.id,
    is_read: false,
  })

  setLikes(newLikes)
  setHasLiked(true)

  onLiked?.()
} catch (err) {
  console.error(
    '[Xelay] Like failed:',
    err
  )
} finally {
  setLiking(false)
}


}

return ( <div className="xelay-card p-5 animate-fade-in"> <div className="flex items-center justify-between mb-3"> <div className="flex items-center gap-2">

      <div className="w-8 h-8 rounded-full overflow-hidden bg-muted flex items-center justify-center text-sm font-bold shrink-0">

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
        <p className="text-sm font-semibold text-foreground">
          {answer.authorName}
        </p>

        <StarRating
          rating={starsFromRating(
            Number(
              answer.authorRating
            ) || 0
          )}
          size="sm"
        />
      </div>
    </div>

    <span className="text-xs text-muted-foreground shrink-0">
      {formatDistanceToNow(
        new Date(safeDate),
        {
          addSuffix: true,
        }
      )}
    </span>
  </div>

  <p className="text-sm text-foreground leading-relaxed mb-4 whitespace-pre-wrap">
    {answer.text}
  </p>

  <div className="flex items-center gap-3">
    <button
      onClick={handleLike}
      disabled={
        isOwnAnswer ||
        hasLiked ||
        liking
      }
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 active:scale-95 xelay-btn ${
        hasLiked
          ? 'bg-foreground text-background border-foreground'
          : !isOwnAnswer
          ? 'border-border hover:bg-muted hover:scale-105 text-foreground cursor-pointer'
          : 'border-border text-muted-foreground cursor-not-allowed opacity-50'
      }`}
    >
      <ThumbsUp size={12} />
      <span>{likes}</span>
    </button>

    {!isOwnAnswer && (
      <span className="text-xs text-muted-foreground">
        {hasLiked
          ? '✓ Rating given'
          : 'Like this answer'}
      </span>
    )}
  </div>
</div>


)
}
