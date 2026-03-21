import { useLiveQuery } from 'dexie-react-hooks'
import { listSettlementHistoryForGroup, listSettlementHistoryForUser } from '@/lib/settlement'
import { db } from './db'

function activeOnly<T extends { is_deleted: boolean }>(items: T[] | undefined) {
  return (items ?? []).filter((i) => !i.is_deleted)
}

export function useProfile(userId: string | undefined) {
  return useLiveQuery(
    () => (userId ? db.profiles.get(userId) : undefined),
    [userId],
  )
}

export function useGroups(userId: string | undefined) {
  return useLiveQuery(async () => {
    if (!userId) return []
    const memberships = await db.group_members
      .where('user_id')
      .equals(userId)
      .toArray()
    const groupIds = memberships
      .filter((m) => !m.is_deleted)
      .map((m) => m.group_id)
    if (groupIds.length === 0) return []
    const groups = await db.groups.where('id').anyOf(groupIds).toArray()
    return activeOnly(groups)
  }, [userId])
}

export function useGroupMembers(groupId: string | undefined) {
  return useLiveQuery(async () => {
    if (!groupId) return []
    const members = await db.group_members
      .where('group_id')
      .equals(groupId)
      .toArray()
    return activeOnly(members)
  }, [groupId])
}

export function useBills(groupId?: string | null, userId?: string) {
  return useLiveQuery(async () => {
    if (groupId) {
      const bills = await db.bills.where('group_id').equals(groupId).toArray()
      return activeOnly(bills)
    }
    if (userId) {
      const bills = await db.bills.where('created_by').equals(userId).toArray()
      return activeOnly(bills)
    }
    return []
  }, [groupId, userId])
}

export function useBillItems(billId: string | undefined) {
  return useLiveQuery(async () => {
    if (!billId) return []
    const items = await db.bill_items.where('bill_id').equals(billId).toArray()
    return activeOnly(items)
  }, [billId])
}

export function useItemSplits(itemId: string | undefined) {
  return useLiveQuery(async () => {
    if (!itemId) return []
    const splits = await db.item_splits.where('item_id').equals(itemId).toArray()
    return activeOnly(splits)
  }, [itemId])
}

export function useSettlements(groupId: string | undefined) {
  return useLiveQuery(async () => {
    if (!groupId) return []
    const settlements = await db.settlements
      .where('group_id')
      .equals(groupId)
      .toArray()
    return activeOnly(settlements)
  }, [groupId])
}

export function useGroupSettlementHistory(groupId: string | undefined) {
  return useLiveQuery(async () => {
    if (!groupId) return []
    return listSettlementHistoryForGroup(groupId)
  }, [groupId])
}

export function useUserSettlementHistory(userId: string | undefined) {
  return useLiveQuery(async () => {
    if (!userId) return []
    return listSettlementHistoryForUser(userId)
  }, [userId])
}

export function useActivityLog(groupId?: string | null, limit = 20) {
  return useLiveQuery(async () => {
    const collection = groupId
      ? db.activity_log.where('group_id').equals(groupId)
      : db.activity_log.orderBy('created_at')
    const items = await collection.reverse().limit(limit).toArray()
    return activeOnly(items)
  }, [groupId, limit])
}
