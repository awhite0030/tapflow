import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'docker-publish.yml'), 'utf8')
const DOCKERIGNORE = readFileSync(join(ROOT, '.dockerignore'), 'utf8')

function stepBlock(name) {
  const marker = `      - name: ${name}\n`
  const start = WORKFLOW.indexOf(marker)
  if (start === -1) return ''
  const next = WORKFLOW.indexOf('\n      - name:', start + marker.length)
  return WORKFLOW.slice(start, next === -1 ? undefined : next)
}

function matrixBlock() {
  const marker = '      matrix:\n'
  const start = WORKFLOW.indexOf(marker)
  if (start === -1) return ''
  const next = WORKFLOW.indexOf('\n    env:', start + marker.length)
  return WORKFLOW.slice(start, next === -1 ? undefined : next)
}

describe('docker-publish runtime smoke test', () => {
  it('keeps the Docker build matrix on the required amd64 and arm64 platforms', () => {
    const platforms = [...matrixBlock().matchAll(/platform:\s*(linux\/(?:amd64|arm64))\b/g)].map(
      ([, platform]) => platform,
    )

    expect(platforms).toEqual(['linux/amd64', 'linux/arm64'])
  })

  it('loads validation builds locally and smokes the pushed digest when publishing', () => {
    const build = stepBlock('Build image (push by digest when publishing)')
    expect(build).toContain('push-by-digest=true')
    expect(build).toContain('push=true')
    expect(build).toContain('type=docker,name=tapflow-smoke:{0}')

    const select = stepBlock('Select image for smoke test')
    expect(select).toContain('SMOKE_IMAGE=${IMAGE}@${{ steps.build.outputs.digest }}')
    expect(select).toContain('SMOKE_IMAGE=tapflow-smoke:${PLATFORM_PAIR}')
  })

  it('runs the container on :4000 with the persistent data volume mounted', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke).toContain('-p 127.0.0.1:4000:4000')
    expect(smoke).toContain('-v "$volume:/app/.tapflow/data"')
    expect(smoke).toContain('"$SMOKE_IMAGE"')
  })

  it('waits for a live container and a non-error HTTP response before passing', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke).toContain('timeout-minutes: 5')
    expect(smoke).toContain('for attempt in $(seq 1 20)')
    expect(smoke).toContain("docker inspect -f '{{.State.Running}}' \"$container\"")
    expect(smoke).toContain('http://127.0.0.1:4000/')
    expect(smoke).toContain('http://127.0.0.1:4000/api/v1/auth/status')
    expect(smoke.match(/curl --connect-timeout 2 --max-time 2/g) ?? []).toHaveLength(2)
    expect(smoke).toContain('[ "$root_status" -ge 200 ] && [ "$root_status" -lt 400 ]')
    expect(smoke).toContain('[ "$api_status" -ge 200 ] && [ "$api_status" -lt 400 ]')
    expect(smoke).toContain("grep -Fq '<title>tapflow</title>' \"$root_body\"")
    expect(smoke).toContain('grep -Eq \'"initialized":(true|false)\' "$api_body"')
  })

  it('reports sanitized failure diagnostics and removes test containers and volumes', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke).toContain('trap cleanup EXIT')
    expect(smoke).not.toContain('docker logs "$container"')
    expect(smoke).toContain('diagnose_container >&2')
    expect(smoke).toContain('State.Status={{.State.Status}}')
    expect(smoke).toContain('State.ExitCode={{.State.ExitCode}}')
    expect(smoke).toContain('State.OOMKilled={{.State.OOMKilled}}')
    expect(smoke).toContain('docker rm -f "$container"')
    expect(smoke).toContain('docker volume rm "$volume"')
  })

  it('recreates the same image with the same volume and checks JWT secret continuity', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke.match(/start_container/g) ?? []).toHaveLength(3)
    expect(smoke).toContain('wait_for_ready "first boot"')
    expect(smoke).toContain('docker rm -f "$container" >/dev/null')
    expect(smoke).toContain('wait_for_ready "restart"')
    expect(smoke).toContain('[ ! -s /app/.tapflow/data/jwt-secret ]')
    expect(smoke).toContain('JWT secret file is missing or empty.')
    expect(smoke).toContain('sha256sum /app/.tapflow/data/jwt-secret | cut -d " " -f1')
    expect(smoke).toContain('first_jwt_secret="$(jwt_secret_fingerprint)"')
    expect(smoke).toContain('second_jwt_secret="$(jwt_secret_fingerprint)"')
    expect(smoke).toContain('[ "$first_jwt_secret" != "$second_jwt_secret" ]')
    expect(smoke).toContain('"$SMOKE_IMAGE"')
    expect(smoke).toContain('-v "$volume:/app/.tapflow/data"')
  })

  it('does not copy stale TypeScript build metadata without matching dist output', () => {
    expect(DOCKERIGNORE).toContain('**/dist')
    expect(DOCKERIGNORE).toContain('**/*.tsbuildinfo')
  })
})
