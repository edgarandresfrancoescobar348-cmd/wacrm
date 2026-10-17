// The scheduler that `npm run dev` / `npm run start` (scripts/wacrm.mjs)
// and the compose `scheduler` service run: every tick calls the cron
// endpoints with the cron secret, and it stops with the app (phase 5b —
// without it nothing continued the QR history import).

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { CRON_ENDPOINTS, cronTick, ensureCronSecret, openWaEnv, startScheduler } from '../../../scripts/wacrm.mjs'

type Hit = { path: string; secret: string | undefined }

async function cronServer(status = 200) {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url ?? '', secret: req.headers['x-cron-secret'] as string | undefined })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { hits, baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const saved = process.env.AUTOMATION_CRON_SECRET
afterEach(() => {
  if (saved === undefined) delete process.env.AUTOMATION_CRON_SECRET
  else process.env.AUTOMATION_CRON_SECRET = saved
})

describe('cron tick (scripts/wacrm.mjs)', () => {
  it('calls every due endpoint with the secret; the flow sweep every 5th tick', async () => {
    const srv = await cronServer()
    try {
      const line0 = await cronTick({ baseUrl: srv.baseUrl, secret: 's3cret', tick: 0 })
      expect(srv.hits.map((h) => h.path).sort()).toEqual(
        ['/api/automations/cron', '/api/flows/cron', '/api/whatsapp/broadcast/cron'].sort(),
      )
      expect(srv.hits.every((h) => h.secret === 's3cret')).toBe(true)
      expect(line0).toMatch(/^automations 200 · broadcast 200 · flows 200 \(\d+ ms\)$/)

      srv.hits.length = 0
      await cronTick({ baseUrl: srv.baseUrl, secret: 's3cret', tick: 1 })
      expect(srv.hits.map((h) => h.path).sort()).toEqual(['/api/automations/cron', '/api/whatsapp/broadcast/cron'])
      expect(CRON_ENDPOINTS.find((e: { name: string }) => e.name === 'flows')?.every).toBe(5)
    } finally {
      await srv.close()
    }
  })

  it('reports a refused secret or a server that is down in its one line', async () => {
    const srv = await cronServer(401)
    try {
      expect(await cronTick({ baseUrl: srv.baseUrl, secret: 'wrong', tick: 1 })).toMatch(/automations 401 · broadcast 401/)
    } finally {
      await srv.close()
    }
    expect(await cronTick({ baseUrl: 'http://127.0.0.1:1', secret: 'x', tick: 1 })).toMatch(
      /automations unreachable · broadcast unreachable/,
    )
  })

  it('does not stack a call on one still running', async () => {
    const line = await cronTick({
      baseUrl: 'http://unused',
      secret: 'x',
      tick: 1,
      inFlight: new Set(['automations']),
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    expect(line).toMatch(/^automations busy · broadcast 200/)
  })

  it('ticks on its interval and stops with the app', async () => {
    const srv = await cronServer()
    const lines: string[] = []
    try {
      const scheduler = startScheduler({
        baseUrl: srv.baseUrl,
        secret: 'tick-secret',
        intervalMs: 60,
        firstTickMs: 0,
        write: (l: string) => lines.push(l),
      })
      await new Promise((r) => setTimeout(r, 230))
      scheduler.stop()
      const after = srv.hits.length
      await new Promise((r) => setTimeout(r, 200))
      expect(srv.hits.length).toBe(after) // nothing after stop()
      expect(lines.length).toBeGreaterThanOrEqual(3)
      expect(lines[0]).toMatch(/^\[cron\] tick 0: automations 200/)
      expect(srv.hits.every((h) => h.secret === 'tick-secret')).toBe(true)
    } finally {
      await srv.close()
    }
  })
})

describe('cron secret (scripts/wacrm.mjs)', () => {
  it("uses the operator's secret when set", () => {
    process.env.AUTOMATION_CRON_SECRET = 'from-env'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrm-cron-'))
    expect(ensureCronSecret(dir, 'dev')).toEqual({ secret: 'from-env', source: 'configured' })
    expect(fs.existsSync(path.join(dir, 'cron.secret'))).toBe(false)
  })

  it('reads it from the .env files Next loads', () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrm-root-'))
    fs.writeFileSync(path.join(root, '.env.local'), 'FOO=1\nAUTOMATION_CRON_SECRET="from-file"\n')
    expect(ensureCronSecret(root, 'dev', root)).toEqual({ secret: 'from-file', source: 'configured' })
  })

  it('otherwise generates one once (0600) and keeps it', () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wacrm-root-'))
    const first = ensureCronSecret(root, 'dev', root)
    expect(first.source).toBe('generated')
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(path.join(root, 'cron.secret')).mode & 0o777).toBe(0o600)
    expect(ensureCronSecret(root, 'dev', root)).toEqual({ secret: first.secret, source: 'existing' })
  })
})

// Phase 5c: after restarting `npm run dev` the real account's session
// came back 'disconnected' — OpenWA only restores linked sessions on boot
// with AUTO_START_SESSIONS=true (opt-in upstream), and the runner didn't set it.
describe('gateway environment (scripts/wacrm.mjs)', () => {
  const savedFlag = process.env.OPENWA_AUTO_START_SESSIONS
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.OPENWA_AUTO_START_SESSIONS
    else process.env.OPENWA_AUTO_START_SESSIONS = savedFlag
  })

  it.each(['dev', 'start'])('%s restores linked sessions on boot (AUTO_START_SESSIONS=true)', (mode) => {
    delete process.env.OPENWA_AUTO_START_SESSIONS
    const env = openWaEnv({ mode, port: 2785, key: 'k' })
    expect(env.AUTO_START_SESSIONS).toBe('true')
    // …next to the rest of what the managed gateway needs.
    expect(env).toMatchObject({
      API_MASTER_KEY: 'k',
      PORT: '2785',
      LISTEN_HOST: '127.0.0.1',
      SERVE_DASHBOARD: 'false',
      RATE_LIMIT_MEDIUM_LIMIT: '600',
      WEBHOOK_CONTACT_DETAILS: 'true',
      NODE_ENV: mode === 'dev' ? 'development' : 'production',
    })
  })

  it('an operator can turn it off with OPENWA_AUTO_START_SESSIONS=false', () => {
    process.env.OPENWA_AUTO_START_SESSIONS = 'false'
    expect(openWaEnv({ mode: 'dev', port: 2785, key: 'k' }).AUTO_START_SESSIONS).toBe('false')
  })

  // Patch 6 logs at debug why a document got no first-page preview; the
  // runner never passed a log level, so the gateway stayed at info.
  it('passes OPENWA_LOG_LEVEL / OPENWA_LOG_FORMAT as the gateway\'s LOG_LEVEL / LOG_FORMAT; unset, OpenWA\'s defaults', () => {
    const saved = { level: process.env.OPENWA_LOG_LEVEL, format: process.env.OPENWA_LOG_FORMAT, raw: process.env.LOG_LEVEL }
    try {
      process.env.OPENWA_LOG_LEVEL = ' debug '
      process.env.OPENWA_LOG_FORMAT = 'json'
      expect(openWaEnv({ mode: 'dev', port: 2785, key: 'k' })).toMatchObject({ LOG_LEVEL: 'debug', LOG_FORMAT: 'json' })
      delete process.env.OPENWA_LOG_LEVEL
      delete process.env.OPENWA_LOG_FORMAT
      // wacrm's own LOG_LEVEL is not the gateway's.
      process.env.LOG_LEVEL = 'verbose'
      const env = openWaEnv({ mode: 'start', port: 2785, key: 'k' })
      expect(env.LOG_LEVEL).toBeUndefined()
      expect(env.LOG_FORMAT).toBeUndefined()
    } finally {
      for (const [k, v] of [['OPENWA_LOG_LEVEL', saved.level], ['OPENWA_LOG_FORMAT', saved.format], ['LOG_LEVEL', saved.raw]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('docker-compose.yml passes the same log settings to the openwa service', () => {
    const compose = fs.readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8')
    const openwa = compose.slice(compose.indexOf('\n  openwa:\n'), compose.indexOf('\n  openwa-key:\n'))
    expect(openwa).toMatch(/LOG_LEVEL: \$\{OPENWA_LOG_LEVEL:-info\}/)
    expect(openwa).toMatch(/LOG_FORMAT: \$\{OPENWA_LOG_FORMAT:-json\}/)
  })

  it('docker-compose.yml turns it on for the openwa service too', () => {
    const compose = fs.readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8')
    const openwa = compose.slice(compose.indexOf('\n  openwa:\n'), compose.indexOf('\n  openwa-key:\n'))
    expect(openwa).toMatch(/AUTO_START_SESSIONS: \$\{OPENWA_AUTO_START_SESSIONS:-true\}/)
  })
})
