import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

// The boot skeleton is drawn before the device's chrome arrives, from what the device list said about
// it. `deviceSkeleton.test.ts` holds the sizes; this holds that the viewer uses them — a phone-shaped
// placeholder for every device was what this replaced. Harness as in `DeviceViewer.reboot.test.tsx`.
vi.mock('@/hooks/useRelay', () => ({
  useRelay: (_onMessage: (msg: BrowserInbound) => void) => ({ send: vi.fn(), connected: true }),
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const placeholder = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="device-skeleton"]')!

describe('DeviceViewer — the boot skeleton takes the device\'s shape', () => {
  // Mutations: ignore `formFactor` (both wide cases fail); ignore `platform` (the Android tablet is
  // drawn upright).
  it.each([
    [undefined, 'ios', 324, 720],
    ['tablet', 'ios', 540, 720],
    ['tablet', 'android', 720, 450],
    ['foldable', 'android', 540, 720],
  ] as const)('draws %s on %s at %i×%i', (formFactor, platform, width, height) => {
    const { container } = render(<DeviceViewer sessionId="s" deviceId="d" formFactor={formFactor} platform={platform} />)
    expect(placeholder(container).style.width).toBe(`${width}px`)
    expect(placeholder(container).style.height).toBe(`${height}px`)
  })
})
