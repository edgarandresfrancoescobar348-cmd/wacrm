import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  normalizeOpenWaBaseUrl,
  openWaRequest,
  validateOpenWaKey,
} from './client'
import { checkOpenWaGateway, openWaGateway, openWaWebhookBaseUrl, requireOpenWaGateway } from './gateway'
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

describe('openWaRequest against a fake gateway', () => {
  let fake: FakeOpenWa
  beforeAll(async () => {
    fake = await startFakeOpenWa()
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

  it('never follows a redirect', async () => {
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

describe('the embedded gateway (server config)', () => {
  let fake: FakeOpenWa
  const saved = { ...process.env }
  beforeAll(async () => {
    fake = await startFakeOpenWa()
  })
  afterAll(() => fake.close())
  afterEach(() => {
    for (const k of ['OPENWA_URL', 'OPENWA_API_KEY', 'OPENWA_API_KEY_FILE', 'OPENWA_WEBHOOK_BASE_URL', 'PORT']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is unconfigured without a URL and a key', async () => {
    delete process.env.OPENWA_URL
    delete process.env.OPENWA_API_KEY
    delete process.env.OPENWA_API_KEY_FILE
    expect(openWaGateway()).toBeNull()
    expect(() => requireOpenWaGateway()).toThrow(expect.objectContaining({ code: 'gateway_unconfigured', status: 503 }))
    await expect(checkOpenWaGateway()).resolves.toEqual({ state: 'unconfigured', engine: null })
  })

  it('reads the key from OPENWA_API_KEY_FILE (the compose shared volume)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-key-'))
    const file = path.join(dir, 'gateway.key')
    fs.writeFileSync(file, `${fake.apiKey}\n`)
    process.env.OPENWA_URL = `${fake.baseUrl}/`
    delete process.env.OPENWA_API_KEY
    process.env.OPENWA_API_KEY_FILE = file
    expect(openWaGateway()).toEqual({ baseUrl: fake.baseUrl, apiKey: fake.apiKey })
    await expect(checkOpenWaGateway()).resolves.toEqual({ state: 'ok', engine: 'whatsapp-web.js' })
  })

  it('reports a down gateway and a rejected key', async () => {
    process.env.OPENWA_URL = 'http://127.0.0.1:1'
    process.env.OPENWA_API_KEY = 'k'
    await expect(checkOpenWaGateway()).resolves.toMatchObject({ state: 'unreachable' })
    process.env.OPENWA_URL = fake.baseUrl
    process.env.OPENWA_API_KEY = 'wrong'
    await expect(checkOpenWaGateway()).resolves.toMatchObject({ state: 'auth_failed' })
  })

  it('webhooks go to the internal base URL, never a browser origin', () => {
    delete process.env.OPENWA_WEBHOOK_BASE_URL
    process.env.PORT = '41151'
    expect(openWaWebhookBaseUrl()).toBe('http://127.0.0.1:41151')
    process.env.OPENWA_WEBHOOK_BASE_URL = 'http://app:3000/'
    expect(openWaWebhookBaseUrl()).toBe('http://app:3000')
  })
})
