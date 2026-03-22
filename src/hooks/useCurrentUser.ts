import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'

/**
 * Active profile id comes from the signed-in session (`useAuth` → store).
 * No anonymous bootstrap — `/app` requires login.
 */
export function useCurrentUser() {
  const currentUserId = useAppStore((s) => s.currentUserId)

  const profile = useLiveQuery(
    () => (currentUserId ? db.profiles.get(currentUserId) : undefined),
    [currentUserId],
  )

  return { userId: currentUserId, profile }
}
