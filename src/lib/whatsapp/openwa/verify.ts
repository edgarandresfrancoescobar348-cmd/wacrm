// A QR number whose session row says "not ready": ask the gateway (at
// most every 20 s per number) and correct the row — a stale event must
// never leave the inbox saying "disconnected" while the number is
// connected (phase 5e). Never throws.

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadOpenWaRow } from './connection'
import { openWaGateway } from './gateway'
import { refreshOpenWa } from './session'

const VERIFY_EVERY_MS = 20_000
const lastVerified = new Map<string, number>()

/** Test hook. */
export function __resetVerifyThrottleForTests() {
  lastVerified.clear()
}

export async function verifyOpenWaNotReady(connectionId: string): Promise<void> {
  const now = Date.now()
  if (now - (lastVerified.get(connectionId) ?? 0) < VERIFY_EVERY_MS) return
  lastVerified.set(connectionId, now)
  try {
    const admin = supabaseAdmin()
    const row = await loadOpenWaRow(admin, connectionId)
    if (!row?.session_id || row.status === 'ready' || !openWaGateway()) return
    const live = await refreshOpenWa(admin, connectionId)
    if (live.status !== row.status) {
      console.info(`[openwa] ${connectionId.slice(0, 8)}: session row said ${row.status}, gateway says ${live.status} — corrected`)
    }
  } catch (err) {
    console.warn('[openwa] session verify failed:', err instanceof Error ? err.message : err)
  }
}
