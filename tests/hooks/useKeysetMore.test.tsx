import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useKeysetMore, type KeysetPage } from '@/hooks/useKeysetMore'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

/**
 * useKeysetMore resets itself when its list changes (H8.1). Hand-made rows: { id } objects, the
 * least a cursor needs; the first pages below are the "cached read" the caller would hand in.
 */

type Row = { id: string }
const rows = (prefix: string, n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }))
const PAGES: Record<string, KeysetPage<Row>> = {
  a: { rows: rows('a', 2), matching: 6 },
  b: { rows: rows('b', 2), matching: 5 },
}

type View = ReturnType<typeof useKeysetMore<Row, string>>

let container: HTMLDivElement
let root: Root
let view: View
let fetchAfter: ReturnType<typeof vi.fn>
let release: Array<() => void>

function Probe({ listKey }: { listKey: string }) {
  const result = useKeysetMore<Row, string>({
    userId: 'u1',
    listKey,
    page: PAGES[listKey],
    pageFromCache: false,
    pageSize: 2,
    maxPerCall: 10,
    cursorOf: (r) => r.id,
    fetchAfter: (after, limit) => fetchAfter(after, limit),
    errorMessage: 'failed',
  })
  useEffect(() => {
    view = result
  })
  return null
}

const show = (listKey: string) => act(async () => root.render(<Probe listKey={listKey} />))
const ids = () => view.rows.map((r) => r.id).join(',')

beforeEach(() => {
  release = []
  fetchAfter = vi.fn(
    (after: string) =>
      new Promise<KeysetPage<Row>>((resolve) => {
        release.push(() => resolve({ rows: [{ id: `${after}-next` }], matching: 6 }))
      }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('useKeysetMore list change', () => {
  it('H8.1: loaded rows belong to their list: a new key starts again from its own first page', async () => {
    await show('a')
    await act(async () => view.showMore())
    await act(async () => release[0]())
    expect(ids()).toBe('a1,a2,a2-next')

    await show('b')

    expect(ids()).toBe('b1,b2')
    expect(view.loadingMore).toBe(false)
    expect(view.remaining).toBe(3)
  })

  it('H8.1: an answer landing after the list changed is dropped and never re-issued on the new list', async () => {
    await show('a')
    await act(async () => view.showMore())
    expect(fetchAfter).toHaveBeenCalledTimes(1)

    await show('b')
    await act(async () => release[0]())

    expect(fetchAfter).toHaveBeenCalledTimes(1)
    expect(ids()).toBe('b1,b2')
    expect(view.loadingMore).toBe(false)
  })

  it('H8.1: Show more is usable at once on the new list', async () => {
    await show('a')
    await act(async () => view.showMore())
    await show('b')

    await act(async () => view.showMore())

    expect(fetchAfter).toHaveBeenLastCalledWith('b2', 2)
  })
})
