import { X509Certificate } from 'crypto'
import { isIP } from 'net'
import type { TlsConfig } from './createCertProvider.js'

const FALLBACK_HOST = 'localhost'

function concreteDnsHost(value: string): string | null {
  const host = value
  if (!host || host !== host.trim() || isIP(host) !== 0 || host.length > 253) return null
  const labels = host.split('.')
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null
  try {
    // WHATWG URLs accept legacy IPv4 spellings such as 127.1 and 0x7f000001.
    // Do not advertise them as DNS names: browsers normalize them to an IP address.
    if (isIP(new URL(`https://${host}`).hostname) !== 0) return null
  } catch {
    return null
  }
  return host
}

/** PEM 인증서에서 notAfter(만료 시각)를 파싱한다. 잘못된 PEM이면 throw. */
export function parseCertNotAfter(certPem: string): Date {
  return new Date(new X509Certificate(certPem).validTo)
}

/** Return one concrete DNS host the certificate can identify, or localhost when it has none. */
export function parseCertDisplayHost(certPem: string): string {
  try {
    const cert = new X509Certificate(certPem)
    if (cert.subjectAltName !== undefined) {
      // Node JSON-quotes and escapes ambiguous SAN values, including commas. A real DNS host uses
      // none of those characters, so strict label validation can safely reject the whole value.
      for (const entry of cert.subjectAltName.split(', ')) {
        if (!entry.startsWith('DNS:')) continue
        const host = concreteDnsHost(entry.slice(4))
        if (host) return host
      }
      return FALLBACK_HOST
    }

    const commonName = cert.subject
      .split('\n')
      .find((entry) => entry.startsWith('CN='))
      ?.slice(3)
    return commonName ? concreteDnsHost(commonName) ?? FALLBACK_HOST : FALLBACK_HOST
  } catch {
    return FALLBACK_HOST
  }
}

export function resolveRelayDisplayHost(tls: TlsConfig | null, certPem?: string): string {
  if (!tls) return FALLBACK_HOST
  if (tls.mode === 'byo-api-token') return tls.domain
  return certPem ? parseCertDisplayHost(certPem) : FALLBACK_HOST
}
