import path from 'path'
import { RelayServer, initDb, config } from '@tapflowio/relay'

const PORT = Number(process.env.PORT ?? 4000)
// The directory the relay's config resolved, the one `tapflow start` uses. A path built here from
// this file's location put the DB in one place while config wrote the jwt-secret in another, so a
// tapflow.config.json pinning the legacy .tapflow-data/ split the install across both.
const { dataDir } = config.local

initDb(path.join(dataDir, 'tapflow.db'))

const server = new RelayServer({
  port: PORT,
  uploadsDir: path.join(dataDir, 'uploads'),
})

server.start()

const idleMs = process.env['IDLE_TIMEOUT_MS']
console.log(`Relay  →  ws://localhost:${PORT}`)
console.log(`Dashboard  →  http://localhost:${PORT}  (dev: http://localhost:3001)`)
console.log(`Data  →  ${dataDir}`)
console.log(`Idle timeout  →  ${idleMs ? `${idleMs}ms (env)` : '300000ms (default)'}`)
console.log('\nWaiting for agents...')
