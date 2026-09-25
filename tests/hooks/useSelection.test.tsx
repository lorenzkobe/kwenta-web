import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSelection, type Selection } from '@/hooks/useSelection'

let container: HTMLDivElement
let root: Root
let latest: Selection
const out: { current: Selection | null } = { current: null }

function Probe({ resetKey, onValue }: { resetKey: string; onValue: (s: Selection) => void }) {
  const selection = useSelection(resetKey)
  useEffect(() => {
    onValue(selection)
  })
  return null
}

async function render(resetKey: string) {
  const onValue = (s: Selection) => {
    out.current = s
  }
  await act(async () => root.render(<Probe resetKey={resetKey} onValue={onValue} />))
  latest = out.current!
}

async function run(fn: () => void) {
  await act(async () => fn())
  latest = out.current!
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('useSelection', () => {
  it('starts inactive with nothing selected', async () => {
    await render('g1')
    expect(latest.active).toBe(false)
    expect(latest.selected.size).toBe(0)
  })

  it('toggling the same id twice leaves it unselected', async () => {
    await render('g1')
    await run(() => latest.start())
    await run(() => latest.toggle('a'))
    expect([...latest.selected]).toEqual(['a'])
    await run(() => latest.toggle('a'))
    expect(latest.selected.size).toBe(0)
  })

  it('selectAll replaces the selection and stop clears it', async () => {
    await render('g1')
    await run(() => latest.start())
    await run(() => latest.selectAll(['a', 'b']))
    expect([...latest.selected].sort()).toEqual(['a', 'b'])
    await run(() => latest.stop())
    expect(latest.active).toBe(false)
    expect(latest.selected.size).toBe(0)
    await run(() => latest.start())
    expect(latest.selected.size).toBe(0)
  })

  it('resets when the subject changes, so group A picks never carry into group B', async () => {
    await render('g1')
    await run(() => latest.start())
    await run(() => latest.toggle('a'))
    await render('g2')
    expect(latest.active).toBe(false)
    expect(latest.selected.size).toBe(0)
  })

  it('does not bring back the old picks on the way back (A -> B -> A)', async () => {
    await render('g1')
    await run(() => latest.start())
    await run(() => latest.toggle('a'))
    await render('g2')
    await render('g1')
    expect(latest.active).toBe(false)
    expect(latest.selected.size).toBe(0)
  })
})
