import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type NewsImageProps = {
  imagePath?: string | null
  imageUrl?: string | null
  className?: string
  alt?: string
}

function getLegacyImageUrl(value?: string | null): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function NewsImage({ imagePath, imageUrl, className, alt = '' }: NewsImageProps) {
  const path = imagePath?.trim() || ''
  const legacyUrl = getLegacyImageUrl(imageUrl)
  const [signedImage, setSignedImage] = useState<{ path: string; url: string } | null>(null)
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!path) {
      setSignedImage(null)
      return
    }

    let cancelled = false
    const signImage = async () => {
      try {
        const { data, error } = await supabase.storage.from('xelay-news-media').createSignedUrl(path, 3600)
        if (cancelled) return
        if (error) throw error
        if (!data?.signedUrl) throw new Error('News image signing returned no URL.')
        setSignedImage({ path, url: data.signedUrl })
      } catch (error) {
        if (cancelled) return
        console.error('Could not sign news image:', error)
        setSignedImage(null)
      }
    }

    void signImage()
    const refresh = window.setInterval(() => void signImage(), 50 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(refresh)
    }
  }, [path])

  const src = path ? (signedImage?.path === path ? signedImage.url : null) : legacyUrl
  if (!src || brokenUrl === src) return null

  return <img src={src} alt={alt} className={className} onError={() => setBrokenUrl(src)} />
}
