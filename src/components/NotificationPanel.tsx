import { useEffect, useState, useRef, useCallback } from 'react'
import { blink } from '../blink/client'
import { Notification } from '../types'
import { Bell, Check } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

interface NotificationPanelProps {
  userId: string
  onClose: () => void
}

export function NotificationPanel({ userId, onClose }: NotificationPanelProps) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await blink.db.xelayNotifications.list({
        where: { recipientId: userId },
        orderBy: { createdAt: 'desc' },
        limit: 20,
      })
      setNotifications((data || []) as unknown as Notification[])
    } catch (err) {
      console.warn('[Xelay] Failed to load notifications:', err)
    } finally {
      setLoading(false)
    }
  }, [userId])

  const markAllRead = async () => {
    // Filter unread client-side (isRead may come back as 0 integer or "0" string)
    const unread = notifications.filter((n) => Number(n.isRead) === 0)
    try {
      await Promise.all(
        unread.map((notif) =>
          blink.db.xelayNotifications.update(notif.id, { isRead: 1 })
        )
      )
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: 1 })))
    } catch (err) {
      console.warn('[Xelay] Failed to mark notifications read:', err)
    }
  }

  useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Small delay so the button click that opened this doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 100)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handler)
    }
  }, [onClose])

  const unreadCount = notifications.filter((n) => Number(n.isRead) === 0).length

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-2 w-80 bg-background border border-border rounded-xl shadow-[var(--shadow-xl)] z-50 animate-fade-in overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Bell size={15} className="text-foreground" />
          <span className="font-semibold text-sm text-foreground">Notifications</span>
          {unreadCount > 0 && (
            <span className="bg-foreground text-background text-xs rounded-full px-1.5 py-0.5 font-medium leading-none">
              {unreadCount}
            </span>
          )}
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors xelay-btn"
          >
            <Check size={11} />
            Mark all read
          </button>
        )}
      </div>

      {/* List */}
      <div className="max-h-[360px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-foreground/20 border-t-foreground rounded-full animate-spin" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-10 text-center">
            <Bell size={28} className="mx-auto text-muted-foreground mb-2 opacity-40" />
            <p className="text-sm text-muted-foreground">No notifications yet</p>
          </div>
        ) : (
          <ul>
            {notifications.map((notif) => (
              <li
                key={notif.id}
                className={`px-4 py-3 border-b border-border last:border-0 transition-colors ${
                  Number(notif.isRead) === 0 ? 'bg-muted/40' : ''
                }`}
              >
                {Number(notif.isRead) === 0 && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-foreground mr-2 align-middle mb-0.5" />
                )}
                <span className="text-sm text-foreground">{notif.message}</span>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDistanceToNow(new Date(notif.createdAt), { addSuffix: true })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
