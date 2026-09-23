import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveBuildFile } from '../lib/buildFiles.js'

/**
 * **A build's file is found wherever its data directory went** (#836). Each case is a data directory
 * that moved after the build was uploaded — the stored path names the old location.
 */

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-buildfiles-')))
  dirs.push(d)
  return d
}
const put = (file: string, body = 'APK'): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('resolveBuildFile', () => {
  it('answers the stored path on an install that never moved', () => {
    const uploads = path.join(tmp(), 'uploads')
    const stored = put(path.join(uploads, 'builds', '1789-abcd1234_app.apk'))
    expect(resolveBuildFile(stored, uploads)).toBe(stored)
  })

  it('finds the file in this install when the stored path is gone', () => {
    const oldUploads = path.join(tmp(), '.tapflow-data', 'uploads')
    const stored = path.join(oldUploads, 'builds', '1789-abcd1234_app.apk')
    const uploads = path.join(tmp(), '.tapflow', 'data', 'uploads')
    const moved = put(path.join(uploads, 'builds', '1789-abcd1234_app.apk'))
    expect(resolveBuildFile(stored, uploads)).toBe(moved)
  })

  it('prefers this install\'s copy when the old directory was copied and left behind', () => {
    // Reading the stored path here would serve another install's file, and the purge would delete it.
    const oldUploads = path.join(tmp(), 'uploads')
    const stored = put(path.join(oldUploads, 'builds', '1789-abcd1234_app.apk'), 'OLD')
    const uploads = path.join(tmp(), 'uploads')
    const copy = put(path.join(uploads, 'builds', '1789-abcd1234_app.apk'), 'NEW')
    expect(resolveBuildFile(stored, uploads)).toBe(copy)
  })

  it('answers null when the file is gone from both places', () => {
    const uploads = path.join(tmp(), 'uploads')
    expect(resolveBuildFile(path.join(tmp(), 'builds', 'gone.apk'), uploads)).toBeNull()
  })

  it('looks only in builds/ when the stored path is gone, whatever the stored value names', () => {
    // Files sit where a lookup that followed the stored directories, or walked up from builds/,
    // would land. The fallback takes the name alone, so it finds none of them.
    const root = tmp()
    const uploads = path.join(root, 'uploads')
    fs.mkdirSync(path.join(uploads, 'builds'), { recursive: true })
    put(path.join(uploads, 'secret'))
    put(path.join(root, 'secret'))
    const stored = path.join(root, 'gone', 'builds', '..', '..', 'nowhere', 'secret')
    expect(resolveBuildFile(stored, uploads)).toBeNull()
  })

  it('never answers a directory', () => {
    const uploads = path.join(tmp(), 'uploads')
    fs.mkdirSync(path.join(uploads, 'builds'), { recursive: true })
    // basename('x/..') is '..', which would name uploads/ itself.
    expect(resolveBuildFile(path.join(uploads, 'builds', 'x', '..'), uploads)).toBeNull()
  })
})
