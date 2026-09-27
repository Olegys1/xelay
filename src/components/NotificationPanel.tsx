import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { uk } from 'date-fns/locale'

import { supabase } from '../lib/supabase'

interface NotificationPanelProps {
  userId: string
  onClose: () => void
}

interface NotificationItem {
  id: string
  actor_name: string
  message: string
  created_at: string
  is_read: boolean

  question_id?: string
  answer_id?: string
  news_post_id?: string | null
  type?: string
}
export function NotificationPanel({
  userId,
  onClose,
}: NotificationPanelProps) {

  const navigate = useNavigate()
  const panelRef =
    useRef<HTMLDivElement>(null)

  const [notifications, setNotifications] =
    useState<NotificationItem[]>([])

  const [loading, setLoading] =
    useState(true)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(
          e.target as Node
        )
      ) {
        onClose()
      }
    }

    const t = setTimeout(() => {
      document.addEventListener(
        'mousedown',
        handler
      )
    }, 100)

    return () => {
      clearTimeout(t)

      document.removeEventListener(
        'mousedown',
        handler
      )
    }
  }, [onClose])

  useEffect(() => {
    const fetchNotifications =
      async () => {
        try {
          const { data, error } =
            await supabase
              .from('notifications')
              .select('*')
              .eq(
                'recipient_id',
                userId
              )
              .order(
                'created_at',
                {
                  ascending: false,
                }
              )

          if (error) {
            console.error(error)
            return
          }

          setNotifications(
            data || []
          )

          await supabase
            .from('notifications')
            .update({
              is_read: true,
            })
            .eq(
              'recipient_id',
              userId
            )
            .eq(
              'is_read',
              false
            )
        } catch (err) {
          console.error(err)
        } finally {
          setLoading(false)
        }
      }

    fetchNotifications()
  }, [userId])

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-2 w-80 bg-background border border-border rounded-xl shadow-[var(--shadow-xl)] z-50 animate-fade-in overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Bell
          size={15}
          className="text-foreground"
        />

        <span className="font-semibold text-sm text-foreground">
          Сповіщення
        </span>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Завантаження...
        </div>
      ) : notifications.length === 0 ? (
        <div className="py-10 text-center">
          <Bell
            size={28}
            className="mx-auto text-muted-foreground mb-2 opacity-40"
          />

          <p className="text-sm text-muted-foreground">
            Сповіщень поки немає.
          </p>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto">
          {notifications.map(
            (notification) => (
             <div
  key={notification.id}
  onClick={() => {
    if (notification.type === 'connection_request') {
      navigate({ to: '/profile' })
    } else if (notification.type === 'connection_accepted' || notification.type === 'message') {
      navigate({ to: '/messages' })
    } else if (notification.news_post_id) {
      navigate({ to: '/news/$id', params: { id: notification.news_post_id } })
    } else if (notification.type === 'editor_request_approved' || notification.type === 'editor_request_rejected') {
      navigate({ to: '/news' })
    } else if (notification.type === 'news_submission_rejected') {
      navigate({ to: '/news' })
    } else if (notification.question_id) {
      navigate({
        to: '/question/$id',
        params: {
          id: notification.question_id,
        },
      })
    } else {
      return
    }

    onClose()
  }}
  className={`px-4 py-3 border-b border-border last:border-b-0 cursor-pointer hover:bg-muted ${
    !notification.is_read
      ? 'bg-muted/40'
      : ''
  }`}
>
                <p className="text-sm text-foreground">
                  <span className="font-semibold">
                    {
                      notification.actor_name
                    }
                  </span>{' '}
                  {
                    notification.type === 'answer'
                      ? 'відповів(-ла) на ваше запитання'
                      : notification.message
                  }
                </p>

                <p className="text-xs text-muted-foreground mt-1">
                  {formatDistanceToNow(
                    new Date(
                      notification.created_at
                    ),
                    {
                      addSuffix: true,
                      locale: uk,
                    }
                  )}
                </p>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
