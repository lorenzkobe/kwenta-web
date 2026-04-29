import {
  Car,
  Dumbbell,
  Hotel,
  ShoppingCart,
  Tag,
  Tv,
  UtensilsCrossed,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export type BillCategory =
  | 'food'
  | 'transport'
  | 'accommodation'
  | 'utilities'
  | 'entertainment'
  | 'groceries'
  | 'health'
  | 'other'

export const BILL_CATEGORIES: BillCategory[] = [
  'food',
  'transport',
  'accommodation',
  'utilities',
  'entertainment',
  'groceries',
  'health',
  'other',
]

export const CATEGORY_LABELS: Record<BillCategory, string> = {
  food: 'Food',
  transport: 'Transport',
  accommodation: 'Accommodation',
  utilities: 'Utilities',
  entertainment: 'Entertainment',
  groceries: 'Groceries',
  health: 'Health',
  other: 'Other',
}

export const CATEGORY_COLORS: Record<BillCategory, string> = {
  food: 'bg-orange-500/15 text-orange-800',
  transport: 'bg-sky-500/15 text-sky-800',
  accommodation: 'bg-purple-500/15 text-purple-800',
  utilities: 'bg-yellow-500/15 text-yellow-800',
  entertainment: 'bg-pink-500/15 text-pink-800',
  groceries: 'bg-emerald-500/15 text-emerald-800',
  health: 'bg-red-500/15 text-red-800',
  other: 'bg-stone-500/15 text-stone-700',
}

export const CATEGORY_ICONS: Record<BillCategory, LucideIcon> = {
  food: UtensilsCrossed,
  transport: Car,
  accommodation: Hotel,
  utilities: Zap,
  entertainment: Tv,
  groceries: ShoppingCart,
  health: Dumbbell,
  other: Tag,
}
