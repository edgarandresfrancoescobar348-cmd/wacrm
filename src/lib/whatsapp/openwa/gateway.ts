// ============================================================
// The embedded OpenWA gateway — wacrm's own, one per deployment.
//
// Its URL and admin key are server config, provisioned by whatever
// started wacrm (never typed by a user):
//   - `npm run dev` / `npm run start` (scripts/wacrm.mjs) set
//     OPENWA_URL + OPENWA_API_KEY for the gateway they spawn;
//   - docker-compose.yml sets OPENWA_URL=http://openwa:2785 and
//     OPENWA_API_KEY_FILE, a key file shared with the gateway.
// Every account's session lives on this one gateway.
// ============================================================

import fs from 'node:fs'

import {
  normalizeOpenWaBaseUrl,
  openWaRequest,
  OpenWaError,
  type OpenWaCredentials,
  type OpenWaKeyInfo,
} from './client'

const PROBE_TIMEOUT_MS = 4000

function readKey(): string {
  const inline = process.env.OPENWA_API_KEY?.trim()
  if (inline) return inline
  const file = process.env.OPENWA_API_KEY_FILE?.trim()
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    // Not written yet (the gateway's init step runs first) or unreadable.
    return ''
  }
}

/** The gateway's credentials, or null when this deployment runs without it. */
export function openWaGateway(): OpenWaCredentials | null {
  const url = process.env.OPENWA_URL?.trim()
  const apiKey = readKey()
  if (!url || !apiKey) return null
  return { baseUrl: normalizeOpenWaBaseUrl(url), apiKey }
}

/** Like openWaGateway, but a missing gateway is an OpenWaError (503). */
export function requireOpenWaGateway(): OpenWaCredentials {
  const creds = openWaGateway()
  if (!creds) {
    throw new OpenWaError('The WhatsApp gateway is not running on this server', 503, 'gateway_unconfigured')
  }
  return creds
}

export type OpenWaGatewayState = 'ok' | 'unconfigured' | 'unreachable' | 'auth_failed' | 'error'

export interface OpenWaGatewayStatus {
  state: OpenWaGatewayState
  engine: string | null
}

/** Is the gateway up and does it accept our key? Never throws. */
export async function checkOpenWaGateway(): Promise<OpenWaGatewayStatus> {
  let creds: OpenWaCredentials | null
  try {
    creds = openWaGateway()
  } catch {
    return { state: 'unconfigured', engine: null }
  }
  if (!creds) return { state: 'unconfigured', engine: null }
  try {
    const info = await openWaRequest<OpenWaKeyInfo>(creds, 'POST', '/auth/validate', {
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (!info?.valid) return { state: 'auth_failed', engine: null }
    return { state: 'ok', engine: typeof info.engineType === 'string' ? info.engineType : null }
  } catch (err) {
    if (err instanceof OpenWaError) {
      if (err.status === 0) return { state: 'unreachable', engine: null }
      if (err.status === 401 || err.status === 403) return { state: 'auth_failed', engine: null }
      if (err.status >= 500) return { state: 'unreachable', engine: null }
    }
    return { state: 'error', engine: null }
  }
}

/**
 * Base URL the gateway posts webhook events to. The gateway runs next
 * to the app, so this is an internal address: OPENWA_WEBHOOK_BASE_URL
 * (set by scripts/wacrm.mjs and docker-compose.yml), else this server's
 * own port on loopback.
 */
export function openWaWebhookBaseUrl(): string {
  const configured = process.env.OPENWA_WEBHOOK_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `http://127.0.0.1:${process.env.PORT?.trim() || '3000'}`
}
