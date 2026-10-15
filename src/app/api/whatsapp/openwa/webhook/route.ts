// ============================================================
// POST /api/whatsapp/openwa/webhook — inbound deliveries from OpenWA.
//
// Fails closed. A delivery is processed only when
//   1. its envelope names a session one of our accounts owns,
//   2. that account has a webhook secret, and
//   3. `X-OpenWA-Signature: sha256=<hex>` is the HMAC-SHA256 of the
//      raw body under that secret (constant-time compare).
// Anything else is a 401 with no detail. OpenWA delivers at least
// once, so every delivery is then de-duplicated on its idempotency key
// (`X-OpenWA-Idempotency-Key`, mirrored in the body) before any work.
//
// Processing runs in `after()` so the gateway gets its 2xx quickly
// (it times out at 10 s and retries), exactly like the Meta webhook.
// ============================================================

import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { OpenWaConnectionRow } from '@/lib/whatsapp/openwa/connection'
import {
  credsForRow,
  handleOpenWaEvent,
  verifyOpenWaSignature,
  type OpenWaEnvelope,
} from '@/lib/whatsapp/openwa/events'

export const maxDuration = 60

/** OpenWA caps a delivery body at 1 MiB; leave headroom for JSON. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Ledger rows older than this are pruned opportunistically. */
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const signature = request.headers.get('x-openwa-signature')
  if (!signature) return unauthorized()

  let envelope: OpenWaEnvelope
  try {
    envelope = JSON.parse(rawBody)
  } catch {
    return unauthorized()
  }
  if (!envelope || typeof envelope.sessionId !== 'string' || typeof envelope.event !== 'string') {
    return unauthorized()
  }

  const admin = supabaseAdmin()
  const { data: row, error } = await admin
    .from('whatsapp_openwa_config')
    .select('*')
    .eq('session_id', envelope.sessionId)
    .maybeSingle()
  if (error) {
    console.error('[openwa webhook] session lookup failed:', error.message)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  if (!row) return unauthorized()

  let secret: string | null = null
  try {
    secret = row.webhook_secret ? decrypt(row.webhook_secret) : null
  } catch {
    secret = null
  }
  if (!verifyOpenWaSignature(rawBody, signature, secret)) {
    console.warn('[openwa webhook] rejected delivery with an invalid signature')
    return unauthorized()
  }

  // The "Test" button on OpenWA's dashboard.
  if (envelope.event === 'test') {
    return NextResponse.json({ status: 'ok' })
  }

  const idempotencyKey =
    request.headers.get('x-openwa-idempotency-key') || envelope.idempotencyKey || null
  if (idempotencyKey) {
    const { error: ledgerError } = await admin.from('openwa_webhook_deliveries').insert({
      idempotency_key: idempotencyKey,
      account_id: row.account_id,
      event: envelope.event,
    })
    if (ledgerError) {
      if (ledgerError.code === '23505') {
        return NextResponse.json({ status: 'duplicate' })
      }
      console.error('[openwa webhook] ledger insert failed:', ledgerError.message)
      return NextResponse.json({ error: 'Ledger failed' }, { status: 500 })
    }
  }

  const { data: config } = await admin
    .from('whatsapp_config')
    .select('provider, mirror_inbound_media')
    .eq('account_id', row.account_id)
    .maybeSingle()

  const connection = row as OpenWaConnectionRow
  after(async () => {
    await handleOpenWaEvent(envelope, {
      admin,
      row: connection,
      creds: credsForRow(connection),
      activeProvider: config?.provider ?? 'meta',
      mirrorMedia: config?.mirror_inbound_media !== false,
    })
    if (Math.random() < 0.01) {
      await admin
        .from('openwa_webhook_deliveries')
        .delete()
        .lt('received_at', new Date(Date.now() - LEDGER_RETENTION_MS).toISOString())
    }
  })

  return NextResponse.json({ status: 'received' })
}
