import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { FormFactor } from '@tapflowio/protocol'

/** `k=v` and `k = v` both occur in real config.ini files, with CRLF on some. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Images that are neither a phone nor a tablet, though their screen size would say one or the other. */
const NOT_HANDHELD = /(^|[,\s])(android-tv|google-tv|android-wear[\w-]*|wear|android-desktop|android-automotive[\w-]*)(?=$|[,\s])/

/**
 * What kind of device an AVD is, from its config.ini — or nothing when it cannot tell.
 *
 * Smallest width in dp against 600, Android's own tablet line (`sw600dp`); `hw.lcd.density` is dpi.
 * A hinge is read first, because an unfolded book-style foldable is past that line (Pixel 9 Pro Fold:
 * 2076×2152 at 390, 852 dp) — but only a large one is `foldable`. A flip unfolds to a tall phone
 * (about 360 dp) and is drawn as one, and a "Resizable" AVD carries a hinge to pose as a foldable
 * without being one, so it is read by its screen. A hinge key that says `no` is not a hinge.
 */
export function classifyAvd(cfg: Record<string, string>): FormFactor | undefined {
  if (NOT_HANDHELD.test(`${cfg['tag.id'] ?? ''},${cfg['tag.ids'] ?? ''}`)) return undefined
  const w = Number(cfg['hw.lcd.width'])
  const h = Number(cfg['hw.lcd.height'])
  const dpi = Number(cfg['hw.lcd.density'])
  if (!(w > 0 && h > 0 && dpi > 0)) return undefined
  const large = (Math.min(w, h) * 160) / dpi >= 600
  const hinge = !('hw.resizable.configs' in cfg)
    && (cfg['hw.sensor.hinge'] === 'yes' || Number(cfg['hw.sensor.hinge.count']) > 0)
  if (hinge) return large ? 'foldable' : 'phone'
  return large ? 'tablet' : 'phone'
}

/**
 * Where the emulator looks for AVDs, in its order — read from its binary, which does not consult
 * `ANDROID_USER_HOME` at all; that one is tried only before the default. Searched per name rather
 * than picking one home, so a name `emulator -list-avds` found is looked up where it came from.
 */
export function avdHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = []
  if (env.ANDROID_AVD_HOME) out.push(env.ANDROID_AVD_HOME)
  if (env.ANDROID_SDK_HOME) out.push(join(env.ANDROID_SDK_HOME, 'avd'), join(env.ANDROID_SDK_HOME, '.android', 'avd'))
  if (env.ANDROID_EMULATOR_HOME) out.push(join(env.ANDROID_EMULATOR_HOME, 'avd'))
  if (env.ANDROID_PREFS_ROOT) out.push(join(env.ANDROID_PREFS_ROOT, '.android', 'avd'))
  if (env.ANDROID_USER_HOME) out.push(join(env.ANDROID_USER_HOME, 'avd'))
  out.push(join(home, '.android', 'avd'))
  return out
}

interface Files {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
}
const realFiles: Files = { existsSync, readFileSync: (p, e) => readFileSync(p, e) }

/**
 * An AVD's form factor by name, or nothing when its files cannot be found or read. Never throws: it
 * runs inside `connect()`, and a skeleton is not worth a Mac dropping out of the device list.
 */
export function formFactorOf(
  avdName: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fs: Files = realFiles,
): FormFactor | undefined {
  try {
    for (const dir of avdHomes(env, home)) {
      const ini = join(dir, `${avdName}.ini`)
      if (!fs.existsSync(ini)) continue
      // `path=` is absolute and goes stale when a home directory is renamed or the AVDs are copied
      // over; the emulator still finds the AVD beside its .ini, so this does too.
      const named = parseIni(fs.readFileSync(ini, 'utf8')).path
      const candidates = [named, join(dir, `${avdName}.avd`)].filter((p): p is string => Boolean(p))
      const config = candidates.map((d) => join(d, 'config.ini')).find((p) => fs.existsSync(p))
      return config ? classifyAvd(parseIni(fs.readFileSync(config, 'utf8'))) : undefined
    }
  } catch {
    // Unreadable is the same as unknown.
  }
  return undefined
}
