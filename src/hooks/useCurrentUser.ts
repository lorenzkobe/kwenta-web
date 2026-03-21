import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { generateId, getDeviceId, now } from '@/lib/utils'

const LOCAL_USER_KEY = 'kwenta_local_user_id'

export function useCurrentUser() {
  const currentUserId = useAppStore((s) => s.currentUserId)
  const setCurrentUserId = useAppStore((s) => s.setCurrentUserId)

  useEffect(() => {
    async function bootstrap() {
      let userId = localStorage.getItem(LOCAL_USER_KEY)

      if (userId) {
        const existing = await db.profiles.get(userId)
        if (existing) {
          setCurrentUserId(userId)
          return
        }
      }

      userId = generateId()
      const timestamp = now()
      await db.profiles.add({
        id: userId,
        email: '',
        display_name: 'You',
        avatar_url: null,
        is_local: false,
        linked_profile_id: null,
        owner_id: null,
        created_at: timestamp,
        updated_at: timestamp,
        synced_at: null,
        is_deleted: false,
        device_id: getDeviceId(),
      })
      localStorage.setItem(LOCAL_USER_KEY, userId)
      setCurrentUserId(userId)
    }

    if (!currentUserId) {
      bootstrap()
    }
  }, [currentUserId, setCurrentUserId])

  const profile = useLiveQuery(
    () => (currentUserId ? db.profiles.get(currentUserId) : undefined),
    [currentUserId],
  )

  return { userId: currentUserId, profile }
}
