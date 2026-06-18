import { describe, expect, it } from 'vitest'
import {
  BILL_CATEGORIES,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
} from '@/lib/bill-categories'

describe('bill categories', () => {
  it('lists eight distinct categories', () => {
    expect(BILL_CATEGORIES).toHaveLength(8)
    expect(new Set(BILL_CATEGORIES).size).toBe(8)
  })

  it('has a label for every category', () => {
    for (const cat of BILL_CATEGORIES) {
      expect(CATEGORY_LABELS[cat]).toBeTruthy()
    }
  })

  it('has a color class for every category', () => {
    for (const cat of BILL_CATEGORIES) {
      expect(CATEGORY_COLORS[cat]).toBeTruthy()
    }
  })

  it('has an icon component for every category', () => {
    for (const cat of BILL_CATEGORIES) {
      expect(CATEGORY_ICONS[cat]).toBeTruthy()
    }
  })

  it('does not define extra keys beyond the category list', () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...BILL_CATEGORIES].sort())
  })
})
