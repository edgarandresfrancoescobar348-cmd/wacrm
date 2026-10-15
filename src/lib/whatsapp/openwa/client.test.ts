import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  assertOpenWaUrlAllowed,
  normalizeOpenWaBaseUrl,
  openWaRequest,
  validateOpenWaKey,
} from './client'
import { startFakeOpenWa, type FakeOpenWa } from './testing/fake-openwa-server'

describe('normalizeOpenWaBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:2785', 'http://127.0.0.1:2785'],
    ['http://127.0.0.1:2785/', 'http://127.0.0.1:2785'],
    ['https://wa.example.com/api', 'https://wa.example.com'],
    ['https://wa.example.com/gw/api/', 'https://wa.example.com/gw'],
    ['  https://wa.example.com  ', 'https://wa.example.com'],
  ])('%s -> %s', (input, out) => {
    expect(normalizeOpenWaBaseUrl(input)).toBe(out)
  })

  it.each([
    'ftp://wa.example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@wa.example.com',
    'https://wa.example.com/?x=1',
    'not a url',
  ])('rejects %s', (input) => {
    expect(() => normalizeOpenWaBaseUrl(input)).toThrow()
  })
})

describe('assertOpenWaUrlAllowed (SSRF)', () => {
  const prev = process.env.OPENWA_ALLOWED_HOSTS
  afterEach(() => {
    process.env.OPENWA_ALLOWED_HOSTS = prev
  })

  it.each([
    'http://127.0.0.1:2785',
    'http://169.254.169.254',
    'http://10.0.0.5',
    'http://[::ffff:127.0.0.1]',
    'http://localhost:2785',
    'http://openwa.internal',
  ])('blocks private / internal %s by default', async (url) => {
    process.env.OPENWA_ALLOWED_HOSTS = ''
    await expect(assertOpenWaUrlAllowed(url)).rejects.toMatchObject({ code: 'url_not_allowed' })
  })

  it('allows an operator-allowlisted host (self-hosting next to wacrm)', async () => {
    process.env.OPENWA_ALLOWED_HOSTS = '127.0.0.1, host.docker.internal'
    await expect(assertOpenWaUrlAllowed('http://127.0.0.1:2785')).resolves.toBeUndefined()
    await expect(assertOpenWaUrlAllowed('http://host.docker.internal:2785')).resolves.toBeUndefined()
    // the allowlist is exact — it doesn't open other private addresses
    await expect(assertOpenWaUrlAllowed('http://169.254.169.254')).rejects.toBeTruthy()
  })
})

describe('openWaRequest against a fake gateway', () => {
  let fake: FakeOpenWa
  beforeAll(async () => {
    fake = await startFakeOpenWa()
    process.env.OPENWA_ALLOWED_HOSTS = '127.0.0.1'
  })
  afterAll(() => fake.close())

  it('validates the key with POST /api/auth/validate', async () => {
    const info = await validateOpenWaKey({ baseUrl: fake.baseUrl, apiKey: fake.apiKey })
    expect(info).toMatchObject({ valid: true, engineType: 'whatsapp-web.js' })
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/auth/validate' })
  })

  it('surfaces a bad key as a 401 OpenWaError', async () => {
    await expect(validateOpenWaKey({ baseUrl: fake.baseUrl, apiKey: 'nope' })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('never follows a redirect (a public URL bouncing to an internal one)', async () => {
    fake.override(() => [302, { location: 'http://169.254.169.254/' }])
    try {
      await expect(
        openWaRequest({ baseUrl: fake.baseUrl, apiKey: fake.apiKey }, 'GET', '/health'),
      ).rejects.toMatchObject({ code: 'redirect' })
    } finally {
      fake.override(null)
    }
  })

  it('reports an unreachable gateway with status 0', async () => {
    await expect(
      openWaRequest({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, 'GET', '/health'),
    ).rejects.toMatchObject({ status: 0, code: 'unreachable' })
  })
})
