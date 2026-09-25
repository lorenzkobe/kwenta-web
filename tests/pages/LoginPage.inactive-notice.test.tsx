import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { INACTIVE_ACCOUNT_MESSAGE_KEY } from '@/lib/auth-session-flags'
import { LEGACY_INACTIVE_NOTICE, messageForAccountNotActive } from '@/lib/account-gate-messages'

/**
 * The login notice after an account-status sign-out. The flag now holds the status the server
 * reported, so an unconfirmed email and a deactivated account read differently; the legacy '1'
 * written by an older build keeps the generic notice.
 */

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    signUp: vi.fn(),
    resetPassword: vi.fn(),
    loading: false,
    user: null,
  }),
}))

import { LoginPage } from '@/pages/LoginPage'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  sessionStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderWithFlag(flag: string) {
  sessionStorage.setItem(INACTIVE_ACCOUNT_MESSAGE_KEY, flag)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    ),
  )
  return container.textContent ?? ''
}

describe('LoginPage — inactive-account notice', () => {
  it('an unconfirmed account is asked to confirm its email', async () => {
    const text = await renderWithFlag('unconfirmed')
    expect(text).toContain(messageForAccountNotActive('unconfirmed'))
    expect(text).not.toContain(LEGACY_INACTIVE_NOTICE)
  })

  it('an inactive account is pointed to an administrator', async () => {
    const text = await renderWithFlag('inactive')
    expect(text).toContain(messageForAccountNotActive('inactive'))
    expect(text).not.toContain(messageForAccountNotActive('unconfirmed'))
  })

  it('the legacy flag keeps the generic notice', async () => {
    const text = await renderWithFlag('1')
    expect(text).toContain(LEGACY_INACTIVE_NOTICE)
  })

  it('the flag is consumed', async () => {
    await renderWithFlag('inactive')
    expect(sessionStorage.getItem(INACTIVE_ACCOUNT_MESSAGE_KEY)).toBeNull()
  })
})
