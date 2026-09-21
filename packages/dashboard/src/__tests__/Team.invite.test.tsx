import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { TeamSettings } from '@/src/pages/settings/Team'
import { resetTeammateBasesForTests } from '@/lib/publicLink'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

interface InviteReply { token: string; emailSent: boolean; inviteUrl: string | null }
const noHost = { lanHost: null, port: 4000, publicBaseUrl: null, agentRelayUrl: null }

// The page fires several requests at once, so dispatch on URL (dashboard AGENTS.md).
function stubFetch(invite: InviteReply, host: object = noHost) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/api/v1/relay/host')) return Promise.resolve({ ok: true, json: () => Promise.resolve(host) })
    if (url.includes('/api/v1/team/invite') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve(invite) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** `undefined` is what a plain-HTTP LAN page has: no `navigator.clipboard` at all. */
function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: writeText ? { writeText } : undefined })
}

async function sendInvite() {
  render(<TeamSettings />)
  await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
  await userEvent.type(screen.getByLabelText(/email/i), 'qa@test.local')
  await userEvent.click(screen.getByRole('button', { name: /generate invite link/i }))
}

describe('Team — the invite link a teammate gets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTeammateBasesForTests()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('a dialog opened and abandoned says nothing, and closes on the first press', async () => {
    // **The reported bug was a dialog one, and the regression tests for it were on a page.** Radix
    // autofocuses the first control when this dialog opens — nothing else in the app does, the four
    // auth *pages* do not — so leaving without typing is one pointer move away. Under the old
    // `mode: 'onBlur'` that drew `Enter a valid email`, and the inserted line moved what was below
    // it, so the press that should have dismissed the dialog landed on nothing and it took a second.
    stubFetch({ token: 't', emailSent: false, inviteUrl: null })
    render(<TeamSettings />)
    await userEvent.click(await screen.findByRole('button', { name: /invite member/i }))
    const email = screen.getByLabelText(/email/i)
    expect(email).toHaveFocus()

    await userEvent.tab()
    expect(screen.queryByText(/valid email/i)).toBeNull()

    // The first press, not the second: this is the half a "no message appears" assertion misses.
    // The dialog's close is the header X, whose accessible name is its `sr-only` "Close".
    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows and copies the link the relay mailed, not the browser address (#788)', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    stubClipboard(writeText)
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    const field = await screen.findByDisplayValue('http://192.168.219.113:4000/invite?token=t')
    expect(writeText).toHaveBeenCalledWith('http://192.168.219.113:4000/invite?token=t')
    expect(screen.queryByDisplayValue(/localhost:3000/)).not.toBeInTheDocument()
    // The form and its focused button are gone; focus lands on the link, where it can be selected by hand.
    await waitFor(() => expect(field).toHaveFocus())
  })

  it('builds the link from the teammate base when the relay offers none', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: null }, { ...noHost, lanHost: '192.168.0.50' })

    await sendInvite()

    expect(await screen.findByDisplayValue('http://192.168.0.50:4000/invite?token=t')).toBeInTheDocument()
  })

  it('says the link was copied only when it was', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    expect(await screen.findByText(/invite link copied to clipboard:/i)).toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/copied/i))
    // Toasts render outside the dialog, which hides them from assistive technology; the dialog says it too.
    expect(screen.getByRole('status')).toHaveTextContent(/invite link copied to clipboard\./i)
  })

  it('does not claim a copy the browser refused', async () => {
    stubClipboard(vi.fn(async (_text: string) => { throw new Error('denied') }))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    // Wait for the outcome of the copy before asserting what was not said.
    expect(await screen.findByText(/copy this invite link/i)).toBeInTheDocument()
    expect(screen.queryByText(/invite link copied to clipboard/i)).not.toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.warning).mock.calls[0][0]).not.toMatch(/copied/i)
    expect(screen.getByRole('status')).toHaveTextContent(/copy the invite link/i)
    expect(screen.getByRole('status')).not.toHaveTextContent(/copied/i)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('treats a page with no clipboard API (plain HTTP) as a refused copy, not a failed invite', async () => {
    stubClipboard(undefined)
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })

    await sendInvite()

    expect(await screen.findByText(/copy this invite link/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('http://192.168.219.113:4000/invite?token=t')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says a failed invite inside the dialog, where assistive technology can hear it', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(
      url.includes('/api/v1/team/invite') && init?.method === 'POST'
        ? { ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }
        : { ok: true, json: () => Promise.resolve([]) },
    )))

    await sendInvite()

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Failed to create invite link.'))
    expect(toast.error).toHaveBeenCalledWith('Failed to create invite link')
  })

  // Done closes through a state setter, which a controlled Radix dialog does not report through
  // onOpenChange — so without routing it through the reset, the next open showed the last invite.
  it('opens on a fresh form after Done, not on the previous invite or its status', async () => {
    stubClipboard(vi.fn(async (_text: string) => {}))
    stubFetch({ token: 't', emailSent: false, inviteUrl: 'http://192.168.219.113:4000/invite?token=t' })
    await sendInvite()
    await screen.findByDisplayValue('http://192.168.219.113:4000/invite?token=t')

    await userEvent.click(screen.getByRole('button', { name: /^done$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /invite member/i }))

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(/invite\?token=t/)).not.toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
