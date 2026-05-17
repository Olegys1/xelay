interface StarRatingProps {
  rating: number
  size?: 'sm' | 'md' | 'lg'
}

export function StarRating({ rating, size = 'sm' }: StarRatingProps) {
  const sizeClass = size === 'sm' ? 'text-sm' : size === 'md' ? 'text-lg' : 'text-2xl'
  return (
    <span className={`${sizeClass} tracking-wide select-none`} aria-label={`Rating: ${rating} stars`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className={star <= rating ? 'star-filled' : 'star-empty'}>
          ★
        </span>
      ))}
    </span>
  )
}
