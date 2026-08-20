import { describe, it, expect } from 'vitest'
import { buildEmulatorArgs } from '../EmulatorLauncher'

describe('buildEmulatorArgs', () => {
  it('includes -no-audio by default (audio off — video path unchanged)', () => {
    const args = buildEmulatorArgs('Pixel', 8554)
    expect(args).toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('drops -no-audio when audio is enabled, leaving all other args intact', () => {
    const args = buildEmulatorArgs('Pixel', 8554, { audio: true })
    expect(args).not.toContain('-no-audio')
    expect(args).toEqual(['-avd', 'Pixel', '-no-snapshot', '-no-window', '-gpu', 'host', '-grpc', '8554'])
  })

  it('omits -grpc when no port given', () => {
    const args = buildEmulatorArgs('Pixel')
    expect(args).not.toContain('-grpc')
    expect(args).toContain('-no-audio')
  })

  it('explicit audio:false keeps -no-audio (parity with default)', () => {
    expect(buildEmulatorArgs('Pixel', 8554, { audio: false })).toContain('-no-audio')
  })

  // #447: the counterpart to iOS's `simctl erase`. `-no-snapshot` above is a **cold boot** — it skips
  // the snapshot and keeps `userdata`, so nothing here wiped anything before this flag.
  describe('wipeData', () => {
    it('adds -wipe-data, leaving every other arg where it was', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true })
      expect(args).toEqual(
        ['-avd', 'Pixel', '-no-audio', '-no-snapshot', '-no-window', '-gpu', 'host', '-wipe-data', '-grpc', '8554'],
      )
    })

    it('is absent by default, so an ordinary boot keeps userdata', () => {
      expect(buildEmulatorArgs('Pixel', 8554)).not.toContain('-wipe-data')
      expect(buildEmulatorArgs('Pixel', 8554, { wipeData: false })).not.toContain('-wipe-data')
    })

    // The two options are independent knobs and a session can arm both — asserted because the
    // obvious implementation (one `if/else` over `opts`) passes each of the tests above alone.
    it('composes with audio rather than replacing it', () => {
      const args = buildEmulatorArgs('Pixel', 8554, { wipeData: true, audio: true })
      expect(args).toContain('-wipe-data')
      expect(args).not.toContain('-no-audio')
    })
  })
})
