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
    if (err.code === 'invalid_url' || err.code === 'url_not_allowed') {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    if (err.status === 401 || err.status === 403) {
      return NextResponse.json(
        { error: 'OpenWA rejected the API key (or its role is too low).', code: 'openwa_auth', status: err.status },
        { status: 400 },
      )
    }
    if (err.status === 0) {
      return NextResponse.json({ error: err.message, code: 'openwa_unreachable' }, { status: 502 })
    }
    if (err.code === 'not_configured' || err.code === 'no_session') {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    return NextResponse.json(
      { error: err.message, code: err.code ?? 'openwa_error', status: err.status },
      { status: err.status >= 400 && err.status < 500 ? 400 : 502 },
    )
  }
  return toErrorResponse(err)
}
