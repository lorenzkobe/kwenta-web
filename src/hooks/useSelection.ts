import { useCallback, useState } from 'react'

export interface Selection {
  active: boolean
  selected: ReadonlySet<string>
  start: () => void
  stop: () => void
  toggle: (id: string) => void
  selectAll: (ids: string[]) => void
}

interface State {
  key: string
  active: boolean
  selected: ReadonlySet<string>
}

const idle = (key: string): State => ({ key, active: false, selected: new Set() })

/**
 * A list's "select people" mode. `resetKey` names the subject (group id, user id): a route change
 * such as /groups/a → /groups/b reuses the page instance, and picks made in one group must not be
 * shared from the next. The reset is derived during render, so no frame shows the old selection.
 */
export function useSelection(resetKey: string): Selection {
  const [stored, setState] = useState<State>(() => idle(resetKey))
  // Storing the reset (not just rendering idle) matters for A → B → A: otherwise A's old picks
  // would reappear on the way back.
  if (stored.key !== resetKey) setState(idle(resetKey))
  const state = stored.key === resetKey ? stored : idle(resetKey)

  const update = useCallback(
    (next: (s: State) => State) =>
      setState((prev) => next(prev.key === resetKey ? prev : idle(resetKey))),
    [resetKey],
  )

  const start = useCallback(() => update((s) => ({ ...s, active: true })), [update])
  const stop = useCallback(() => update(() => idle(resetKey)), [update, resetKey])
  const toggle = useCallback(
    (id: string) =>
      update((s) => {
        const selected = new Set(s.selected)
        if (!selected.delete(id)) selected.add(id)
        return { ...s, selected }
      }),
    [update],
  )
  const selectAll = useCallback(
    (ids: string[]) => update((s) => ({ ...s, selected: new Set(ids) })),
    [update],
  )

  return { active: state.active, selected: state.selected, start, stop, toggle, selectAll }
}
