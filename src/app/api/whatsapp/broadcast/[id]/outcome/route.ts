// ============================================================
// POST /api/whatsapp/broadcast/[id]/outcome — a person's decision on
// recipients whose send outcome could not be established (status
// `unknown`: the gateway timed out or reported "outcome unknown", and
// the message can't be safely resent — see broadcast-attempts.ts).
//
// Body: { outcome: 'sent' | 'not_sent', recipient_ids?: string[] }
//   sent      — it arrived (checked in the chat): recorded as sent.
//   not_sent  — it didn't: recorded as failed, so "Retry failed" sends
//               it again with a NEW attempt and key.
// Without recipient_ids, every `unknown` recipient of the broadcast.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { finalizeBroadcastStatus } from '@/lib/whatsapp/broadcast-core'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Same gate as sending: deciding a send outcome changes what the
    // campaign will (re)send.
    const { accountId } = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      outcome?: unknown
      recipient_ids?: unknown
    } | null
    const outcome = body?.outcome
    if (outcome !== 'sent' && outcome !== 'not_sent') {
      return NextResponse.json({ error: "outcome must be 'sent' or 'not_sent'" }, { status: 400 })
    }
    let ids: string[] | null = null
    if (body?.recipient_ids !== undefined) {
      if (
        !Array.isArray(body.recipient_ids) ||
        body.recipient_ids.length === 0 ||
        !body.recipient_ids.every((v) => typeof v === 'string' && UUID.test(v))
      ) {
        return NextResponse.json({ error: 'recipient_ids must be a non-empty array of ids' }, { status: 400 })
      }
      ids = body.recipient_ids as string[]
    }
    if (!UUID.test(id)) return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })

    // Service role: the attempt functions are service-role only; the
    // function itself scopes everything to (broadcast, account).
    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('broadcast_attempt_decide', {
      p_account_id: accountId,
      p_broadcast_id: id,
      p_recipient_ids: ids,
      p_outcome: outcome,
    })
    if (error) {
      console.error('[broadcast outcome] decide failed:', error.message)
      return NextResponse.json({ error: 'Could not record the decision' }, { status: 500 })
    }
    const decided = typeof data === 'number' ? data : 0
    if (decided > 0) await finalizeBroadcastStatus(admin, id)
    return NextResponse.json({ success: true, decided })
  } catch (error) {
    console.error('Error in broadcast outcome POST:', error)
    return toErrorResponse(error)
  }
}
