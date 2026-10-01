import { describe, expect, it } from 'vitest'
import { skeletonSize } from '../../lib/deviceSkeleton'

// The shape drawn while a device boots, before its chrome arrives. Two shapes, by decision: a phone,
// and a tablet — an iPad upright, an Android tablet on its side (the SDK's current tablet profile
// defaults to landscape, and the viewer draws it about 720×450). A foldable boots unfolded, which is
// upright or near square (Pixel 9 Pro Fold ≈ 695×720), so it takes the upright tablet shape on any
// platform. The long side stays 720.
describe('skeletonSize', () => {
  it('draws a phone for a phone, and for anything it does not know', () => {
    expect(skeletonSize('phone', 'ios')).toEqual({ width: 324, height: 720 })
    expect(skeletonSize(undefined, 'android')).toEqual({ width: 324, height: 720 })
    expect(skeletonSize('watch' as never, 'ios')).toEqual({ width: 324, height: 720 })
  })

  // Mutation: one tablet shape for both platforms. The Android case fails.
  it('turns a tablet the way its platform boots it', () => {
    expect(skeletonSize('tablet', 'ios')).toEqual({ width: 540, height: 720 })
    expect(skeletonSize('tablet', 'android')).toEqual({ width: 720, height: 450 })
  })

  // Mutations: draw a foldable as a phone; or turn it on its side with the Android tablets, which a
  // first version did and review measured as further from its real shape than the phone.
  it('draws a foldable as an upright tablet', () => {
    expect(skeletonSize('foldable', 'android')).toEqual({ width: 540, height: 720 })
  })
})
