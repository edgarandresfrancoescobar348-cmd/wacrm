// ============================================================
// Broadcast pacing — a minimum, slightly randomised gap between two
// broadcast sends from the same account.
//
// Meta's Cloud API rate-limits on its side, so its transport asks for
// no delay (`broadcastDelayMs: 0`) and this is a no-op there. A regular
// WhatsApp number paired by QR code (OpenWA) has no such protection:
// a burst of identical messages to people who never wrote first is the
// fastest way to get the number banned. Every broadcast path (the
// dashboard wizard's batches, the public API, resume) waits here before
// each send, so the gap holds across batches and across requests.
//
// State is per server process. A multi-instance deployment paces per
// instance — documented in the README next to the ban-risk note.
// ============================================================

const lastSendAt = new Map<string, number>()

export interface PaceOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 0..1; defaults to Math.random. */
  random?: () => number
}

/** Up to +30% jitter so the cadence doesn't look machine-regular. */
export const PACING_JITTER = 0.3

/**
 * Wait until at least `delayMs` (+ jitter) has passed since the last
 * paced send for `key`, then record this send. Resolves immediately
 * when `delayMs <= 0`.
 */
export async function paceBroadcastSend(
  key: string,
  delayMs: number,
  opts: PaceOptions = {},
): Promise<void> {
  if (!(delayMs > 0)) return
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = opts.random ?? Math.random

  const gap = Math.round(delayMs * (1 + PACING_JITTER * random()))
  const last = lastSendAt.get(key)
  // Reserve the slot before sleeping so two concurrent callers for the
  // same account queue up instead of both waking at the same instant.
  const startAt = last === undefined ? now() : Math.max(now(), last + gap)
  lastSendAt.set(key, startAt)
  const wait = startAt - now()
  if (wait > 0) await sleep(wait)
}

/** Test hook. */
export function resetBroadcastPacing(): void {
  lastSendAt.clear()
}
