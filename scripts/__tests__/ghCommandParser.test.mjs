// The shell reader three gates share, tested on its own.
//
// **It had no test file of its own until now.** What existed lived inside `issueParentGate.test.mjs`,
// which is one of its three callers, so a parser change was judged by one gate's fixtures while the
// other two rode along. The cases here are about the reader rather than any gate's verdict.
import { describe, it, expect } from 'vitest'
import { ghInvocations, tokenize, tokenizeDetailed, hereStrings, stdinBodies, bodyFileArg }
  from '../lib/gh-command.mjs'

const creates = (cmd) => ghInvocations(cmd, 'issue', ['create']).length
const merges = (cmd) => ghInvocations(cmd, 'pr', ['merge']).length

describe('a reserved word is only reserved in command position', () => {
  // bash reads `do`, `then`, `else`, `if`, `while`, `until` and `!` as keywords only where a command
  // may begin. `echo do x` passes `do` to echo as an argument. The parser used to consult one flat
  // separator set at every position, so an argument that happened to spell a keyword ended the
  // invocation it sat in and the words after it were read as a new command.
  const ARGUMENT_KEYWORDS = ['do', 'then', 'else', 'if', 'while', 'until', '!', '{', '}']

  for (const kw of ARGUMENT_KEYWORDS) {
    it(`\`${kw}\` as an argument does not start a new command`, () => {
      expect(creates(`echo ${kw} gh issue create -t x`), kw).toBe(0)
    })
  }

  it('the same word in command position still separates', () => {
    // The mirror case, and the reason the set exists: these take a command as their condition.
    expect(creates('if gh issue create -t x; then echo ok; fi')).toBe(1)
    expect(creates('while gh issue create -t x; do echo ok; done')).toBe(1)
    expect(creates('cmd; then gh issue create -t x')).toBe(1)
  })

  it('operators separate wherever they appear', () => {
    // `;`, `&&`, `|` and the parens are operators rather than keywords: the shell splits on them in
    // any position, so nothing here depends on where they sit.
    expect(creates('true && gh issue create -t x')).toBe(1)
    expect(creates('cd /tmp;gh issue create -t x')).toBe(1)
    expect(creates('echo x|gh issue create -t x')).toBe(1)
    expect(creates('(gh issue create -t x)')).toBe(1)
  })

  it('a quoted keyword is not a keyword even in command position', () => {
    // `"do" gh …` makes bash look for a command named `do`; the quotes take the word out of the
    // grammar. Treating it as a separator put `gh` in command position, which is a false block.
    expect(creates('echo "do" gh issue create -t x')).toBe(0)
    expect(merges("echo 'then' gh pr merge 1")).toBe(0)
    expect(creates('echo \\do gh issue create -t x')).toBe(0)
  })
})

describe('tokenizeDetailed reports how a word arrived', () => {
  it('marks quoted and escaped words', () => {
    expect(tokenizeDetailed('echo "do" bare').quoted).toEqual([false, true, false])
    expect(tokenizeDetailed("echo 'do'").quoted).toEqual([false, true])
    expect(tokenizeDetailed('echo \\do').quoted).toEqual([false, true])
  })

  it('operators and newlines are never quoted', () => {
    const { words, quoted } = tokenizeDetailed('a && b\nc')
    expect(quoted).toEqual(words.map(() => false))
  })

  it('tokenize stays the word list it was', () => {
    // Every existing caller destructures a flat array; the detail is additive rather than a new
    // shape imposed on all of them.
    expect(tokenize('gh issue create -t "a b"')).toEqual(['gh', 'issue', 'create', '-t', 'a b'])
  })
})

describe('a here-string is a body', () => {
  it('is read like the heredoc it stands in for', () => {
    expect(hereStrings('gh issue create -t x --body-file - <<< "Parent: #1"')).toEqual(['Parent: #1'])
    expect(hereStrings("cmd <<<'one two'")).toEqual(['one two'])
    expect(hereStrings('cmd <<<bare')).toEqual(['bare'])
  })

  it('is not confused with a heredoc opener', () => {
    // `<<EOF` and `<<<text` differ by one character, and the heredoc regex is anchored to the end of
    // its line, so neither may claim the other's text.
    expect(hereStrings('cmd <<EOF\nbody\nEOF')).toEqual([])
    expect(stdinBodies('cmd <<EOF\nbody\nEOF')).toEqual(['body'])
  })

  it('stdinBodies carries both, so an ambiguous command stays ambiguous', () => {
    // The callers block when a command offers more than one body, because picking one is guessing.
    // That rule only holds if both kinds are counted together.
    expect(stdinBodies('cmd <<EOF\na\nEOF\nother <<< "b"')).toEqual(['a', 'b'])
  })
})

describe('a process substitution is a shape, not a path', () => {
  it('is recognisable from the argument the parser produces', () => {
    // `<(…)` cannot be read without running it, so the honest answer names the shape. Reporting it
    // as a file that could not be opened invents a path — the parser's `<` — and sends the author
    // looking for it.
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file <(echo hi)'))).toBe('<')
    expect(bodyFileArg(tokenize('gh issue create -t x -F<(echo hi)'))).toBe('<')
  })

  it('an ordinary path is unaffected', () => {
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file body.md'))).toBe('body.md')
    expect(bodyFileArg(tokenize('gh issue create -t x --body-file -'))).toBe('-')
  })
})
