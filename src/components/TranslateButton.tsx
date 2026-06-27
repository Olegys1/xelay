import { useState } from 'react'

type Props = {
  original: string
}

export function TranslateButton({
  original,
}: Props) {
  const [translated, setTranslated] =
    useState<string | null>(null)

  const [loading, setLoading] =
    useState(false)

 async function handleTranslate() {
  if (translated) {
    setTranslated(null)
    return
  }

  setLoading(true)

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: original,
      }),
    })

    const data = await response.json()

    setTranslated(data.translation)
  } catch (err) {
    console.error(err)
    setTranslated("Translation failed.")
  }

  setLoading(false)
}

  return (
    <div>
      <button
  onClick={handleTranslate}
  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
>
        {loading
          ? 'Translating...'
          : translated
          ? ' Show original'
          : ' Translate'}
      </button>

     {translated && (
  <div className="mt-3 rounded-lg bg-muted/50 p-3">
    <p className="text-sm leading-relaxed">
      {translated}
    </p>
  </div>
)}
    </div>
  )
}