#!/usr/bin/env node
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))

if (process.argv.slice(2).length === 0) {
  const R = '\x1b[0m'
  const BOLD = '\x1b[1m'
  const DIM = '\x1b[2m'
  const GREEN = '\x1b[32m'

  const title = `TAPFLOW v${version}`
  const width = Math.max(title.length + 5, 50)
  const bar = '─'.repeat(width)

  console.log()
  console.log(`${GREEN}${BOLD}  ┌${bar}┐${R}`)
  console.log(`${GREEN}${BOLD}  │  ✓  ${title.padEnd(width - 5)}│${R}`)
  console.log(`${GREEN}${BOLD}  └${bar}┘${R}`)
  console.log()
  console.log(`${DIM}     Self-hosted iOS/Android simulator streaming for QA teams.${R}`)
  console.log()
  console.log(`${DIM}     Commands:${R}`)
  console.log(`${DIM}       tapflow doctor        check system prerequisites${R}`)
  console.log(`${DIM}       tapflow init          configure this machine's tapflow${R}`)
  console.log(`${DIM}       tapflow start         start relay + agent locally${R}`)
  console.log(`${DIM}       tapflow --help        show all commands${R}`)
  console.log()
  console.log(`${DIM}     Docs: https://github.com/jo-duchan/tapflow${R}`)
  console.log()
  process.exit(0)
}

await import('../dist/index.js')
