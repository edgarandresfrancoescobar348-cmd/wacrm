import { NextResponse } from 'next/server'

import { ForbiddenError, UnauthorizedError, toErrorResponse } from '@/lib/auth/account'
import { OpenWaError } from './client'

/**
 * Map an OpenWA (or auth) failure to the settings routes' `{ error, code }`
 * shape. The gateway's own message is passed through — it never contains
 * the API key — so the admin sees "Session is not started…" rather than
 * a generic 502.
 */
export function openWaErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return toErrorResponse(err)
  }
  if (err instanceof OpenWaError) {
    // The gateway is wacrm's own (./gateway.ts): not running, not
    // reachable, or not accepting the provisioned key all mean the same
    // to the admin — "the gateway is unavailable" — and are 503s.
    if (err.code === 'gateway_unconfigured' || err.code === 'invalid_url') {
      return NextResponse.json({ error: err.message, code: 'gateway_unavailable' }, { status: 503 })
    }
    if (err.status === 401 || err.status === 403) {
      return NextResponse.json(
        { error: 'The WhatsApp gateway rejected the server key.', code: 'gateway_unavailable', status: err.status },
        { status: 503 },
      )
    }
    if (err.status === 0) {
      return NextResponse.json({ error: err.message, code: 'gateway_unavailable' }, { status: 503 })
    }
    if (err.code === 'no_session') {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    return NextResponse.json(
      { error: err.message, code: err.code ?? 'openwa_error', status: err.status },
      { status: err.status >= 400 && err.status < 500 ? 400 : 502 },
    )
  }
  return toErrorResponse(err)
}
