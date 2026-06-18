import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function getDeviceId(): string {
  const key = 'kwenta_device_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = generateId()
    localStorage.setItem(key, id)
  }
  return id
}

export function now(): string {
  return new Date().toISOString()
}

/**
 * Single tolerance (in currency units) for treating a money value as zero/settled.
 * Amounts are stored cent-rounded, so genuine differences are 0 or >= 0.01; a 0.005
 * threshold cleanly separates rounding noise from a real one-cent obligation. Use this
 * everywhere instead of ad-hoc 0.005 / 0.01 / 0.02 literals so a balance can't read
 * "settled" in one place and "owed" in another.
 */
export const MONEY_EPSILON = 0.005

/** Round a money amount to 2 decimal places (cents). */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100
}

/** True when an amount is within rounding noise of zero. */
export function isEffectivelyZero(amount: number): boolean {
  return Math.abs(amount) <= MONEY_EPSILON
}

export function formatCurrency(amount: number, currency = 'PHP'): string {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
