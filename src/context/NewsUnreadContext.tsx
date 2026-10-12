import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { useNotificationPreferences } from './NotificationPreferencesContext'
import { useToast } from './ToastContext'

type NewsScope = 'faculty' | 'university'
type UnreadNews = { notificationId: string; postId: string; scope: NewsScope }
type NewsUnreadState = {
  hasUnread: boolean
  unreadByScope: Record<NewsScope, boolean>
  unreadPostIds: string[]
  newsRevision: number
  markRead: (postIds: string[]) => Promise<boolean>
  refresh: () => Promise<void>
}
const EMPTY_SCOPES = { faculty: false, university: false }
const NewsUnreadContext = createContext<NewsUnreadState | null>(null)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function NewsUnreadProvider({ children }: { children: ReactNode }) {
  const { authUser, xelayUser } = useAuth()
  const { preferences, loading: preferencesLoading } = useNotificationPreferences()
  const { notify } = useToast()
  const userId = authUser?.id || null
  const universityId = xelayUser?.userId === userId ? xelayUser.universityId || null : null
  const academicUnitId = xelayUser?.userId === userId ? xelayUser.academicUnitId || null : null
  const scopeKey = `${userId || ''}:${universityId || ''}:${academicUnitId || ''}`
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const mounted = useRef(false)
  const requestVersion = useRef(0)
  const [snapshot, setSnapshot] = useState<{ key: string; items: UnreadNews[] }>({ key: '', items: [] })
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [revision, setRevision] = useState({ key: '', value: 0 })
  const pendingAnnouncements = useRef(new Map<string, { key: string; postId: string }>())
  const toastEnabled = useRef(false)
  toastEnabled.current = !preferencesLoading && preferences.notificationsEnabled

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestVersion.current += 1 }
  }, [])

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current
    const current = () => mounted.current && currentScope.current === scopeKey && version === requestVersion.current
    if (!userId || !universityId) {
      if (current()) setSnapshot({ key: scopeKey, items: [] })
      return
    }
    try {
      const items: UnreadNews[] = []
      // Keyset pages keep removal/read acknowledgements from shifting offsets.
      // The join also removes archived/deleted posts and stale faculty membership.
      let after: string | null = null
      while (current()) {
        let query = supabase.from('notifications')
          .select('id,news_post_id,news_posts!inner(id,university_id,academic_unit_id,status)')
          .eq('recipient_id', userId).eq('type', 'news_published').is('news_read_at', null)
          .eq('news_posts.university_id', universityId).eq('news_posts.status', 'published')
          .order('id', { ascending: true }).limit(500)
        query = academicUnitId
          ? query.or(`academic_unit_id.is.null,academic_unit_id.eq.${academicUnitId}`, { referencedTable: 'news_posts' })
          : query.is('news_posts.academic_unit_id', null)
        if (after) query = query.gt('id', after)
        const { data, error } = await query
        if (!current() || error || !data) return
        for (const row of data) {
          const post = (Array.isArray(row.news_posts) ? row.news_posts[0] : row.news_posts) as {
            id: string; university_id: string; academic_unit_id: string | null; status: string
          } | null
          if (!post || !row.news_post_id || post.status !== 'published' || post.university_id !== universityId
            || (post.academic_unit_id !== null && post.academic_unit_id !== academicUnitId)) continue
          items.push({ notificationId: String(row.id), postId: row.news_post_id, scope: post.academic_unit_id ? 'faculty' : 'university' })
        }
        if (data.length < 500) break
        const lastId = String(data[data.length - 1].id)
        if (lastId === after) return
        after = lastId
      }
      if (!current()) return
      const previous = snapshotRef.current
      if (previous.key === scopeKey) {
        const known = new Set(previous.items.map((item) => item.postId))
        if (items.some((item) => !known.has(item.postId))) {
          setRevision((value) => ({ key: scopeKey, value: value.key === scopeKey ? value.value + 1 : 1 }))
        }
      }
      setSnapshot({ key: scopeKey, items })
      const available = new Set(items.map((item) => item.postId))
      let announcement: UnreadNews | undefined
      pendingAnnouncements.current.forEach((event, id) => {
        if (event.key === scopeKey && available.has(event.postId)) announcement = items.find((item) => item.postId === event.postId)
        pendingAnnouncements.current.delete(id)
      })
      // Only live INSERT events announce themselves; loading old unread history
      // after sign-in never produces a stack of popups.
      if (announcement && toastEnabled.current && document.visibilityState === 'visible') {
        notify({ id: 'news-publication', tone: 'info', title: announcement.scope === 'faculty' ? 'Нові новини факультету' : 'Нові новини університету',
          description: 'Відкрийте «Новини», щоб переглянути нову публікацію.' })
      }
    } catch { /* Keep the last confirmed dots; focus, Realtime and polling retry. */ }
  }, [userId, universityId, academicUnitId, scopeKey, notify])

  const markRead = useCallback(async (postIds: string[]) => {
    const ids = [...new Set(postIds.filter((id) => UUID.test(id)))].slice(0, 500)
    if (!ids.length || !userId || !universityId || currentScope.current !== scopeKey) return false
    // Invalidate an older GET before it can restore receipts acknowledged here.
    requestVersion.current += 1
    try {
      const { data, error } = await supabase.from('notifications')
        .update({ news_read_at: new Date().toISOString(), is_read: true })
        .eq('recipient_id', userId).eq('type', 'news_published').is('news_read_at', null)
        .in('news_post_id', ids).select('news_post_id')
      if (error || !mounted.current || currentScope.current !== scopeKey) return false
      const confirmed = new Set((data || []).map((row) => row.news_post_id))
      setSnapshot((previous) => previous.key === scopeKey
        ? { ...previous, items: previous.items.filter((item) => !confirmed.has(item.postId)) } : previous)
      void refresh()
      return true
    } catch { return false }
  }, [userId, universityId, scopeKey, refresh])

  useEffect(() => {
    pendingAnnouncements.current.clear()
    if (!userId || !universityId) { void refresh(); return }
    let active = true
    let timer: number | undefined
    let feedChanged = false
    const scheduleRefresh = (changed = false) => {
      if (!active) return
      feedChanged ||= changed
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!active || document.visibilityState !== 'visible') return
        if (feedChanged) {
          feedChanged = false
          setRevision((previous) => ({ key: scopeKey, value: previous.key === scopeKey ? previous.value + 1 : 1 }))
        }
        void refresh()
      }, 250)
    }
    const onResume = () => { if (document.visibilityState === 'visible') scheduleRefresh(true) }
    void refresh()
    const channel = supabase.channel(`news-unread-${scopeKey}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, (payload) => {
        const row = payload.new as { id?: string; type?: string; news_post_id?: string; recipient_id?: string }
        if (payload.eventType === 'DELETE') { scheduleRefresh(); return }
        if (row.type !== 'news_published' || row.recipient_id !== userId) return
        if (payload.eventType === 'INSERT' && row.id && row.news_post_id && document.visibilityState === 'visible') {
          pendingAnnouncements.current.set(row.id, { key: scopeKey, postId: row.news_post_id })
        }
        scheduleRefresh(payload.eventType === 'INSERT')
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'news_posts', filter: `university_id=eq.${universityId}` }, () => scheduleRefresh(true))
      .subscribe((status) => { if (status === 'SUBSCRIBED') scheduleRefresh(true) })
    window.addEventListener('focus', onResume)
    window.addEventListener('online', onResume)
    document.addEventListener('visibilitychange', onResume)
    const interval = window.setInterval(() => scheduleRefresh(), 60_000)
    return () => {
      active = false
      requestVersion.current += 1
      window.clearTimeout(timer)
      window.clearInterval(interval)
      window.removeEventListener('focus', onResume)
      window.removeEventListener('online', onResume)
      document.removeEventListener('visibilitychange', onResume)
      void supabase.removeChannel(channel)
    }
  }, [userId, universityId, scopeKey, refresh])

  const items = snapshot.key === scopeKey ? snapshot.items : []
  const value = useMemo<NewsUnreadState>(() => ({
    hasUnread: items.length > 0,
    unreadByScope: items.length ? { faculty: items.some((item) => item.scope === 'faculty'), university: items.some((item) => item.scope === 'university') } : EMPTY_SCOPES,
    unreadPostIds: items.map((item) => item.postId),
    newsRevision: revision.key === scopeKey ? revision.value : 0,
    markRead, refresh,
  }), [items, revision, scopeKey, markRead, refresh])
  return <NewsUnreadContext.Provider value={value}>{children}</NewsUnreadContext.Provider>
}

export function useNewsUnread() {
  const context = useContext(NewsUnreadContext)
  if (!context) throw new Error('NewsUnreadProvider is required')
  return context
}
