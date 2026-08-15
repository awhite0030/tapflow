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
    expect(smoke).toContain('for attempt in $(seq 1 60)')
    expect(smoke).toContain("docker inspect -f '{{.State.Running}}' \"$container\"")
    expect(smoke).toContain('http://127.0.0.1:4000/')
    expect(smoke).toContain('http://127.0.0.1:4000/api/v1/auth/status')
    expect(smoke).toContain('[ "$root_status" -ge 200 ] && [ "$root_status" -lt 400 ]')
    expect(smoke).toContain('[ "$api_status" -ge 200 ] && [ "$api_status" -lt 400 ]')
    expect(smoke).toContain("grep -Fq '<title>tapflow</title>' \"$root_body\"")
    expect(smoke).toContain('grep -Eq \'"initialized":(true|false)\' "$api_body"')
  })

  it('reports logs on failure and removes test containers and volumes', () => {
    const smoke = stepBlock('Smoke test image runtime')
    expect(smoke).toContain('trap cleanup EXIT')
    expect(smoke).toContain('docker logs "$container"')
    expect(smoke).toContain('docker rm -f "$container"')
    expect(smoke).toContain('docker volume rm "$volume"')
  })

  it('does not copy stale TypeScript build metadata without matching dist output', () => {
    expect(DOCKERIGNORE).toContain('**/dist')
    expect(DOCKERIGNORE).toContain('**/*.tsbuildinfo')
  })
})
