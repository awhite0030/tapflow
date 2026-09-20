import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// next-themes 모킹
vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}))

import { Setup } from '@/src/pages/Setup'

function renderSetup(initialPath = '/setup') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Setup 페이지', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('미초기화 상태 → 폼 렌더링', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: false }), { status: 200 }),
    )
    renderSetup()
    expect(screen.getByLabelText(/admin email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument()
  })

  describe('검증은 제출 전에는 말하지 않는다', () => {
    // **A field that was focused and left is not a field the user filled in wrongly.** Every form
    // here ran `mode: 'onBlur'`, which validates on blur whether or not anything was typed, so the
    // first field — focused on open, in a dialog by Radix and by hand elsewhere — answered with
    // `Enter a valid email` the moment the pointer went anywhere else. In a dialog that also cost
    // the first click on Close: the message enters the layout, what is below it moves, and a
    // `click` needs its press and release on the same element.
    //
    // Nothing caught it. Removing `mode: 'onBlur'` from all nine forms left 640 tests green, which
    // is the reason these exist rather than a note in a changelog.
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ initialized: false }), { status: 200 }),
      )
    })

    it('빈 첫 필드에서 포커스가 빠져도 에러가 뜨지 않는다', async () => {
      renderSetup()
      const email = screen.getByLabelText(/admin email/i)
      email.focus()
      await userEvent.tab()

      expect(email).not.toHaveFocus()
      expect(screen.queryByText('Enter a valid email')).toBeNull()
    })

    it('무언가 입력했다가 지우고 떠나도 제출 전에는 조용하다', async () => {
      // The weaker half of the same rule, and the one a `dirtyFields` guard would have got wrong:
      // what decides is that the form has not been submitted, not whether the field was touched.
      renderSetup()
      const email = screen.getByLabelText(/admin email/i)
      await userEvent.type(email, 'not-an-email')
      await userEvent.tab()

      expect(screen.queryByText('Enter a valid email')).toBeNull()
    })

    it('제출하면 비로소 말한다', async () => {
      renderSetup()
      await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

      expect(await screen.findByText('Enter a valid email')).toBeInTheDocument()
      expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
    })

    it('제출 실패 시 포커스가 간 입력이 자기 에러를 가리킨다', async () => {
      // **Submit is now the only moment an error appears, and react-hook-form moves focus to the
      // first invalid input at that moment.** Focus alone announces "Admin email, edit text" and
      // nothing about what is wrong, so the input has to name the message. Before this the messages
      // were bare sibling `<p>`s with no id — which on-blur validation had been hiding, because an
      // error the user could already see had arrived long before any submit.
      renderSetup()
      await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

      const email = screen.getByLabelText(/admin email/i)
      await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
      const describedBy = email.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(document.getElementById(describedBy!)).toHaveTextContent('Enter a valid email')
    })

    it('유효한 필드는 무효로 표시되지 않는다', async () => {
      // The other half: `aria-invalid` has to come back off, or every field reads as broken once
      // one of them was.
      renderSetup()
      await userEvent.type(screen.getByLabelText(/admin email/i), 'someone@example.com')
      await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

      const email = screen.getByLabelText(/admin email/i)
      await waitFor(() => expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('aria-invalid', 'true'))
      expect(email).toHaveAttribute('aria-invalid', 'false')
    })

    it('제출 뒤에는 고치는 즉시 사라진다', async () => {
      // `reValidateMode` defaults to `onChange`, so the live correction the old `onBlur` bought is
      // still there — it starts once the user has asked to submit rather than before.
      renderSetup()
      await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))
      await screen.findByText('Enter a valid email')

      await userEvent.type(screen.getByLabelText(/admin email/i), 'someone@example.com')

      await waitFor(() => expect(screen.queryByText('Enter a valid email')).toBeNull())
    })
  })

  it('이미 초기화됨 → /login 리다이렉트', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: true }), { status: 200 }),
    )
    renderSetup()
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
  })

  it('폼 제출 성공 → /api/v1/auth/init 호출 후 /login 이동', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialized: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 201 }))

    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'securepass')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'securepass')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/v1/auth/init', expect.objectContaining({ method: 'POST' })),
    )
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument())
  })

  it('비밀번호 불일치 → 에러 메시지, API 미호출', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: false }), { status: 200 }),
    )
    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'password1')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'password2')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() => expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument())
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // status check만
  })

  it('API 실패 → 에러 메시지 표시', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ initialized: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Already initialized' }), { status: 403 }))

    renderSetup()
    await userEvent.type(screen.getByLabelText(/admin email/i), 'admin@team.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'securepass')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'securepass')
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }))

    await waitFor(() => expect(screen.getByText('Already initialized')).toBeInTheDocument())
  })
})
