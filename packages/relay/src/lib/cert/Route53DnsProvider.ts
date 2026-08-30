import crypto from 'node:crypto'
import type { DnsProvider } from './DnsProvider.js'
import { DNS_API_TIMEOUT_MS, type FetchLike } from './CloudflareDnsProvider.js'

const DEFAULT_API_BASE = 'https://route53.amazonaws.com'
const API_VERSION = '2013-04-01'
const TTL_SECONDS = 60

export interface Route53DnsProviderOptions {
  accessKeyId: string
  secretAccessKey: string
  /** 명시하면 zone 디스커버리를 생략하고 이 ID의 zone만 쓴다. */
  zoneId?: string
  /** 테스트 주입용. 기본은 global fetch. */
  fetchFn?: FetchLike
  /** 기본 https://route53.amazonaws.com */
  apiBase?: string
}

interface Route53Zone {
  Id: string
  Name: string
}

export class Route53DnsProvider implements DnsProvider {
  readonly name = 'route53'
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly fetchFn: FetchLike
  private readonly apiBase: string
  private readonly fixedZoneId?: string
  private readonly zoneIdCache = new Map<string, string>()

  constructor(opts: Route53DnsProviderOptions) {
    if (!opts.accessKeyId || !opts.secretAccessKey) {
      throw new Error('AWS credentials are required (set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)')
    }
    this.accessKeyId = opts.accessKeyId
    this.secretAccessKey = opts.secretAccessKey
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike)
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE
    this.fixedZoneId = opts.zoneId
  }

  async setTxtRecord(fqdn: string, value: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const name = `_acme-challenge.${fqdn}`

    // UPSERT replaces existing records or creates a new one
    // We quote the value for TXT records as required by Route53
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/${API_VERSION}/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${name}</Name>
          <Type>TXT</Type>
          <TTL>${TTL_SECONDS}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>"${value}"</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`

    await this.request(`/hostedzone/${zoneId}/rrset`, 'POST', {}, xml)
  }

  async removeTxtRecord(fqdn: string, value: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const name = `_acme-challenge.${fqdn}`

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/${API_VERSION}/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>DELETE</Action>
        <ResourceRecordSet>
          <Name>${name}</Name>
          <Type>TXT</Type>
          <TTL>${TTL_SECONDS}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>"${value}"</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`

    // DELETE requires exact match of the record to delete.
    // We try to delete, but if it doesn't exist, we ignore the error.
    try {
      await this.request(`/hostedzone/${zoneId}/rrset`, 'POST', {}, xml)
    } catch (e) {
      if (e instanceof Error && e.message.includes('not found')) {
        return
      }
      throw e
    }
  }

  async upsertAddressRecord(fqdn: string, ip: string): Promise<void> {
    const zoneId = await this.zoneIdFor(fqdn)
    const type = ip.includes(':') ? 'AAAA' : 'A'

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/${API_VERSION}/">
  <ChangeBatch>
    <Changes>
      <Change>
        <Action>UPSERT</Action>
        <ResourceRecordSet>
          <Name>${fqdn}</Name>
          <Type>${type}</Type>
          <TTL>${TTL_SECONDS}</TTL>
          <ResourceRecords>
            <ResourceRecord>
              <Value>${ip}</Value>
            </ResourceRecord>
          </ResourceRecords>
        </ResourceRecordSet>
      </Change>
    </Changes>
  </ChangeBatch>
</ChangeResourceRecordSetsRequest>`

    await this.request(`/hostedzone/${zoneId}/rrset`, 'POST', {}, xml)
  }

  private async zoneIdFor(fqdn: string): Promise<string> {
    if (this.fixedZoneId) return this.fixedZoneId

    const cached = this.zoneIdCache.get(fqdn)
    if (cached) return cached

    // Split domain into parts and try to find the longest matching zone
    const parts = fqdn.split('.')
    let bestMatch: Route53Zone | null = null

    for (let i = 0; i < parts.length - 1; i++) {
      const searchName = parts.slice(i).join('.')

      const xml = await this.request('/hostedzonesbyname', 'GET', { dnsname: searchName })
      // Use global match to search through all returned hosted zones.
      const regex = /<HostedZone>[\s\S]*?<Id>\/hostedzone\/([^<]+)<\/Id>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/HostedZone>/g
      let match
      while ((match = regex.exec(xml)) !== null) {
        const id = match[1]
        // Route53 appends a dot to the zone name in the response
        let name = match[2]
        if (name.endsWith('.')) {
          name = name.slice(0, -1)
        }

        if (name === searchName) {
          bestMatch = { Id: id, Name: name }
          break // Found exact match
        }
      }
      if (bestMatch) break
    }

    if (!bestMatch) {
      throw new Error(`No Route53 zone found for ${fqdn}`)
    }

    this.zoneIdCache.set(fqdn, bestMatch.Id)
    return bestMatch.Id
  }

  private async request(path: string, method: string, queryParams: Record<string, string> = {}, body = ''): Promise<string> {
    const urlObj = new URL(`${this.apiBase}/${API_VERSION}${path}`)
    for (const [k, v] of Object.entries(queryParams)) {
      urlObj.searchParams.set(k, v)
    }

    const host = urlObj.host

    const date = new Date()
    const amzDate = date.toISOString().replace(/[:-]/g, '').split('.')[0] + 'Z'
    const dateStr = amzDate.substring(0, 8)

    const region = 'us-east-1' // Route53 API is global but uses us-east-1 for SigV4
    const service = 'route53'

    const payloadHash = this.sha256(body)

    const headers: Record<string, string> = {
      'host': host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    }

    if (body) {
      headers['content-type'] = 'application/xml'
    }

    const sortedHeaderKeys = Object.keys(headers).sort()
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('')
    const signedHeaders = sortedHeaderKeys.join(';')

    const sortedQueryKeys = Object.keys(queryParams).sort()
    const canonicalQueryString = sortedQueryKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&')

    const canonicalRequest = [
      method,
      urlObj.pathname,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n')

    const credentialScope = `${dateStr}/${region}/${service}/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this.sha256(canonicalRequest)
    ].join('\n')

    const kDate = this.hmac(`AWS4${this.secretAccessKey}`, dateStr)
    const kRegion = this.hmac(kDate, region)
    const kService = this.hmac(kRegion, service)
    const kSigning = this.hmac(kService, 'aws4_request')

    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    // We bypass this.fetchFn here because FetchLike in CloudflareDnsProvider
    // doesn't support .text() on the response, but we need it for XML.
    // For unit tests, we'll cast the mock fetch to 'unknown' then to the expected type.
    const fetchFn = this.fetchFn as unknown as typeof globalThis.fetch
    const res = await fetchFn(urlObj.toString(), {
      method,
      headers,
      body: body ? body : undefined,
      signal: AbortSignal.timeout(DNS_API_TIMEOUT_MS),
    })

    const responseText = await res.text()
    if (!res.ok) {
      // Parse basic XML error if possible
      const match = responseText.match(/<Message>([^<]+)<\/Message>/)
      const msg = match ? match[1] : `HTTP ${res.status}`
      throw new Error(`Route53 API error: ${msg}`)
    }

    return responseText
  }

  private sha256(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
  }

  private hmac(key: string | Buffer, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
  }
}

/** env에서 credentials를 읽어 provider를 만든다. 미설정 시 throw. */
export function route53DnsFromEnv(zoneId?: string): Route53DnsProvider {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set')
  }
  return new Route53DnsProvider({ accessKeyId, secretAccessKey, zoneId })
}
