import { useEffect, useState } from "react"

import { getDiscussions, createDiscussion } from "../lib/discussions"
import type { Discussion } from "../types"

import { useAuth } from "../context/AuthContext"

interface Props {
  answerId: string
  onCountChange?: (count: number) => void
}

export function DiscussionPanel({
  answerId,
  onCountChange,
}: Props) {
  const { authUser } = useAuth()

  const [loading, setLoading] =
    useState(true)

  const [text, setText] =
    useState("")

  const [discussions, setDiscussions] =
    useState<Discussion[]>([])

  async function load() {
    setLoading(true)

    const data =
      await getDiscussions(answerId)
      console.log("DISCUSSIONS:", data)

    setDiscussions(data)
    onCountChange?.(data.length)

    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [answerId])

  async function handleSend() {
    if (!authUser) return

    if (!text.trim()) return

    await createDiscussion(
      answerId,
      authUser.id,
      text
    )

    setText("")

    load()
  }

  if (loading) {
    return (
      <div className="mt-4 text-sm text-muted-foreground">
        Завантаження...
      </div>
    )
  }

  return (
    <div className="mt-4 border-t border-border pt-4">

      <div className="space-y-3">

        {discussions.map((item) => (

          <div
            key={item.id}
            className="rounded-lg bg-muted/40 p-3"
          >

            <div className="font-medium text-sm">
              {item.user.name}
            </div>

            <div className="text-sm mt-1 whitespace-pre-wrap">
              {item.text}
            </div>

          </div>

        ))}

      </div>

      {authUser && (

        <div className="mt-4">

          <textarea
            value={text}
            onChange={(e) =>
              setText(e.target.value)
            }
            rows={3}
            placeholder="Продовжити обговорення..."
            className="w-full rounded-lg border border-border bg-background p-3 text-sm"
          />

          <button
            onClick={handleSend}
            className="mt-2 px-4 py-2 rounded-lg bg-foreground text-background text-sm"
          >
            Надіслати
          </button>

        </div>

      )}

    </div>
  )
}
