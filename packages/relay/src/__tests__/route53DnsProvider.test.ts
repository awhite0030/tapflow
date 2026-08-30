import { describe, it, expect } from 'vitest'
import { Route53DnsProvider } from '../lib/cert/Route53DnsProvider.js'
import type { FetchLike } from '../lib/cert/CloudflareDnsProvider.js'

describe('Route53DnsProvider', () => {
  const CREDS = { accessKeyId: 'test-ak', secretAccessKey: 'test-sk' }

  it('setTxtRecord sends correct XML with quoted value', async () => {
    let sentXml = ''
    let sentPath = ''

    const fetchFn: FetchLike = async (url, init) => {
      if (url.includes('/rrset')) {
        sentXml = init?.body as string
        sentPath = url
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<dummy/>' }
    }

    const dns = new Route53DnsProvider({ ...CREDS, zoneId: 'Z123', fetchFn })
    await dns.setTxtRecord('tap.example.com', 'my-token')

    expect(sentPath).toContain('/hostedzone/Z123/rrset')
    expect(sentXml).toContain('<Action>UPSERT</Action>')
    expect(sentXml).toContain('<Name>_acme-challenge.tap.example.com</Name>')
    expect(sentXml).toContain('<Type>TXT</Type>')
    expect(sentXml).toContain('<Value>"my-token"</Value>')
  })

  it('removeTxtRecord sends DELETE XML', async () => {
    let sentXml = ''

    const fetchFn: FetchLike = async (url, init) => {
      sentXml = init?.body as string
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<dummy/>' }
    }

    const dns = new Route53DnsProvider({ ...CREDS, zoneId: 'Z123', fetchFn })
    await dns.removeTxtRecord('tap.example.com', 'my-token')

    expect(sentXml).toContain('<Action>DELETE</Action>')
    expect(sentXml).toContain('<Value>"my-token"</Value>')
  })

  it('removeTxtRecord ignores "not found" error', async () => {
    const fetchFn: FetchLike = async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => '<ErrorResponse><Error><Message>Tried to delete resource record set [name=' +
                          '_acme-challenge.tap.example.com., type=TXT] but it was not found</Message></Error></ErrorResponse>'
      }
    }

    const dns = new Route53DnsProvider({ ...CREDS, zoneId: 'Z123', fetchFn })
    await expect(dns.removeTxtRecord('tap.example.com', 'my-token')).resolves.not.toThrow()
  })

  it('upsertAddressRecord sends UPSERT with A or AAAA', async () => {
    let aXml = ''
    let aaaaXml = ''

    const fetchFn: FetchLike = async (url, init) => {
      const xml = init?.body as string
      if (xml.includes('1.2.3.4')) aXml = xml
      if (xml.includes('fe80::1')) aaaaXml = xml
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<dummy/>' }
    }

    const dns = new Route53DnsProvider({ ...CREDS, zoneId: 'Z123', fetchFn })

    await dns.upsertAddressRecord('tap.example.com', '1.2.3.4')
    expect(aXml).toContain('<Type>A</Type>')
    expect(aXml).toContain('<Value>1.2.3.4</Value>')

    await dns.upsertAddressRecord('tap.example.com', 'fe80::1')
    expect(aaaaXml).toContain('<Type>AAAA</Type>')
    expect(aaaaXml).toContain('<Value>fe80::1</Value>')
  })

  it('zoneIdFor discovers zone by walking up domain tree', async () => {
    const fetchFn: FetchLike = async (url) => {
      const u = new URL(url)
      const name = u.searchParams.get('dnsname')

      if (name === 'example.com') {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => `
            <ListHostedZonesByNameResponse>
              <HostedZones>
                <HostedZone>
                  <Id>/hostedzone/Z456</Id>
                  <Name>example.com.</Name>
                </HostedZone>
              </HostedZones>
            </ListHostedZonesByNameResponse>
          `
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<empty/>' }
    }

    const dns = new Route53DnsProvider({ ...CREDS, fetchFn })

    // We expect it to try tap.sub.example.com, sub.example.com, then example.com
    await expect(dns.setTxtRecord('tap.sub.example.com', 'tok')).resolves.not.toThrow()

    // Since it caches, subsequent calls should not throw
    await expect(dns.setTxtRecord('tap.sub.example.com', 'tok2')).resolves.not.toThrow()
  })

  it('zoneIdFor throws if no zone found', async () => {
    const fetchFn: FetchLike = async () => {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<empty/>' }
    }

    const dns = new Route53DnsProvider({ ...CREDS, fetchFn })
    await expect(dns.setTxtRecord('tap.example.com', 'tok')).rejects.toThrow(/No Route53 zone found for tap.example.com/)
  })

  it('generates correct SigV4 headers', async () => {
    let authHeader = ''

    const fetchFn: FetchLike = async (url, init) => {
      authHeader = ((init?.headers as Record<string, string>) || {}).Authorization || ''
      return { ok: true, status: 200, json: async () => ({}), text: async () => '<dummy/>' }
    }

    const dns = new Route53DnsProvider({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', zoneId: 'Z123', fetchFn })
    await dns.setTxtRecord('tap.example.com', 'tok')

    expect(authHeader).toContain('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/')
    expect(authHeader).toContain('/us-east-1/route53/aws4_request')
    expect(authHeader).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date')
    expect(authHeader).toContain('Signature=')
  })
})
