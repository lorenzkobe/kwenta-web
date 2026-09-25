import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

/**
 * The nickname editor after the rename went cloud-first (`renameSelf`). A refusal now throws out
 * of `updateDisplayName`; before this the page had no catch, so the editor stayed open with no
 * word of why and the rejection went unhandled. It must say so and keep the typed name.
 */

const h = vi.hoisted(() => ({
  updateDisplayName: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: h.toastError, success: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'ME' }, isAuthenticated: true, updateDisplayName: h.updateDisplayName }),
}))
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'ME', profile: { id: 'ME', display_name: 'Old name' } }),
}))
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (_q: unknown, _deps: unknown, fallback?: unknown) => fallback,
}))
vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: null, error: null })), auth: { signOut: vi.fn() } },
}))
vi.mock('@/sync/sync-service', () => ({
  hasUnsyncedLocalDataForUser: async () => false,
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] })),
}))
vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/sync/write-queue', () => ({
  dismissQueuedWrite: vi.fn(),
  retryQueuedWrite: vi.fn(),
  hasUnsentWrites: vi.fn(async () => false),
  sendUnsentWritesBeforeWipe: vi.fn(async () => ({ errors: [], stillUnsent: false })),
}))
vi.mock('@/components/settings/RepairDataPanel', () => ({ RepairDataPanel: () => null }))

import { SettingsPage } from '@/pages/SettingsPage'

let container: HTMLDivElement
let root: Root

const iconButton = (icon: string) =>
  container.querySelector(`svg.lucide-${icon}`)?.closest('button') as HTMLButtonElement | null
const nameInput = () => container.querySelector('input[maxlength="50"]') as HTMLInputElement | null

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renameTo(value: string) {
  await act(async () => iconButton('pencil')!.click())
  await act(async () => typeInto(nameInput()!, value))
  await act(async () => iconButton('check')!.click())
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(async () => {
  h.updateDisplayName.mockReset()
  h.toastError.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('SettingsPage — renaming yourself', () => {
  it('a refused rename toasts the reason and keeps the editor open with the typed name', async () => {
    h.updateDisplayName.mockRejectedValue(new Error('The cloud did not store this change. Nothing was saved.'))

    await renameTo('New name')

    expect(h.updateDisplayName).toHaveBeenCalledWith('New name')
    expect(h.toastError).toHaveBeenCalledWith('The cloud did not store this change. Nothing was saved.')
    expect(nameInput()?.value).toBe('New name')
  })

  it('an accepted rename closes the editor without an error', async () => {
    h.updateDisplayName.mockResolvedValue(undefined)

    await renameTo('New name')

    expect(h.toastError).not.toHaveBeenCalled()
    expect(nameInput()).toBeNull()
  })
})
