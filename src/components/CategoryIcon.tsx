import { CATEGORY_META } from '../lib/categoryMeta'

export function CategoryIcon({ category, className = 'h-6 w-6 text-xl' }: {
  category: string
  className?: string
}) {
  const meta = CATEGORY_META[category]
  if (!meta?.icon && !meta?.image) return null
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center leading-none ${className}`}>
    {meta.image
      ? <img src={meta.image} alt="" width={64} height={64} loading="lazy" className="h-full w-full rounded-md bg-white object-contain" />
      : meta.icon}
  </span>
}
