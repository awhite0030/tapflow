import type { FormFactor } from '@tapflowio/protocol'

const PHONE = { width: 324, height: 720 }
const UPRIGHT_TABLET = { width: 540, height: 720 }

/**
 * The shape the viewer draws while a device boots, before its chrome says how big it really is.
 *
 * Two shapes, by decision: a phone, and a tablet. An iPad comes up upright (3:4, between the iPad Pro
 * 13's 0.77 and the mini's 0.69). An Android tablet comes up on its side — the SDK's current tablet
 * profile defaults to landscape, and the real viewer draws one at about 720×450 — so its skeleton
 * does too. Not every Android tablet: an old Nexus 7 profile or the 7.4" Rollable is portrait and is
 * still drawn on its side, because only the form factor is on the wire, not the orientation.
 *
 * A foldable takes the upright tablet shape on both platforms. It boots unfolded, and unfolded it is
 * upright or near square, not wide: the Pixel 9 Pro Fold draws at about 695×720 and the SDK's 7.6"
 * Fold-in at 576×720. Only the first Pixel Fold is wider than tall. Turning it on its side with the
 * Android tablets, as a first version did, put it further from its real shape than the phone was.
 *
 * Anything else, or nothing, is a phone: what this drew for every device before there was a form
 * factor. The long side is the viewers' own limit, 720.
 */
export function skeletonSize(formFactor: FormFactor | undefined, platform: string): { width: number; height: number } {
  if (formFactor === 'foldable') return UPRIGHT_TABLET
  if (formFactor !== 'tablet') return PHONE
  return platform === 'android' ? { width: 720, height: 450 } : UPRIGHT_TABLET
}
