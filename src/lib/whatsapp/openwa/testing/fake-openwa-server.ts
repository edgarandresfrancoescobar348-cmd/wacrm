// A fake OpenWA gateway for tests: a real HTTP server on 127.0.0.1 that
// speaks the subset of OpenWA's REST API (v0.25) wacrm uses and records
// every request. Not imported by app code.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: unknown
}

export interface FakeOpenWa {
  baseUrl: string
  apiKey: string
  requests: RecordedRequest[]
  /** Override a response: return [status, body] (optionally [status, body, delayMs]) or undefined for the default. */
  override: (fn: ((req: RecordedRequest) => FakeResponse | undefined) | null) => void
  close: () => Promise<void>
}

/** [status, body, delayMs?, headers?] */
type FakeResponse = [number, unknown] | [number, unknown, number] | [number, unknown, number, Record<string, string>]

let counter = 0

export async function startFakeOpenWa(apiKey = 'test-openwa-key'): Promise<FakeOpenWa> {
  const requests: RecordedRequest[] = []
  let overrideFn: ((req: RecordedRequest) => FakeResponse | undefined) | null = null

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const record: RecordedRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      }
      requests.push(record)
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        // `{ __raw: '…' }` sends the bytes as they are (a truncated or
        // non-JSON answer).
        if (body && typeof body === 'object' && '__raw' in body) return res.end(String((body as { __raw: unknown }).__raw))
        res.end(body === undefined ? '' : JSON.stringify(body))
      }
      if (req.headers['x-api-key'] !== apiKey) {
        return send(401, { message: 'Invalid API key', error: 'Unauthorized', statusCode: 401 })
      }
      const custom = overrideFn?.(record)
      if (custom) {
        // A slow gateway (e.g. the chat list right after pairing).
        const headers = custom[3] ?? {}
        if (custom[2]) return void setTimeout(() => send(custom[0], custom[1], headers), custom[2])
        return send(custom[0], custom[1], headers)
      }

      const p = record.path
      if (p === '/api/auth/validate') {
        return send(200, { valid: true, role: 'operator', engineType: 'whatsapp-web.js', scoped: false })
      }
      if (p === '/api/health') return send(200, { status: 'ok', version: '0.25.0' })
      if (/\/messages\/send-(text|image|video|audio|document)$/.test(p)) {
        counter += 1
        return send(201, { messageId: `true_fake_${counter}`, timestamp: 1792100000 })
      }
      if (p.endsWith('/messages/react') || p.endsWith('/chats/read') || p.endsWith('/chats/typing')) {
        return send(201, { success: true })
      }
      return send(404, { message: `no fake for ${record.method} ${p}`, statusCode: 404 })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    override: (fn) => {
      overrideFn = fn
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
