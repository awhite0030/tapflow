import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  AGENTS_BLOCK, MARKER_BEGIN, MARKER_END, upsertBlock, importsAgentsMd, claudeMdOnPath,
  isTapflowOwned, scaffoldAgentDocs,
} from '../../lib/agentDocs.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-agentdocs-'))
  dirs.push(d)
  return fs.realpathSync(d)
}
const write = (file: string, body: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const BLOCK = `${MARKER_BEGIN}\nnew\n${MARKER_END}\n`

describe('upsertBlock', () => {
  it('creates the file content when there is none', () => {
    expect(upsertBlock(null, BLOCK)).toEqual({ result: 'created', content: BLOCK })
  })

  it('appends after existing content, byte for byte', () => {
    const { result, content } = upsertBlock('# Mine\nrule\n', BLOCK)
    expect(result).toBe('appended')
    expect(content).toBe(`# Mine\nrule\n\n${BLOCK}`)
  })

  it('appends to a file with no trailing newline, and fills an empty one', () => {
    expect(upsertBlock('# Mine', BLOCK).content).toBe(`# Mine\n\n${BLOCK}`)
    expect(upsertBlock('', BLOCK)).toEqual({ result: 'created', content: BLOCK })
  })

  it('replaces only what is between the markers', () => {
    const existing = `# Mine\n\n${MARKER_BEGIN}\nold\n${MARKER_END}\n\n## After\n`
    const { result, content } = upsertBlock(existing, BLOCK)
    expect(result).toBe('updated')
    expect(content).toBe(`# Mine\n\n${MARKER_BEGIN}\nnew\n${MARKER_END}\n\n## After\n`)
  })

  it('reports unchanged when the block is already what it should be', () => {
    const existing = `# Mine\n\n${BLOCK.trimEnd()}\n`
    expect(upsertBlock(existing, BLOCK).result).toBe('unchanged')
  })

  it('takes the block verbatim, including `$` sequences', () => {
    // `String.replace` reads `$&` and `` $` `` in the replacement as substitution patterns.
    const dollars = `${MARKER_BEGIN}\ncost: $& and $\`and $'\n${MARKER_END}\n`
    const { content } = upsertBlock(`a\n\n${MARKER_BEGIN}\nold\n${MARKER_END}\n`, dollars)
    expect(content).toContain("cost: $& and $`and $'")
  })

  it('leaves a file with damaged markers alone', () => {
    const onlyBegin = `# Mine\n${MARKER_BEGIN}\n`
    const twice = `${MARKER_BEGIN}\na\n${MARKER_END}\n${MARKER_BEGIN}\nb\n${MARKER_END}\n`
    const reversed = `${MARKER_END}\nstuff\n${MARKER_BEGIN}\n`
    for (const broken of [onlyBegin, twice, reversed]) {
      expect(upsertBlock(broken, BLOCK)).toEqual({ result: 'malformed', content: broken })
    }
  })
})

describe('importsAgentsMd', () => {
  it('counts an import on its own line, mid-line, or written `@./AGENTS.md`', () => {
    expect(importsAgentsMd('@AGENTS.md\n')).toBe(true)
    expect(importsAgentsMd('Rules: see @AGENTS.md for the project\n')).toBe(true)
    expect(importsAgentsMd('@./AGENTS.md\n')).toBe(true)
  })

  it('does not count one inside a code span or a fenced block', () => {
    expect(importsAgentsMd('Add `@AGENTS.md` to this file.\n')).toBe(false)
    expect(importsAgentsMd('```md\n@AGENTS.md\n```\n')).toBe(false)
    expect(importsAgentsMd('~~~\n@AGENTS.md\n~~~\n')).toBe(false)
  })

  it('does not count a different file', () => {
    expect(importsAgentsMd('@AGENTS.md.bak\n')).toBe(false)
    expect(importsAgentsMd('@docs/AGENTS.md\n')).toBe(false)
  })
})

describe('claudeMdOnPath', () => {
  it('finds all three names, here and above', () => {
    const root = tmp()
    const nested = path.join(root, 'apps', 'mobile')
    fs.mkdirSync(nested, { recursive: true })
    write(path.join(root, 'CLAUDE.md'), 'x')
    write(path.join(root, '.claude', 'CLAUDE.md'), 'x')
    write(path.join(nested, 'CLAUDE.local.md'), 'x')
    expect(claudeMdOnPath(nested, tmp())).toEqual([
      path.join(nested, 'CLAUDE.local.md'),
      path.join(root, 'CLAUDE.md'),
      path.join(root, '.claude', 'CLAUDE.md'),
    ])
  })

  it('leaves out the user-level ~/.claude/CLAUDE.md, which loads alongside AGENTS.md', () => {
    const home = tmp()
    write(path.join(home, '.claude', 'CLAUDE.md'), 'x')
    const dir = path.join(home, 'project')
    fs.mkdirSync(dir)
    expect(claudeMdOnPath(dir, home)).toEqual([])
  })
})

describe('isTapflowOwned', () => {
  it('counts ~/.tapflow, and a directory holding only tapflow files', () => {
    const home = tmp()
    fs.mkdirSync(path.join(home, '.tapflow', 'bin'), { recursive: true })
    expect(isTapflowOwned(path.join(home, '.tapflow'), home)).toBe(true)

    const named = tmp()
    write(path.join(named, 'tapflow.config.json'), '{}')
    fs.mkdirSync(path.join(named, 'data'))
    expect(isTapflowOwned(named, home)).toBe(true)
  })

  it('does not count a directory that is also something else', () => {
    const repo = tmp()
    write(path.join(repo, 'package.json'), '{}')
    expect(isTapflowOwned(repo, tmp())).toBe(false)
  })
})

describe('scaffoldAgentDocs', () => {
  it('writes both files in a directory of tapflow\'s own', () => {
    const dir = tmp()
    const report = scaffoldAgentDocs(dir, tmp())
    expect(report).toMatchObject({ agents: 'created', claude: 'created' })
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe(AGENTS_BLOCK)
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe('@AGENTS.md\n')
  })

  it('is idempotent', () => {
    const dir = tmp()
    const home = tmp()
    scaffoldAgentDocs(dir, home)
    const before = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')
    expect(scaffoldAgentDocs(dir, home).agents).toBe('unchanged')
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe(before)
  })

  it('writes no CLAUDE.md in a directory that is also something else', () => {
    // It would switch Claude Code to reading CLAUDE.md files only, and the repo's other AGENTS.md
    // files — a monorepo's per-package ones — would stop loading.
    const repo = tmp()
    write(path.join(repo, 'package.json'), '{}')
    write(path.join(repo, 'AGENTS.md'), '# House rules\n')
    const report = scaffoldAgentDocs(repo, tmp())
    expect(report.agents).toBe('appended')
    expect(report.claude).toBe('skipped')
    expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8')).toContain('# House rules')
  })

  it('says to add the import when a CLAUDE.md above would hide the AGENTS.md', () => {
    const repo = tmp()
    write(path.join(repo, 'package.json'), '{}')
    write(path.join(repo, 'CLAUDE.md'), '# Mine\n')
    const report = scaffoldAgentDocs(repo, tmp())
    expect(report.claude).toBe('present')
    expect(report.notes.join('\n')).toContain('@AGENTS.md')
  })

  it('says nothing when the CLAUDE.md already imports it, or is a symlink to it', () => {
    const owned = tmp()
    write(path.join(owned, 'CLAUDE.md'), 'House rules\n\n@AGENTS.md\n')
    expect(scaffoldAgentDocs(owned, tmp()).notes).toEqual([])

    const linked = tmp()
    write(path.join(linked, 'AGENTS.md'), '# something\n')
    fs.symlinkSync(path.join(linked, 'AGENTS.md'), path.join(linked, 'CLAUDE.md'))
    expect(scaffoldAgentDocs(linked, tmp()).notes).toEqual([])
    expect(fs.lstatSync(path.join(linked, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
  })

  it('writes nothing into the home directory itself', () => {
    // An ~/AGENTS.md loads into every session started anywhere below it.
    const home = tmp()
    const report = scaffoldAgentDocs(home, home)
    expect(report.agents).toBe('skipped')
    expect(fs.existsSync(path.join(home, 'AGENTS.md'))).toBe(false)
    expect(report.notes.join('\n')).toContain('home directory')
  })

  it('leaves damaged markers alone and says so', () => {
    const dir = tmp()
    const broken = `# Mine\n${MARKER_BEGIN}\nhalf\n`
    write(path.join(dir, 'AGENTS.md'), broken)
    const report = scaffoldAgentDocs(dir, tmp())
    expect(report.agents).toBe('malformed')
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe(broken)
    expect(report.notes.join('\n')).toContain('markers are damaged')
  })
})
